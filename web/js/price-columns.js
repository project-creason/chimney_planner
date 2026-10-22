/**
 * Guesses the layout of a price sheet someone else made: which row holds the headers, and which columns hold
 * the manufacturer's part number, the distributor's own SKU, the price and the description.
 * Guesses only: the import page shows each one in a dropdown to correct. Pure, so it is tested in Node.
 *
 *   findHeaderRow(rows)                         index of the header row in the first rows of the sheet
 *   guessColumns(headers, body, catalogCodes)   { part, sku, price, description }: column indexes or null
 */
export const FIELDS = ['part', 'sku', 'price', 'description'];

const norm = v => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
/** Money-looking: "$1,234.50", "74.19", "12"; not a long code such as a 12-digit UPC. */
const isPrice = v => {
  const t = String(v ?? '').trim();
  return /^\(?[A-Z]{0,3}\s*[$€£]?\s*\d[\d,]*(\.\d+)?\s*[A-Z]{0,3}\)?$/i.test(t) && t.replace(/\.\d*$/, '').replace(/\D/g, '').length <= 7;
};
const filled = v => String(v ?? '').trim() !== '';

/** Words in headers, by field, with how strongly each one points there. */
const HEADER_WORDS = {
  part: [[/\b(mfr|mfg|manufacturer|vendor|oem)\b/i, 3], [/\b(order|catalog|model)\s*(no|num|number|#)?\b/i, 2], [/\bpart\b/i, 1]],
  sku: [[/\bsku\b/i, 3], [/\b(item|product|our|internal|stock)\s*(no|num|number|#|code|id)?\b/i, 2], [/\b(code|id)\b/i, 1]],
  // plans show what the shopper pays, so a selling price beats a dealer cost when a sheet has both
  price: [[/\b(sales|sell|selling|msrp|retail|list)\b/i, 3], [/\bprice\b/i, 2], [/\b(map|unit|your)\b/i, 2], [/\b(net|dealer|cost|wholesale|purchase)\b/i, 1]],
  description: [[/\b(desc|description)\b/i, 3], [/\b(name|title|product)\b/i, 1]],
};
const headerScore = (field, h) => Math.max(0, ...HEADER_WORDS[field].map(([re, w]) => (re.test(String(h ?? '')) ? w : 0)));

/** The header row is the early row that reads most like headers: several filled text cells, header words. */
export function findHeaderRow(rows, scan = 15) {
  let best = 0, bestScore = -1;
  rows.slice(0, scan).forEach((row, i) => {
    const cells = row.filter(filled);
    if (cells.length < 2) return;
    const words = cells.reduce((t, c) => t + Math.max(...FIELDS.map(f => headerScore(f, c))), 0);
    const text = cells.filter(c => !isPrice(c)).length;
    const score = words * 3 + text - (cells.length - text) * 2;
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}

/**
 * catalogCodes: the catalog's order and stock numbers. The part column is the one whose values match them
 * most (allowing a distributor prefix such as DUR); the others go by their header words and their contents.
 */
export function guessColumns(headers, body, catalogCodes) {
  const width = body.slice(0, 200).reduce((w, r) => Math.max(w, r.length), headers.length);
  const codes = new Set([...catalogCodes].map(norm).filter(Boolean));
  const sample = body.slice(0, 300);
  const col = i => sample.map(r => r[i]).filter(filled);
  // part numbers are looked for in every row: a sheet sorted A-Z may reach this manufacturer's parts late
  const whole = i => body.map(r => r[i]).filter(filled);
  const out = { part: null, sku: null, price: null, description: null };

  let bestHits = 0;
  for (let i = 0; i < width; i++) {
    const hits = whole(i).filter(v => {
      const n = norm(String(v).split(/[:|]/).pop());
      return codes.has(n) || [2, 3, 4, 5, 6, 7, 8].some(k => codes.has(norm(v).slice(k)));
    }).length;
    if (hits > bestHits || (hits === bestHits && hits > 0 && headerScore('part', headers[i]) > headerScore('part', headers[out.part]))) {
      bestHits = hits; out.part = i;
    }
  }
  if (out.part === null) out.part = pick(width, i => headerScore('part', headers[i]), new Set());

  const used = new Set([out.part]);
  const priceLike = i => { const c = col(i); return c.length > 0 && c.filter(isPrice).length / c.length >= 0.6; };
  out.price = pick(width, i => (priceLike(i) ? 1 + headerScore('price', headers[i]) : 0), used);
  if (out.price !== null) used.add(out.price);
  out.sku = pick(width, i => (!priceLike(i) && col(i).length ? headerScore('sku', headers[i]) : 0), used);
  if (out.sku !== null) used.add(out.sku);
  const avgLen = i => { const c = col(i); return c.length ? c.reduce((t, v) => t + String(v).length, 0) / c.length : 0; };
  out.description = pick(width, i => (priceLike(i) ? 0 : headerScore('description', headers[i]) * 100 + (avgLen(i) > 15 ? avgLen(i) : 0)), used);
  return out;
}

/** The column with the highest positive score that isn't taken; ties go to the leftmost. */
function pick(width, score, used) {
  let best = null, bestScore = 0;
  for (let i = 0; i < width; i++) {
    if (used.has(i)) continue;
    const s = score(i);
    if (s > bestScore) { best = i; bestScore = s; }
  }
  return best;
}
