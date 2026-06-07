/*
 Deterministic field BACKFILL from Textract geometry.

 The vision model counts boxes well but, on dense columns, sometimes leaves order_number /
 time / total empty even though Textract clearly read them. Since Textract gives us each
 line's vertical position, we split a column into N vertical bands (N = boxes the model found
 in that column, top-to-bottom) and, for any label missing one of these fields, fill it from
 the OCR token that falls in that label's band.

 This NEVER overrides a value the model already produced and NEVER changes the box count —
 it only fills blanks using OCR we already fetched (no extra model calls).
*/

const RE_ORDER = /\bTO[-\s.]?[A-Z]{0,3}[-\s.]?\d{1,2}[-\s.]?\d{3,6}\b/i;
const RE_ORDER_LOOSE = /\bTO[-\s.][A-Z0-9-]{4,}/i;
const RE_TIME = /\b([01]?\d|2[0-3])\s*[:.]\s*[0-5]\d(?:\s*[:.]\s*[0-5]\d)?\b/;
const RE_TOTAL_KW = /\b(TOTAL|QTT|QTY|T0TAL)\b/i;
const RE_INT = /\b\d{1,4}\b/;

function cleanTime(s) {
  const m = s.match(RE_TIME);
  if (!m) return null;
  const parts = m[0].replace(/\s/g, "").split(/[:.]/);
  const [h, mi, se] = parts;
  return se != null ? `${h.padStart(2, "0")}:${mi}:${se}` : `${h.padStart(2, "0")}:${mi}`;
}

function cleanOrder(s) {
  const m = s.match(RE_ORDER) || s.match(RE_ORDER_LOOSE);
  if (!m) return null;
  return m[0].toUpperCase().replace(/\s+/g, "").replace(/^TO[.\s]/, "TO-");
}

/**
 * @param labelsInCol  array of label objects (top-to-bottom) for ONE column
 * @param geomLines    array of { text, top, left, width, height } for that column (0..1 coords)
 */
export function backfillColumn(labelsInCol, geomLines) {
  const n = labelsInCol.length;
  if (!n || !geomLines || !geomLines.length) return;

  const sorted = geomLines.slice().sort((a, b) => a.top - b.top);

  // collect typed tokens (each with its Y), top-to-bottom
  const orders = [], times = [], totals = [];
  for (let i = 0; i < sorted.length; i++) {
    const ln = sorted[i];
    const ord = cleanOrder(ln.text);
    if (ord) orders.push({ top: ln.top, val: ord });
    const tm = cleanTime(ln.text);
    if (tm) times.push({ top: ln.top, val: tm });
    if (RE_TOTAL_KW.test(ln.text)) {
      let num = (ln.text.replace(RE_TOTAL_KW, "").match(RE_INT) || [])[0];
      if (!num && sorted[i + 1]) num = (sorted[i + 1].text.match(RE_INT) || [])[0];
      if (num) totals.push({ top: ln.top, val: num });
    }
  }

  // Merge tokens that sit on essentially the same row (within ~1/(2n) of height): OCR often
  // splits one label's value across lines, which would otherwise look like extra rows.
  const dedup = (arr) => {
    const out = [];
    const gap = 0.5 / n;
    for (const t of arr) {
      if (out.length && Math.abs(t.top - out[out.length - 1].top) < gap) continue;
      out.push(t);
    }
    return out;
  };

  // Assign tokens to labels. If the number of (deduped) tokens equals the box count, the
  // k-th token belongs to the k-th label (each label carries exactly one) — the most reliable
  // mapping. Otherwise fall back to band-by-Y so we still fill what we can.
  const assign = (arr, key) => {
    const toks = dedup(arr);
    if (!toks.length) return;
    if (toks.length === n) {
      for (let k = 0; k < n; k++) {
        const lbl = labelsInCol[k];
        if (lbl?.fields && !String(lbl.fields[key] ?? "").trim()) lbl.fields[key] = toks[k].val;
      }
      return;
    }
    for (const t of toks) {
      const band = Math.min(n - 1, Math.max(0, Math.floor(t.top * n)));
      const lbl = labelsInCol[band];
      if (lbl?.fields && !String(lbl.fields[key] ?? "").trim()) lbl.fields[key] = t.val;
    }
  };
  assign(orders, "order_number");
  assign(times, "time");
  assign(totals, "total");
}

// Product-code token: F11.000 / F10-008 / T14.057 / F29 / 001 ... and size/grade hints.
const RE_PCODE = /\b([FT]\d{1,2}[.\-]?\d{0,3})\b/;
const RE_SIZE = /\b(\d{2,3}\s*cm)\b/i;
const RE_GRADE = /\b(\d?F[+\-]|Grade\s*[A-Z0-9]+|[24]F[+\-])\b/i;
const RE_TYPE = /\b(MI|BU|MO)\b/;

/**
 * For boxes that still have an EMPTY products array, build minimal product rows from the
 * product-code tokens that fall within that box's vertical band of the column's OCR. This
 * guarantees a genuine product label is not left blank. Deterministic, no model call.
 * Only fills boxes whose products are missing/empty — never overrides extracted products.
 *
 * @param labelsInCol labels (top-to-bottom) for ONE column, each { fields }
 * @param geomLines   column OCR geometry { text, top, ... }
 */
export function backfillProducts(labelsInCol, geomLines) {
  const n = labelsInCol.length;
  if (!n || !geomLines || !geomLines.length) return;

  const sorted = geomLines.slice().sort((a, b) => a.top - b.top);

  // Anchor each box by the Y of its order_number ("TO-...") line — that line sits at the TOP
  // of every label. Box k then spans [anchor[k], anchor[k+1]); product codes in that range
  // belong to box k. This is far more accurate than even Y-bands (labels are not equal height).
  const anchors = [];
  for (const ln of sorted) if (cleanOrder(ln.text)) anchors.push(ln.top);
  // dedup anchors on the same row
  const gap = 0.5 / n;
  const anch = [];
  for (const a of anchors) if (!anch.length || a - anch[anch.length - 1] > gap) anch.push(a);

  const boxOf = (top) => {
    if (anch.length === n) {
      // last anchor's box extends to bottom
      for (let k = n - 1; k >= 0; k--) if (top >= anch[k] - gap) return k;
      return 0;
    }
    return Math.min(n - 1, Math.max(0, Math.floor(top * n)));   // fallback: even bands
  };

  const perBox = Array.from({ length: n }, () => []);
  for (const ln of sorted) {
    const code = (ln.text.match(RE_PCODE) || [])[1];
    if (!code) continue;
    const row = { code: code.toUpperCase().replace(/\s+/g, "") };
    const sz = (ln.text.match(RE_SIZE) || [])[1]; if (sz) row.size = sz.replace(/\s+/g, "");
    const gr = (ln.text.match(RE_GRADE) || [])[1]; if (gr) row.grade = gr.toUpperCase().replace(/\s+/g, "");
    const ty = (ln.text.match(RE_TYPE) || [])[1]; if (ty) row.type = ty.toUpperCase();
    // product name = the leading words before the code/size/grade tokens (e.g. "Roselily Aisha")
    const name = ln.text.split(RE_PCODE)[0].replace(/[._-]+$/, "").trim();
    if (name && /[A-Za-z]/.test(name) && name.length >= 3) row.name = name;
    perBox[boxOf(ln.top)].push(row);
  }

  for (let k = 0; k < n; k++) {
    const lbl = labelsInCol[k];
    if (!lbl?.fields) continue;
    const cur = lbl.fields.products;
    if (Array.isArray(cur) && cur.length > 0) continue;   // never override extracted products
    if (perBox[k].length) lbl.fields.products = perBox[k];
  }
}

// Parse product rows from the OCR lines of ONE isolated label crop (no neighbour bleed).
// Each line with a product code becomes a row { name?, code, grade?, type?, size?, qty? }.
export function parseProductsFromLines(lines) {
  const rows = [];
  for (const t of lines) {
    const code = (t.match(RE_PCODE) || [])[1];
    const hasName = /[A-Za-z]{3,}/.test(t.replace(RE_PCODE, ""));
    if (!code && !hasName) continue;
    // skip header/footer lines that are not products
    if (/\b(TOTAL|QTT|QTY|TO[-\s.]|VC\d|D\d{5})\b/i.test(t) && !code) continue;
    // skip the label header rows: shop/branch names and address fragments (no product code)
    if (!code && /\b(RETAIL|DAD|ARE|DC|HA NOI|TRUNG HOA|XA DAN|LAC LONG|THANH CONG|LONG BIEN|RETAI|HN\s*-)\b/i.test(t)) continue;
    if (!code && /^[.\s]*[A-Z][A-Z .\-]{4,}$/.test(t) && !/\d/.test(t)) continue;  // ALL-CAPS header line
    const row = {};
    const name = t.split(RE_PCODE)[0].replace(/[._\-]+$/, "").trim();
    if (name && /[A-Za-z]/.test(name) && name.length >= 3) row.name = name;
    if (code) row.code = code.toUpperCase().replace(/\s+/g, "");
    const sz = (t.match(RE_SIZE) || [])[1]; if (sz) row.size = sz.replace(/\s+/g, "");
    const gr = (t.match(RE_GRADE) || [])[1]; if (gr) row.grade = gr.toUpperCase().replace(/\s+/g, "");
    const ty = (t.match(RE_TYPE) || [])[1]; if (ty) row.type = ty.toUpperCase();
    const qm = t.match(/\b(\d{1,4})\s*$/); if (qm) row.qty = qm[1];
    if (row.name || row.code) rows.push(row);
  }
  return rows;
}

// Compute label anchor Y positions (normalized) for a column from order-number OCR lines.
export function labelAnchors(geomLines, n) {
  const sorted = (geomLines || []).slice().sort((a, b) => a.top - b.top);
  const gap = 0.5 / Math.max(1, n);
  const anch = [];
  for (const ln of sorted) {
    if (!cleanOrder(ln.text)) continue;
    if (!anch.length || ln.top - anch[anch.length - 1] > gap) anch.push(ln.top);
  }
  return anch;
}
