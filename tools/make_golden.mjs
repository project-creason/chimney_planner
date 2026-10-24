/**
 * Records today's plan for every scenario in tests/fixtures/scenarios.mjs, from the JSON catalog, for one line.
 * The parity tests compare against these files, so a refactor or the database path must reproduce them.
 * Re-run only when a line's plans are meant to change:  node tools/make_golden.mjs [LINE]   (default DT)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { makeCatalog } from '../web/js/engine/catalog.js';
import { planChimney } from '../web/js/engine/planner.js';
import { SCENARIOS, goldenFile, specFor } from '../tests/fixtures/scenarios.mjs';

const line = process.argv[2] || 'DT';
const load = f => JSON.parse(readFileSync(new URL(`../build/catalog/${f}`, import.meta.url)));
const cat = makeCatalog(load('index.json'), load(`${line}.json`));
const out = SCENARIOS.map(([name, spec]) => {
  let result;
  try { result = planChimney(structuredClone(specFor(spec, line)), cat); } catch (e) { result = { thrown: String(e.message) }; }
  return { name, result };
});
writeFileSync(new URL(`../tests/fixtures/${goldenFile(line)}`, import.meta.url), JSON.stringify(out, null, 1) + '\n');
const ok = out.filter(o => o.result.ok).length, thrown = out.filter(o => o.result.thrown).length;
console.log(`${line}: ${out.length} scenarios: ${ok} ok, ${out.length - ok - thrown} with errors, ${thrown} threw`);
