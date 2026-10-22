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
    // a part can also do another category's job (one wall support both carries the tee and braces the run)
    for (const c of [p.category, ...(p.attributes?.also_categories || [])]) {
      if (!byCategory.has(c)) byCategory.set(c, []);
      byCategory.get(c).push(p);
    }
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
    /** A requirement applies unless the line's rule sets it to 0 (not required for this line). */
    requires(key) {
      return this.rule(key).value !== 0;
    },
    /** Rows of a lookup table (elbow offsets, support projection...) that apply to a size; rows without a size apply to all. */
    lookup(name, size) {
      return (lineData.lookups?.[name] || []).filter(r => r.size == null || String(r.size) === String(size));
    },
    /** Categories the line has active parts in. */
    categoryCodes() {
      return [...byCategory.keys()];
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
  // a limit left blank means "this source states no figure": any source that states one wins
  if (def?.kind === 'LIMIT' && rows.some(r => r.value != null)) rows = rows.filter(r => r.value != null);
  const score = r => [sign * (r.value ?? 0), sign * (r.value_max ?? r.value ?? 0), scopeRank(r)];
  return rows.reduce((best, r) => {
    const a = score(r), b = score(best);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? r : best;
    return best;
  });
}

export const attr = (part, key) => part?.attributes?.[key];

export async function loadCatalog(base = 'catalog', lineCode = 'DT') {
  const index = await (await fetch(`${base}/index.json`)).json();
  const file = index.line_files?.[lineCode];
  if (!file) throw new Error(`Product line '${lineCode}' is not in the catalog build`);
  const line = await (await fetch(`${base}/${file}`)).json();
  return makeCatalog(index, line);
}

/**
 * What a product line offers, for the form: which part categories it has, its pipe finishes, cap styles,
 * the connector lines its support box table names, and the few rule values the form's hints quote.
 * Worked out from the catalog, so the page never hard-codes one manufacturer's choices.
 */
export function lineOptions(cat, index = {}) {
  const source = (index.sources || []).find(s => s.source_code === cat.line.default_source);
  const chaseCovers = cat.parts('CHASE_TOP_FLASHING').map(p => p.dimensions?.B?.value_in).filter(v => v != null);
  return {
    categories: cat.categoryCodes(),
    // finishes a whole chimney can be built in (painted interior-only sections aside), stainless first
    finishes: [...new Set(cat.parts('CHIMNEY_PIPE').filter(p => !attr(p, 'interior_only')).map(p => p.finish).filter(Boolean))]
      .sort((a, b) => (b === 'SS') - (a === 'SS')),
    capStyles: [...new Set(cat.parts('CAP').map(p => attr(p, 'cap_style') || 'STANDARD'))],
    connectors: [...new Set((cat.lookups.support_box_pitch || []).map(r => r.connector_line).filter(c => c !== 'ANY'))],
    maxOffsets: cat.rule('offset.max_count').value,
    draftGuideline: cat.rule('draft.min_vertical_ft').value != null,
    jointOverlapIn: cat.line.joint_overlap_in,
    chaseAboveMinIn: cat.rule('chase.min_cap_clearance_in').value,
    chaseFlashingCoversIn: chaseCovers.length ? [Math.min(...chaseCovers), Math.max(...chaseCovers)] : null,
    source: source ? { document_code: source.document_code, published: source.published, title: source.title } : null,
  };
}
