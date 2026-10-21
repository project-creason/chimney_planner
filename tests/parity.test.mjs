// Every scenario must plan exactly as recorded in tests/fixtures/golden-plans.json (see tools/make_golden.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeCatalog } from '../web/js/engine/catalog.js';
import { planChimney } from '../web/js/engine/planner.js';
import { SCENARIOS } from './fixtures/scenarios.mjs';

const load = f => JSON.parse(readFileSync(new URL(`../web/catalog/${f}`, import.meta.url)));
const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/golden-plans.json', import.meta.url)));

/** The plan as plain JSON, or the error it threw, so it compares with the recorded file. */
export function planOrThrown(spec, cat) {
  try { return JSON.parse(JSON.stringify(planChimney(structuredClone(spec), cat))); } catch (e) { return { thrown: String(e.message) }; }
}

/** Compares every scenario against the recorded plans; returns how many differ. */
export function compareAll(cat, t) {
  assert.equal(SCENARIOS.length, GOLDEN.length, 'scenario list changed: re-run tools/make_golden.mjs on the old code first');
  let differ = 0;
  SCENARIOS.forEach(([name, spec], i) => {
    assert.equal(name, GOLDEN[i].name);
    try { assert.deepStrictEqual(planOrThrown(spec, cat), GOLDEN[i].result, name); } catch (e) { differ++; t.diagnostic(e.message.slice(0, 2000)); }
  });
  return differ;
}

test(`JSON catalog: all ${SCENARIOS.length} scenarios plan exactly as recorded`, t => {
  assert.equal(compareAll(makeCatalog(load('index.json'), load('DT.json')), t), 0);
});
