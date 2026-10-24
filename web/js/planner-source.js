/**
 * Where plans come from: the planner API next to the page (the Vercel site, or  npm run dev  locally).
 * Every plan is worked out on the server from the database.
 *
 * A customer's private link (?customer=<key>) adds their SKUs and prices: the server returns them with each plan
 * as `order`, which the page finds on the plan it gets back. Only the server has customer data.
 */
const API = 'api';
const NO_SERVER = 'the planning server could not be reached. Check your connection';

/** A bad answer from the server, as an error the page can show. */
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
export async function connectPlanner(lineCode = 'DT', customerKey = null) {
  let r;
  try { r = await fetch(`${API}/lines`, { headers: { Accept: 'application/json' } }); } catch { throw new Error(NO_SERVER); }
  if (!(r.headers.get('content-type') || '').includes('application/json')) throw new Error(NO_SERVER);
  if (!r.ok) throw await apiError(r);
  const all = await r.json();
  if (!all.length) throw new Error('the server has no product lines');
  const line = all.find(l => l.code === lineCode) || all[0];

  let customer = null, customerError = null;
  if (customerKey) {
    const c = await fetch(`${API}/customer`, { headers: { Accept: 'application/json', 'X-Customer-Key': customerKey } });
    if (c.ok) customer = await c.json();
    else { customerError = (await apiError(c)).message; customerKey = null; }
  }
  const headers = { 'Content-Type': 'application/json', ...(customerKey ? { 'X-Customer-Key': customerKey } : {}) };
  return {
    customer, customerError,
    lines: all.map(l => ({ code: l.code, name: l.name, manufacturer: l.manufacturer?.name })),
    manufacturer: line.manufacturer,
    line: { code: line.code, name: line.name },
    options: line.options || {},
    elbowOffsets: forSize(line.elbow_offsets || []),
    outerIn: size => line.outer_in?.[String(size)],
    async plan(spec) {
      let res;
      try {
        res = await fetch(`${API}/plan`, { method: 'POST', headers, body: JSON.stringify({ spec }) });
      } catch { throw new Error(NO_SERVER); }
      if (!res.ok) throw await apiError(res);
      const { plan, order } = await res.json();
      return order ? { ...plan, order } : plan;
    },
  };
}
