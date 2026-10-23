/**
 * Sends every recorded scenario, for each recorded product line, to a running API and checks each plan matches
 * the recorded one (tests/fixtures/golden-plans*.json).
 *   npm run check:api -- https://your-site.vercel.app      (or http://localhost:3000 with npm run dev)
 */
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { SCENARIOS, GOLDEN_LINES, goldenFile, specFor } from '../tests/fixtures/scenarios.mjs';

const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');

const lines = await fetch(`${base}/api/lines`);
if (!lines.ok) { console.error(`${base}/api/lines answered ${lines.status}: ${await lines.text()}`); process.exit(1); }

let differ = 0, done = 0;
// the API picks the catalog by spec.line; a few scenarios are deliberately incomplete specs without one
const queue = GOLDEN_LINES.flatMap(line => {
  const golden = JSON.parse(readFileSync(new URL(`../tests/fixtures/${goldenFile(line)}`, import.meta.url)));
  return SCENARIOS.map(([name, spec], i) => ({ name: `${line}: ${name}`, spec: { line, ...specFor(spec, line) }, want: golden[i].result }));
});
async function worker() {
  for (let job; (job = queue.shift());) {
    const r = await fetch(`${base}/api/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec: job.spec }) });
    const got = r.ok ? (await r.json()).plan : { status: r.status, body: await r.text() };
    if (!isDeepStrictEqual(got, job.want)) { differ++; console.error(`DIFFERS: ${job.name}`); }
    done++;
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`${done - differ} of ${done} scenarios match the recorded plans${differ ? `; ${differ} differ` : ''}.`);
process.exit(differ ? 1 : 0);
