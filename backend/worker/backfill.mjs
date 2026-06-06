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

  // band edges in normalized Y; band b = [b/n, (b+1)/n)
  const bandOf = (top) => Math.min(n - 1, Math.max(0, Math.floor(top * n)));

  // collect typed tokens with their band
  const orders = [], times = [], totals = [];
  const sorted = geomLines.slice().sort((a, b) => a.top - b.top);
  for (let i = 0; i < sorted.length; i++) {
    const ln = sorted[i];
    const band = bandOf(ln.top);
    const ord = cleanOrder(ln.text);
    if (ord) orders.push({ band, val: ord });
    const tm = cleanTime(ln.text);
    if (tm) times.push({ band, val: tm });
    if (RE_TOTAL_KW.test(ln.text)) {
      // number is usually on the same line after the keyword, or the next line
      let num = (ln.text.replace(RE_TOTAL_KW, "").match(RE_INT) || [])[0];
      if (!num && sorted[i + 1]) num = (sorted[i + 1].text.match(RE_INT) || [])[0];
      if (num) totals.push({ band, val: num });
    }
  }

  const fillByBand = (arr, key) => {
    for (const { band, val } of arr) {
      const lbl = labelsInCol[band];
      if (lbl && lbl.fields && !String(lbl.fields[key] ?? "").trim()) {
        lbl.fields[key] = val;
      }
    }
  };
  fillByBand(orders, "order_number");
  fillByBand(times, "time");
  fillByBand(totals, "total");
}
