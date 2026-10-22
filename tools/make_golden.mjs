/**
 * Records today's plan for every scenario in tests/fixtures/scenarios.mjs, from the JSON catalog.
 * The parity tests compare against this file, so a refactor or the database path must reproduce it.
 * Re-run only when a plan is meant to change:  node tools/make_golden.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { makeCatalog } from '../web/js/engine/catalog.js';
import { planChimney } from '../web/js/engine/planner.js';
import { SCENARIOS } from '../tests/fixtures/scenarios.mjs';

const load = f => JSON.parse(readFileSync(new URL(`../web/catalog/${f}`, import.meta.url)));
const cat = makeCatalog(load('index.json'), load('DT.json'));
const out = SCENARIOS.map(([name, spec]) => {
  let result;
  try { result = planChimney(structuredClone(spec), cat); } catch (e) { result = { thrown: String(e.message) }; }
  return { name, result };
});
writeFileSync(new URL('../tests/fixtures/golden-plans.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
const ok = out.filter(o => o.result.ok).length, thrown = out.filter(o => o.result.thrown).length;
console.log(`${out.length} scenarios: ${ok} ok, ${out.length - ok - thrown} with errors, ${thrown} threw`);
