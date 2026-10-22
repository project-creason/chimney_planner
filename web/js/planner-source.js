/**
 * Where plans come from. When the page is served with the planner API (the Vercel site), every plan is
 * worked out on the server from the database. Where there is no API (GitHub Pages, a plain static server),
 * the page loads the catalog JSON and runs the engine in the browser, as it always has.
 * Both give the same object, so the page doesn't care which one it got.
 */
import { loadCatalog } from './engine/catalog.js';
import { planChimney } from './engine/planner.js';

const API = 'api';

/** A bad answer from a server that does exist, so the page says so instead of quietly planning in the browser. */
async function apiError(r) {
  let msg = `the planning server answered ${r.status}`;
  try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
  return new Error(msg);
}

export async function connectPlanner(lineCode = 'DT') {
  let r = null;
  try { r = await fetch(`${API}/lines`, { headers: { Accept: 'application/json' } }); } catch { /* no server here */ }
  const isApi = r && (r.headers.get('content-type') || '').includes('application/json');
  if (!isApi) return browserPlanner(lineCode);
  if (!r.ok) throw await apiError(r);
  const line = (await r.json()).find(l => l.code === lineCode);
  if (!line) throw new Error(`the server has no product line '${lineCode}'`);
  return {
    mode: 'server',
    manufacturer: line.manufacturer,
    line: { code: line.code, name: line.name },
    elbowOffsets: line.elbow_offsets || [],
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
  const catalog = await loadCatalog('catalog', lineCode);
  return {
    mode: 'browser',
    manufacturer: catalog.manufacturer,
    line: { code: catalog.line.code, name: catalog.line.name },
    elbowOffsets: catalog.lookups.elbow_offsets || [],
    outerIn: size => catalog.sizes.find(z => z.size === String(size))?.outer_in,
    plan: async spec => planChimney(spec, catalog),
  };
}
