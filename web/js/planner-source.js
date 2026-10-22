/**
 * Where plans come from. When the page is served with the planner API (the Vercel site), every plan is
 * worked out on the server from the database. Where there is no API (GitHub Pages, a plain static server),
 * the page loads the catalog JSON and runs the engine in the browser, as it always has.
 * Both give the same object, so the page doesn't care which one it got.
 */
import { makeCatalog, lineOptions } from './engine/catalog.js';
import { planChimney } from './engine/planner.js';

const API = 'api';

/** A bad answer from a server that does exist, so the page says so instead of quietly planning in the browser. */
async function apiError(r) {
  let msg = `the planning server answered ${r.status}`;
  try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
  return new Error(msg);
}

/** Elbow chart rows for one chimney size (rows without a size apply to every size). */
const forSize = rows => size => rows.filter(r => r.size == null || String(r.size) === String(size));

/**
 * Connects to the planner for one product line. `lines` lists every line the page can switch to;
 * when lineCode is not one of them, the first line is used.
 */
export async function connectPlanner(lineCode = 'DT') {
  let r = null;
  try { r = await fetch(`${API}/lines`, { headers: { Accept: 'application/json' } }); } catch { /* no server here */ }
  const isApi = r && (r.headers.get('content-type') || '').includes('application/json');
  if (!isApi) return browserPlanner(lineCode);
  if (!r.ok) throw await apiError(r);
  const all = await r.json();
  if (!all.length) throw new Error('the server has no product lines');
  const line = all.find(l => l.code === lineCode) || all[0];
  return {
    mode: 'server',
    lines: all.map(l => ({ code: l.code, name: l.name, manufacturer: l.manufacturer?.name })),
    manufacturer: line.manufacturer,
    line: { code: line.code, name: line.name },
    options: line.options || {},
    elbowOffsets: forSize(line.elbow_offsets || []),
    outerIn: size => line.outer_in?.[String(size)],
    async plan(spec) {
      let res;
      try {
        res = await fetch(`${API}/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec }) });
      } catch { throw new Error('the planning server could not be reached. Check your connection'); }
      if (!res.ok) throw await apiError(res);
      return (await res.json()).plan;
    },
  };
}

async function browserPlanner(lineCode) {
  const index = await (await fetch('catalog/index.json')).json();
  const codes = Object.keys(index.line_files || {});
  if (!codes.length) throw new Error('the catalog has no product lines');
  const code = codes.includes(lineCode) ? lineCode : codes[0];
  const catalog = makeCatalog(index, await (await fetch(`catalog/${index.line_files[code]}`)).json());
  const maker = c => (index.manufacturers || []).find(m => m.code === c)?.name;
  return {
    mode: 'browser',
    lines: (index.product_lines || []).filter(l => codes.includes(l.code))
      .map(l => ({ code: l.code, name: l.name, manufacturer: maker(l.manufacturer) })),
    manufacturer: catalog.manufacturer,
    line: { code: catalog.line.code, name: catalog.line.name },
    options: lineOptions(catalog, index),
    elbowOffsets: forSize(catalog.lookups.elbow_offsets || []),
    outerIn: size => catalog.sizes.find(z => z.size === String(size))?.outer_in,
    plan: async spec => planChimney(spec, catalog),
  };
}
