/**
 * Writes the database catalog back out as CSVs in the catalog/ layout, ready to edit in Excel:
 *   npm run db:export -- OUT_DIR
 * Importing the exported folder gives the same catalog (tested in server/tests/db.test.mjs).
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect, ROOT } from './connect.mjs';
import { readCatalog, PART_FIELD_SPECS } from './catalog-store.mjs';

const PART_COLS = ['order_number', 'stock_number', 'category', 'description', 'sizes', 'finish', 'carton_filler',
  ...PART_FIELD_SPECS.map(([k]) => k), 'optional', 'active', 'source_page', 'note'];

const cell = v => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (Array.isArray(v)) return v.join('|');
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}:${x}`).join('|');   // map attributes
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (cols, rows) => [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n') + '\n';

export async function exportCatalog(db, outDir) {
  const { index, lines } = await readCatalog(db);
  const rules = (await db.execute('SELECT * FROM rules ORDER BY sort')).rows;
  const shared = join(outDir, 'shared');
  mkdirSync(shared, { recursive: true });
  const put = (path, cols, rows) => writeFileSync(join(outDir, path), csv(cols, rows), 'utf8');

  put('shared/manufacturers.csv', ['code', 'name', 'website', 'logo_file'], index.manufacturers);
  put('shared/sources.csv', ['source_code', 'manufacturer', 'document_code', 'title', 'published'], index.sources);
  put('shared/product_lines.csv', ['code', 'name', 'manufacturer', 'family', 'status', 'fuels', 'listing', 'listing_file',
    'clearance_to_combustibles_in', 'joint_overlap_in', 'wall_thickness_in', 'continuous_flue_temp_f', 'default_source', 'notes'],
  index.product_lines);
  put('shared/categories.csv', ['code', 'name', 'system_zone', 'description'], index.categories);
  put('shared/attribute_defs.csv', ['key', 'type', 'allowed_values', 'unit', 'categories', 'description'], index.attribute_defs);
  put('shared/rule_defs.csv', ['key', 'kind', 'direction', 'unit', 'engine_uses', 'description'], index.rule_defs);
  put('shared/rules.csv', ['rule_key', 'authority', 'scope', 'value', 'value_max', 'unit', 'statement', 'source_ref', 'verified'],
    rules.map(r => ({ ...r, verified: !!r.verified })));
  put('shared/line_compatibility.csv', ['line', 'other_line', 'relationship', 'via_categories', 'note', 'source_ref'],
    index.line_compatibility);

  for (const m of index.manufacturers) {
    const from = resolve(ROOT, 'catalog/logos', m.logo_file || '');
    if (m.logo_file && existsSync(from)) {
      mkdirSync(join(outDir, 'logos'), { recursive: true });
      copyFileSync(from, join(outDir, 'logos', m.logo_file));
    }
  }

  for (const [code, data] of Object.entries(lines)) {
    mkdirSync(join(outDir, 'lines', code), { recursive: true });
    const parts = data.parts;
    put(`lines/${code}/sizes.csv`, ['size', 'flue_in', 'outer_in'], data.sizes);
    put(`lines/${code}/parts.csv`, PART_COLS, parts.map(p => ({ ...p, active: p.active !== false })));
    put(`lines/${code}/dimensions.csv`, ['order_number', 'label', 'value_in', 'value_text', 'meaning'],
      parts.flatMap(p => Object.entries(p.dimensions || {}).map(([label, d]) =>
        ({ order_number: p.order_number, label, value_in: d.value_in, value_text: d.text, meaning: d.meaning }))));
    put(`lines/${code}/adjustability.csv`, ['order_number', 'size', 'min_in', 'max_in'],
      parts.flatMap(p => Object.entries(p.adjustability || {}).map(([size, r]) => ({ order_number: p.order_number, size, ...r }))));
    put(`lines/${code}/attributes.csv`, ['order_number', 'attribute', 'value'],
      parts.flatMap(p => Object.entries(p.attributes || {}).map(([attribute, value]) => ({ order_number: p.order_number, attribute, value }))));
    const tables = (await db.execute({ sql: 'SELECT name, columns FROM lookup_tables WHERE line = ?', args: [code] })).rows;
    for (const t of tables) put(`lines/${code}/${t.name}.csv`, JSON.parse(t.columns), data.lookups[t.name] || []);
  }
  return Object.keys(lines);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2];
  if (!out) { console.error('Usage: npm run db:export -- OUT_DIR'); process.exit(1); }
  const db = connect();
  try {
    const lines = await exportCatalog(db, resolve(out));
    console.log(`Exported ${lines.join(', ')} to ${resolve(out)}`);
  } finally {
    db.close();
  }
}
