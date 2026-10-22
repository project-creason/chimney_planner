/**
 * Price sheet import: matches the rows of whatever sheet a distributor sends to the catalog's parts.
 * The page (web/admin.html) reads the file and picks the columns; this decides what each row is, so the
 * preview and the import always agree. Pure, so it is tested without a database.
 *
 *   matchSheet(rows, catalog, { stripPrefix })
 *     rows    [{ n, part, sku, price, description }]   n = the row number in the sheet, as Excel shows it
 *     catalog [{ line, order_number, stock_number }]
 *
 * A row matches a part by its manufacturer order number, else its stock number, first exactly and then
 * ignoring case, spaces and punctuation ("6dt 48" is 6DT-48), then after a "Vendor:" style prefix as accounting
 * systems such as QuickBooks write them ("DuraVent:6DT-48"). Rows that match nothing are usually other
 * products the distributor sells; they are listed, never guessed at.
 */
const norm = v => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** "$1,234.50", "1234.5 USD", 1234.5 -> 1234.5, to the cent; null for "call", "N/A", blank or a negative. */
export function parsePrice(v) {
  const cents = x => Math.round(x * 100) / 100;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? cents(v) : null;
  const t = String(v ?? '').trim().replace(/^[A-Z]{3}\s*/i, '').replace(/\s*[A-Z]{3}$/i, '').replace(/[$€£,\s]/g, '');
  return /^\d+(\.\d+)?$/.test(t) ? cents(Number(t)) : null;
}

function indexCatalog(catalog) {
  const exact = new Map(), loose = new Map();
  const add = (map, k, p) => { if (k) map.set(k, [...(map.get(k) || []).filter(x => x !== p), p]); };
  for (const p of catalog) {
    for (const [via, v] of [['order', p.order_number], ['stock', p.stock_number]]) {
      if (v == null || v === '') continue;
      add(exact, `${via}|${String(v).trim()}`, p);
      add(loose, `${via}|${norm(v)}`, p);
    }
  }
  const find = code => {
    const t = String(code ?? '').trim(), n = norm(code);
    if (!n) return { parts: [] };
    for (const via of ['order', 'stock']) {
      const hit = exact.get(`${via}|${t}`);
      if (hit) return { parts: hit, via };
    }
    for (const via of ['order', 'stock']) {
      const hit = loose.get(`${via}|${n}`);
      if (hit) return { parts: hit, via, loose: true };
    }
    const after = /[:|]\s*([^:|]+)$/.exec(t)?.[1];
    if (after) {
      const hit = find(after);
      if (hit.parts.length) return { ...hit, loose: hit.loose || after.trim() !== t };
    }
    return { parts: [] };
  };
  return find;
}

export function matchSheet(rows, catalog, { stripPrefix = '' } = {}) {
  const find = indexCatalog(catalog);
  const prefix = norm(stripPrefix);
  const matched = [], unmatched = [], duplicates = [], noPrice = [];
  const seen = new Map();
  for (const r of rows) {
    let code = String(r.part ?? '').trim();
    if (!code) continue;
    if (prefix && norm(code).startsWith(prefix)) {
      // drop the prefix and any separator after it: "DUR-6DT-48" -> "6DT-48"
      let i = 0, k = 0;
      while (k < prefix.length && i < code.length) { if (norm(code[i])) k++; i++; }
      code = code.slice(i).replace(/^[^A-Za-z0-9]+/, '');
    }
    const hit = find(code);
    if (!hit.parts.length) { unmatched.push({ n: r.n, part: r.part, reason: 'not in the catalog' }); continue; }
    if (hit.parts.length > 1) {
      unmatched.push({ n: r.n, part: r.part, reason: `matches ${hit.parts.map(p => `${p.line} ${p.order_number}`).join(' and ')}` });
      continue;
    }
    const p = hit.parts[0], key = `${p.line}|${p.order_number}`;
    if (seen.has(key)) { duplicates.push({ n: r.n, order_number: p.order_number, first: seen.get(key) }); continue; }
    seen.set(key, r.n);
    const price = r.price === undefined ? undefined : parsePrice(r.price);
    if (price === null) noPrice.push({ n: r.n, order_number: p.order_number, value: String(r.price ?? '') });
    matched.push({ n: r.n, line: p.line, order_number: p.order_number, sku: String(r.sku ?? '').trim() || null,
      price: price ?? null, description: String(r.description ?? '').trim() || null,
      via: hit.via, loose: !!hit.loose });
  }
  const priced = new Set(matched.filter(m => m.price != null).map(m => `${m.line}|${m.order_number}`));
  return {
    matched, unmatched, duplicates, noPrice,
    catalogWithoutPrice: catalog.filter(p => !priced.has(`${p.line}|${p.order_number}`)).map(p => ({ line: p.line, order_number: p.order_number })),
    suggestion: prefix ? null : suggestPrefix(unmatched, find),
  };
}

/**
 * When many rows only miss because of a distributor's letter prefix (DUR6DT48), name the prefix to strip.
 * Letters only, so a longer part number is never cut down to a catalog one (16DT-WS is not 6DT-WS).
 */
function suggestPrefix(unmatched, find) {
  const counts = new Map();
  for (const u of unmatched) {
    const n = norm(String(u.part).split(/[:|]/).pop());
    const letters = /^[A-Z]+/.exec(n)?.[0].length || 0;
    for (let len = 2; len <= Math.min(letters, 8) && len < n.length - 1; len++) {
      if (find(n.slice(len)).parts.length === 1) { counts.set(n.slice(0, len), (counts.get(n.slice(0, len)) || 0) + 1); break; }
    }
  }
  const [best] = [...counts].sort((a, b) => b[1] - a[1]);
  return best && best[1] >= 3 ? { prefix: best[0], rows: best[1] } : null;
}
