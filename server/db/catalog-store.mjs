/**
 * Moves a validated catalog build between the database and the shape the engine reads.
 *
 *   writeCatalog(db, build)  build = { index, lines: { DT: lineData, ... } } as tools/build_catalog.py writes it
 *   readCatalog(db)          the same shape back, so makeCatalog() works unchanged
 *
 * Validation stays in build_catalog.py: an import always goes CSV -> build (checks) -> database,
 * and a failed build writes nothing.
 */

/** Columns of parts.csv that live in parts; every other column is a part spec. */
const CORE = ['order_number', 'stock_number', 'category', 'description', 'finish', 'carton_filler', 'optional',
  'active', 'source_page', 'note'];
/** parts.csv columns kept as specs with placement 'part', in CSV order. */
export const PART_FIELD_SPECS = [
  ['nominal_length_in', 'number', 'in'], ['adjustable_min_in', 'number', 'in'], ['adjustable_max_in', 'number', 'in'],
  ['elbow_angle_deg', 'number', 'deg'], ['pitch_min', 'number', 'pitch'], ['pitch_max', 'number', 'pitch'],
  ['pitch_applies_to', 'enum', null, ['roof', 'ceiling']], ['height_in', 'number', 'in'],
  ['max_supported_ft', 'number', 'ft'], ['max_supported_with_straps_ft', 'number', 'ft'],
  ['wall_min_in', 'number', 'in'], ['wall_max_in', 'number', 'in'], ['wall_max_extended_in', 'number', 'in'],
  ['standoff_min_in', 'number', 'in'], ['standoff_max_in', 'number', 'in'],
];
const ADJUSTABILITY = 'adjustability';
/** Categories whose installed length is computed from the line's joint overlap. */
const PIPE_CATEGORIES = new Set(['CHIMNEY_PIPE']);

const CATALOG_TABLES = ['lookup_rows', 'lookup_tables', 'part_dimensions', 'part_specs', 'part_sizes', 'parts',
  'line_compatibility', 'rules', 'rule_defs', 'spec_defs', 'sizes', 'categories', 'product_lines', 'sources', 'manufacturers'];

const json = v => JSON.stringify(v ?? null);
const bool = v => (v ? 1 : 0);
const stmt = (sql, args) => ({ sql, args: args.map(a => (a === undefined ? null : a)) });

/** Replaces the whole catalog and rules in one transaction. Customer tables are left alone. */
export async function writeCatalog(db, build, source = 'catalog') {
  const { index, lines } = build;
  const s = [];
  for (const t of CATALOG_TABLES) s.push(stmt(`DELETE FROM ${t}`, []));

  index.manufacturers.forEach((m, i) => s.push(stmt(
    'INSERT INTO manufacturers (code, name, website, logo_file, sort) VALUES (?, ?, ?, ?, ?)',
    [m.code, m.name, m.website, m.logo_file, i])));
  index.sources.forEach((x, i) => s.push(stmt(
    'INSERT INTO sources (code, manufacturer, document_code, title, published, sort) VALUES (?, ?, ?, ?, ?, ?)',
    [x.source_code, x.manufacturer, x.document_code, x.title, x.published, i])));
  index.product_lines.forEach((l, i) => s.push(stmt(
    `INSERT INTO product_lines (code, manufacturer, name, family, status, fuels, listing, listing_file,
       clearance_to_combustibles_in, joint_overlap_in, wall_thickness_in, continuous_flue_temp_f, default_source, notes, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [l.code, l.manufacturer, l.name, l.family, l.status, json(l.fuels || []), l.listing, l.listing_file,
      l.clearance_to_combustibles_in, l.joint_overlap_in, l.wall_thickness_in, l.continuous_flue_temp_f,
      l.default_source, l.notes, i])));
  index.categories.forEach((c, i) => s.push(stmt(
    'INSERT INTO categories (code, name, system_zone, description, sort) VALUES (?, ?, ?, ?, ?)',
    [c.code, c.name, c.system_zone, c.description, i])));

  let sort = 0;
  const specDef = (key, type, unit, allowed, cats, desc, placement) => s.push(stmt(
    'INSERT INTO spec_defs (key, type, allowed_values, unit, categories, description, placement, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [key, type, json(allowed || []), unit, json(cats || []), desc, placement, sort++]));
  for (const [key, type, unit, allowed] of PART_FIELD_SPECS) specDef(key, type, unit, allowed, [], null, 'part');
  specDef(ADJUSTABILITY, 'range', 'in', [], [], 'Per-size min/max for universal straps and supports', 'adjustability');
  for (const a of index.attribute_defs) specDef(a.key, a.type, a.unit, a.allowed_values, a.categories, a.description, 'attribute');

  index.rule_defs.forEach((d, i) => s.push(stmt(
    'INSERT INTO rule_defs (key, kind, direction, unit, engine_uses, description, sort) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [d.key, d.kind, d.direction, d.unit, bool(d.engine_uses), d.description, i])));
  const allRules = [...index.rules, ...Object.values(lines).flatMap(l => l.rules || [])];
  const seenRule = new Set();
  allRules.forEach((r, i) => {
    const k = `${r.key}|${r.scope}`;
    if (seenRule.has(k)) return;            // a manufacturer rule appears in each of its lines
    seenRule.add(k);
    s.push(stmt(
      `INSERT INTO rules (rule_key, scope, authority, value, value_max, unit, statement, source_ref, verified, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.key, r.scope, r.authority, r.value, r.value_max, r.unit, r.statement, r.source_ref, bool(r.verified), i]));
  });
  index.line_compatibility.forEach((c, i) => s.push(stmt(
    'INSERT INTO line_compatibility (line, other_line, relationship, via_categories, note, source_ref, sort) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [c.line, c.other_line, c.relationship, json(c.via_categories || []), c.note, c.source_ref, i])));

  let partId = 0, tableId = 0;
  for (const [code, data] of Object.entries(lines)) {
    data.sizes.forEach((z, i) => s.push(stmt(
      'INSERT INTO sizes (line, size, flue_in, outer_in, sort) VALUES (?, ?, ?, ?, ?)', [code, z.size, z.flue_in, z.outer_in, i])));
    data.parts.forEach((p, i) => {
      const id = ++partId;
      s.push(stmt(`INSERT INTO parts (id, line, ${CORE.join(', ')}, sort) VALUES (?, ?, ${CORE.map(() => '?').join(', ')}, ?)`,
        [id, code, p.order_number, p.stock_number, p.category, p.description, p.finish, bool(p.carton_filler),
          bool(p.optional), p.active === false ? 0 : 1, p.source_page, p.note, i]));
      p.sizes.forEach((z, j) => s.push(stmt('INSERT INTO part_sizes (part_id, size, sort) VALUES (?, ?, ?)', [id, z, j])));
      const spec = (key, size, value) => s.push(stmt(
        'INSERT INTO part_specs (part_id, spec_key, size, value) VALUES (?, ?, ?, ?)', [id, key, size, json(value)]));
      for (const [key] of PART_FIELD_SPECS) if (p[key] != null) spec(key, '', p[key]);
      for (const [size, range] of Object.entries(p.adjustability || {})) spec(ADJUSTABILITY, size, range);
      for (const [key, value] of Object.entries(p.attributes || {})) spec(key, '', value);
      Object.entries(p.dimensions || {}).forEach(([label, d], j) => s.push(stmt(
        'INSERT INTO part_dimensions (part_id, label, value_in, value_text, meaning, sort) VALUES (?, ?, ?, ?, ?, ?)',
        [id, label, d.value_in, d.text, d.meaning, j])));
    });
    for (const [name, rows] of Object.entries(data.lookups || {})) {
      const tid = ++tableId;
      const columns = [...new Set(rows.flatMap(r => Object.keys(r)))];
      s.push(stmt('INSERT INTO lookup_tables (id, line, name, columns) VALUES (?, ?, ?, ?)', [tid, code, name, json(columns)]));
      rows.forEach((r, i) => s.push(stmt('INSERT INTO lookup_rows (table_id, sort, row) VALUES (?, ?, ?)', [tid, i, json(r)])));
    }
  }

  const summary = Object.fromEntries(Object.entries(lines).map(([c, l]) => [c, l.parts.length]));
  s.push(stmt('INSERT INTO catalog_imports (imported_at, source, summary) VALUES (?, ?, ?)',
    [new Date().toISOString(), source, json({ parts: summary })]));
  await db.batch(s, 'write');
  return summary;
}

/** Drops empty fields, the same way the catalog build does: a missing key means "not applicable". */
export function prune(x) {
  if (Array.isArray(x)) return x.map(prune);
  if (x && typeof x === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(x)) {
      if (v === null || v === undefined || v === '') continue;
      if (Array.isArray(v) && !v.length) continue;
      if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue;
      out[k] = prune(v);
    }
    return out;
  }
  return x;
}

const all = async (db, sql, args = []) => (await db.execute({ sql, args })).rows;
const parse = v => (v == null ? null : JSON.parse(v));
const flag = v => v === 1 || v === 1n || v === true;

/** Reads the catalog back as { index, lines } in the build's shape (without built_at). */
export async function readCatalog(db) {
  const [mfrs, sources, plines, cats, specDefs, ruleDefs, rules, compat] = await Promise.all([
    all(db, 'SELECT * FROM manufacturers ORDER BY sort'),
    all(db, 'SELECT * FROM sources ORDER BY sort'),
    all(db, 'SELECT * FROM product_lines ORDER BY sort'),
    all(db, 'SELECT * FROM categories ORDER BY sort'),
    all(db, 'SELECT * FROM spec_defs ORDER BY sort'),
    all(db, 'SELECT * FROM rule_defs ORDER BY sort'),
    all(db, 'SELECT * FROM rules ORDER BY sort'),
    all(db, 'SELECT * FROM line_compatibility ORDER BY sort'),
  ]);
  const manufacturers = mfrs.map(m => ({ code: m.code, name: m.name, website: m.website, logo_file: m.logo_file }));
  const product_lines = plines.map(l => ({
    code: l.code, name: l.name, manufacturer: l.manufacturer, family: l.family, status: l.status, fuels: parse(l.fuels),
    listing: l.listing, listing_file: l.listing_file, clearance_to_combustibles_in: l.clearance_to_combustibles_in,
    joint_overlap_in: l.joint_overlap_in, wall_thickness_in: l.wall_thickness_in,
    continuous_flue_temp_f: l.continuous_flue_temp_f, default_source: l.default_source, notes: l.notes,
  }));
  const ruleOut = r => ({ key: r.rule_key, authority: r.authority, scope: r.scope, value: r.value, value_max: r.value_max,
    unit: r.unit, statement: r.statement, source_ref: r.source_ref, verified: flag(r.verified) });
  const active = product_lines.filter(l => l.status === 'ACTIVE');

  const index = prune({
    sources: sources.map(x => ({ source_code: x.code, manufacturer: x.manufacturer, document_code: x.document_code,
      title: x.title, published: x.published })),
    manufacturers,
    product_lines,
    categories: cats.map(c => ({ code: c.code, name: c.name, system_zone: c.system_zone, description: c.description })),
    attribute_defs: specDefs.filter(d => d.placement === 'attribute').map(d => ({ key: d.key, type: d.type,
      allowed_values: parse(d.allowed_values), unit: d.unit, categories: parse(d.categories), description: d.description })),
    rule_defs: ruleDefs.map(d => ({ key: d.key, kind: d.kind, direction: d.direction, unit: d.unit,
      engine_uses: flag(d.engine_uses), description: d.description })),
    rules: rules.filter(r => r.scope === 'GLOBAL').map(ruleOut),
    line_compatibility: compat.map(c => ({ line: c.line, other_line: c.other_line, relationship: c.relationship,
      via_categories: parse(c.via_categories), note: c.note, source_ref: c.source_ref })),
    line_files: Object.fromEntries(active.map(l => [l.code, `${l.code}.json`])),
  });

  const placement = new Map(specDefs.map(d => [d.key, d.placement]));
  const lines = {};
  for (const line of active) {
    const [sizes, parts, psizes, specs, dims, tables] = await Promise.all([
      all(db, 'SELECT * FROM sizes WHERE line = ? ORDER BY sort', [line.code]),
      all(db, 'SELECT * FROM parts WHERE line = ? ORDER BY sort', [line.code]),
      all(db, 'SELECT ps.* FROM part_sizes ps JOIN parts p ON p.id = ps.part_id WHERE p.line = ? ORDER BY ps.part_id, ps.sort', [line.code]),
      all(db, 'SELECT s.* FROM part_specs s JOIN parts p ON p.id = s.part_id JOIN spec_defs d ON d.key = s.spec_key WHERE p.line = ? ORDER BY s.part_id, d.sort, s.size', [line.code]),
      all(db, 'SELECT d.* FROM part_dimensions d JOIN parts p ON p.id = d.part_id WHERE p.line = ? ORDER BY d.part_id, d.sort', [line.code]),
      all(db, 'SELECT * FROM lookup_tables WHERE line = ? ORDER BY id', [line.code]),
    ]);
    const group = rows => rows.reduce((m, r) => m.set(Number(r.part_id), [...(m.get(Number(r.part_id)) || []), r]), new Map());
    const sizesOf = group(psizes), specsOf = group(specs), dimsOf = group(dims);
    const lookups = {};
    for (const t of tables) {
      lookups[t.name] = (await all(db, 'SELECT row FROM lookup_rows WHERE table_id = ? ORDER BY sort', [t.id])).map(r => JSON.parse(r.row));
    }
    lines[line.code] = prune({
      line,
      manufacturer: manufacturers.find(m => m.code === line.manufacturer),
      sizes: sizes.map(z => ({ size: z.size, flue_in: z.flue_in, outer_in: z.outer_in })),
      parts: parts.map(p => {
        const id = Number(p.id);
        const out = { order_number: p.order_number, stock_number: p.stock_number, category: p.category,
          description: p.description, sizes: (sizesOf.get(id) || []).map(z => z.size), finish: p.finish,
          carton_filler: flag(p.carton_filler), optional: flag(p.optional), active: flag(p.active),
          source_page: p.source_page, note: p.note, dimensions: {}, adjustability: {}, attributes: {} };
        for (const sp of specsOf.get(id) || []) {
          const v = JSON.parse(sp.value), where = placement.get(sp.spec_key);
          if (where === 'part') out[sp.spec_key] = v;
          else if (where === 'adjustability') out.adjustability[sp.size] = v;
          else out.attributes[sp.spec_key] = v;
        }
        for (const d of dimsOf.get(id) || []) out.dimensions[d.label] = { value_in: d.value_in, text: d.value_text, meaning: d.meaning };
        if (PIPE_CATEGORIES.has(p.category) && out.nominal_length_in != null) {
          out.effective_length_in = out.nominal_length_in - line.joint_overlap_in;
        }
        return out;
      }),
      lookups,
      rules: rules.filter(r => r.scope === line.code || r.scope === line.manufacturer).map(ruleOut),
    });
  }
  return { index, lines };
}
