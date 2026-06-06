/*
 Cross-label CONSISTENCY reconciliation (no model calls).

 Within ONE image (a single delivery batch) the labels follow strong patterns:
   - the same shop/branch always carries the same order_number
     (e.g. HN-RETAIL -> TO-DL-26-074117, HN TRUNG HOA -> TO-DL-26-074118),
   - a shop usually maps to one main box_code / line_code.
 So when one label reads a field clearly and a sibling with the same shop is blurry, we can
 fill the blank from the batch CONSENSUS. This is exactly the pattern reasoning a human uses.

 Rules: only FILL blanks, never override a value the model/OCR already produced; only use a
 consensus that is unambiguous (one clear majority). Counts are never touched.
*/

function norm(s) {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")   // collapse punctuation/spacing: ".HN - XA DAN" ~ "HN XA DAN"
    .trim();
}

// most common non-empty value for `key`, grouped by normalized `groupKey`
function consensusMap(labels, groupKey, key) {
  const groups = new Map();   // groupVal -> Map(value -> count)
  for (const l of labels) {
    const f = l.fields || {};
    const g = norm(f[groupKey]);
    const v = String(f[key] ?? "").trim();
    if (!g || !v) continue;
    if (!groups.has(g)) groups.set(g, new Map());
    const m = groups.get(g);
    m.set(v, (m.get(v) || 0) + 1);
  }
  const out = new Map();
  for (const [g, m] of groups) {
    let best = null, bestC = 0, second = 0;
    for (const [v, c] of m) {
      if (c > bestC) { second = bestC; best = v; bestC = c; }
      else if (c > second) { second = c; }
    }
    // accept consensus only when there is a clear winner (not a 1-1 tie between two values)
    if (best && (bestC > second)) out.set(g, best);
  }
  return out;
}

export function reconcileFields(labels) {
  if (!labels || labels.length < 2) return { filled: 0 };
  let filled = 0;

  // shop_name -> order_number, and the reverse order_number -> shop_name
  const shopToOrder = consensusMap(labels, "shop_name", "order_number");
  const orderToShop = consensusMap(labels, "order_number", "shop_name");
  // shop_name -> box_code (carton type is stable per shop within a batch)
  const shopToBox = consensusMap(labels, "shop_name", "box_code");

  // Detect the batch's line_code suffix pattern: line_code is usually box_code + a suffix
  // (e.g. "VC9" -> "VC9-B"). Learn the dominant suffix from labels that have BOTH, then we can
  // fill a blank line_code from its box_code. Only applied if a clear suffix exists.
  let suffix = null;
  {
    const sfx = new Map();
    for (const l of labels) {
      const bc = String(l.fields?.box_code ?? "").trim().toUpperCase().replace(/\s+/g, "");
      const lc = String(l.fields?.line_code ?? "").trim().toUpperCase().replace(/\s+/g, "");
      if (bc && lc && lc.startsWith(bc)) {
        const s = lc.slice(bc.length);            // e.g. "-B"
        sfx.set(s, (sfx.get(s) || 0) + 1);
      }
    }
    let bestC = 0, second = 0;
    for (const [s, c] of sfx) { if (c > bestC) { second = bestC; suffix = s; bestC = c; } else if (c > second) second = c; }
    if (!(bestC >= 3 && bestC > second)) suffix = null;   // need a clear, repeated pattern
  }

  for (const l of labels) {
    const f = l.fields || (l.fields = {});
    const shop = norm(f.shop_name);
    const order = String(f.order_number ?? "").trim();

    if (!order && shop && shopToOrder.has(shop)) {
      f.order_number = shopToOrder.get(shop); filled++;
    }
    if (!String(f.shop_name ?? "").trim() && order && orderToShop.has(order)) {
      // store the canonical shop spelling from a sibling label
      const canon = labels.find(x => String(x.fields?.order_number ?? "").trim() === order
        && String(x.fields?.shop_name ?? "").trim());
      if (canon) { f.shop_name = canon.fields.shop_name; filled++; }
    }
    if (!String(f.box_code ?? "").trim() && shop && shopToBox.has(shop)) {
      f.box_code = shopToBox.get(shop); filled++;
    }
    // fill blank line_code from box_code using the learned batch suffix
    if (suffix != null && !String(f.line_code ?? "").trim()) {
      const bc = String(f.box_code ?? "").trim();
      if (bc) { f.line_code = bc + suffix; filled++; }
    }
  }
  return { filled };
}
