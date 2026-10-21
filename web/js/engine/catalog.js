/** Catalog access for the engine. Works in the browser (fetch) and in Node tests (plain objects). */

/** Line rules beat the manufacturer's, which beat global ones, when no direction decides. */
const SCOPE_RANK = { line: 3, manufacturer: 2, global: 1 };

export function makeCatalog(index, lineData) {
  const line = lineData.line;
  const defs = new Map((index.rule_defs || []).map(d => [d.key, d]));
  const scopeRank = r => r.scope === line.code ? SCOPE_RANK.line
    : r.scope === line.manufacturer ? SCOPE_RANK.manufacturer : r.scope === 'GLOBAL' ? SCOPE_RANK.global : 0;
  const byKey = new Map();
  for (const r of [...(index.rules || []), ...(lineData.rules || [])]) {
    if (!scopeRank(r)) continue;
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  const rules = new Map([...byKey].map(([key, rows]) => [key, strictest(rows, defs.get(key), scopeRank)]));
  const byCategory = new Map();
  for (const p of lineData.parts) {
    if (p.active === false) continue;
    if (!byCategory.has(p.category)) byCategory.set(p.category, []);
    byCategory.get(p.category).push(p);
  }
  return {
    line,
    manufacturer: lineData.manufacturer
      || (index.manufacturers || []).find(m => m.code === line.manufacturer)
      || { code: line.manufacturer, name: line.manufacturer },
    sizes: lineData.sizes,
    lookups: lineData.lookups || {},
    categories: new Map((index.categories || []).map(c => [c.code, c])),
    /** The rule that applies to this line; throws so a missing rule is a loud bug, never a silent default. */
    rule(key) {
      const r = rules.get(key);
      if (!r) throw new Error(`Catalog is missing rule '${key}'`);
      return r;
    },
    /** Active parts in a category, optionally only those that fit a size. */
    parts(category, size) {
      const list = byCategory.get(category) || [];
      return size == null ? list : list.filter(p => p.sizes.includes(String(size)));
    },
  };
}

/**
 * Several sources can set the same rule (the manufacturer, NFPA 211, a customer). For a limit the
 * strictest value wins: the highest minimum, the lowest maximum. Otherwise the most specific scope wins.
 */
export function strictest(rows, def, scopeRank) {
  const sign = def?.direction === 'MIN' ? 1 : def?.direction === 'MAX' ? -1 : 0;
  const score = r => [sign * (r.value ?? 0), sign * (r.value_max ?? r.value ?? 0), scopeRank(r)];
  return rows.reduce((best, r) => {
    const a = score(r), b = score(best);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? r : best;
    return best;
  });
}

export const attr = (part, key) => part.attributes?.[key];

export async function loadCatalog(base = 'catalog', lineCode = 'DT') {
  const index = await (await fetch(`${base}/index.json`)).json();
  const file = index.line_files?.[lineCode];
  if (!file) throw new Error(`Product line '${lineCode}' is not in the catalog build`);
  const line = await (await fetch(`${base}/${file}`)).json();
  return makeCatalog(index, line);
}
