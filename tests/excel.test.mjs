// ICC EXCEL: the second product line. Proves the planner follows another maker's parts and rules from the catalog alone.
// Run:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeCatalog, lineOptions } from '../web/js/engine/catalog.js';
import { planChimney } from '../web/js/engine/planner.js';
import { EXAMPLE_RANCH, EXAMPLE_THROUGH_WALL, EXAMPLE_CHASE_FIREPLACE } from '../web/js/engine/spec.js';
import { SCENARIOS } from './fixtures/scenarios.mjs';

const load = f => JSON.parse(readFileSync(new URL(`../web/catalog/${f}`, import.meta.url)));
const index = load('index.json');
const cat = makeCatalog(index, load('XL.json'));
const qty = (res, order) => res.parts.find(p => p.order_number === order)?.qty ?? 0;
const xl = (spec, change = s => s) => { const s = structuredClone({ ...spec, line: 'XL' }); change(s); return s; };
/** The ranch with a 12 ft manual minimum: EXCEL publishes no draft guideline, so the roof rules then set the height. */
const RANCH = xl(EXAMPLE_RANCH, s => { s.appliance.minSystemHeightFt = 12; });

test('ranch: square support hangs 3" below the ceiling and its storm collar makes it the attic shield', () => {
  const r = planChimney(RANCH, cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(qty(r, '6ESS'), 1);
  assert.equal(qty(r, '6ESQSC'), 1);            // square support storm collar on top, in the attic
  assert.equal(r.parts.filter(p => p.category === 'ATTIC_SHIELD').length, 0);
  assert.equal(r.geometry.startElevationIn, 96 - 3);
  assert.equal(qty(r, '6EFA'), 1);              // 1/12-7/12 flashing ships with its storm collar...
  assert.equal(qty(r, 'ESC'), 0);               // ...so none is added
  assert.equal(qty(r, '6ERC'), 1);
  assert.equal(qty(r, 'ERB'), 1);               // more than 5 ft above the roof
  // installed length is nominal less 1 3/4": 24" + 2 x 48" = 22.25 + 2 x 46.25
  assert.equal(r.geometry.chimneyLengthIn, 114.75);
  assert.equal(r.warnings.length, 0);           // supports carry a rated height, so no capacity warning
});

test('round support takes the universal storm collar and includes its trim', () => {
  const r = planChimney(xl(RANCH, s => { s.route.ceiling.support = 'ROUND'; }), cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(qty(r, '6ERDS'), 1);
  assert.equal(qty(r, 'ESC'), 1);
  assert.equal(r.parts.filter(p => p.category === 'TRIM_COLLAR_ROUND_BOX').length, 0);
});

test('a floor above the support: radiation shield there, with the storm collar on the attic-floor shield', () => {
  const r = planChimney(xl(RANCH, s => { s.route.floorPenetrationsIn = [192]; s.roof.penetrationElevationIn = 300; }), cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(qty(r, '6ERS'), 1);
  assert.equal(qty(r, 'ESC'), 1);
  assert.equal(qty(r, '6ESQSC'), 0);            // the support box is no longer at the attic floor
  assert.ok(r.checks.some(c => /radiation shield at the attic floor with a storm collar/.test(c.detail)));
});

test('cathedral ceiling: the support hangs lower as the ceiling gets steeper', () => {
  const r = planChimney(xl(RANCH, s => {
    s.route.ceiling = { style: 'CATHEDRAL', elevationIn: 96, pitch: 8 }; s.route.atticAbove = false;
  }), cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(qty(r, '6ESS'), 1);
  assert.equal(r.geometry.startElevationIn, 96 - 6.75);   // 7/12-12/12: 6 3/4" below the ceiling
});

test('an offset uses two single elbows from the chart for that size, and an offset support above it', () => {
  const r = planChimney(xl(RANCH, s => { s.route.offsets = [{ horizontalIn: 10, availableRiseIn: 40 }]; s.roof.penetrationElevationIn = 180; }), cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(qty(r, '6EE30'), 2);             // 30°, 18" between: 11" over 25" (15° would need 42.5")
  assert.equal(qty(r, '6EL18'), 1);
  assert.equal(qty(r, 'EOS'), 1);
  assert.equal(r.geometry.offsets[0].riseIn, 25);
  // the 8" chart differs: the same pick rises 26"
  const r8 = planChimney(xl(RANCH, s => {
    s.appliance.collarSizeIn = 8; s.route.offsets = [{ horizontalIn: 10, availableRiseIn: 40 }]; s.roof.penetrationElevationIn = 180;
  }), cat);
  assert.equal(r8.geometry.offsets[0].riseIn, 26);
  assert.equal(qty(r8, '8EE30'), 2);
});

test('45° elbows (Canada only) are never offered, and more than two offsets are refused', () => {
  assert.deepEqual([...new Set(cat.lookup('elbow_offsets', '6').map(r => r.angle_deg))], [15, 30]);
  const r = planChimney(xl(RANCH, s => { s.route.offsets = [{ horizontalIn: 5 }, { horizontalIn: 5 }, { horizontalIn: 5 }]; }), cat);
  assert.ok(!r.ok);
  assert.match(r.errors[0], /at most 2 allowed/);
});

test('through the wall: wall radiation shield, tee, and the wall support doubles as the 8 ft wall bands', () => {
  const r = planChimney(xl(EXAMPLE_THROUGH_WALL, s => { s.route.wallTopElevationIn = 300; }), cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(qty(r, '6EWRS'), 1);
  assert.equal(qty(r, '6ETI'), 1);
  assert.equal(qty(r, 'EWS'), 1 + 2);           // one carries the tee run; ~9 ft of wall run needs 2 more at 8 ft spacing
  assert.ok(r.parts.find(p => p.order_number === 'EWS').reasons.some(x => /up to 44 ft/.test(x)));
  assert.ok(r.notes.some(n => /extends 4" into the room/.test(n)));
  assert.equal(r.geometry.startElevationIn, 66.13);   // 60" + half the 12 1/4" tee (geometry rounds to 0.01)
});

test('a wall thicker than the wall radiation shield takes is refused (no extension kit)', () => {
  const r = planChimney(xl(EXAMPLE_THROUGH_WALL, s => { s.route.wallThicknessIn = 14; }), cat);
  assert.ok(!r.ok);
  assert.match(r.errors[0], /exceeds the thimble's 12" maximum\.$/);
});

test('no manual height: no guideline to fall back on, so the roof rules set the height, with a warning', () => {
  const r = planChimney(xl(EXAMPLE_RANCH), cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.match(r.warnings[0], /EXCEL publishes no height guideline/);
  assert.equal(r.geometry.minSystemHeightFt, null);
  assert.equal(r.geometry.requiredTopIn, 206);   // 2 ft above the ridge, as with the manual's 12 ft
});

test('chase top: a shop-made cover with the vented chase cone, which brings its own storm collar', () => {
  const r = planChimney(xl(EXAMPLE_CHASE_FIREPLACE, s => { s.finish = 'SS'; }), cat);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(qty(r, 'CUSTOM-CHASE-COVER'), 1);
  assert.equal(qty(r, '8EVCC'), 1);
  assert.equal(qty(r, 'ESC'), 0);
  assert.equal(qty(r, '8EAP'), 1);
  assert.ok(r.blockers.length === 0 && r.warnings.some(w => /no chase top flashing/.test(w)));
});

test('chase top: EXCEL needs 8" above the chase, more than DuraTech\'s 6"', () => {
  const set = v => xl(EXAMPLE_CHASE_FIREPLACE, s => { s.route.exit = { ...s.route.exit, topRule: 'SET', aboveChaseIn: v }; });
  assert.match(planChimney(set(6), cat).errors[0], /minimum of 8"/);
  assert.ok(planChimney(set(8), cat).ok);
});

test('roof surfaces: tile gets the flexible base flashing, metal the metal roof flashing', () => {
  assert.equal(qty(planChimney(xl(RANCH, s => { s.roof.surface = 'TILE'; }), cat), '6ELFA'), 1);
  assert.equal(qty(planChimney(xl(RANCH, s => { s.roof.surface = 'METAL_CORRUGATED'; }), cat), '6EMFA'), 1);
});

test('parts EXCEL does not make are refused, not swapped for something else', () => {
  const r = planChimney(xl(RANCH, s => { s.appliance.collarSizeIn = 5; }), cat);   // no 5" square support
  assert.ok(!r.ok);
  assert.match(r.errors[0], /square ceiling support box available in size 5/);
  assert.ok(!planChimney(xl(RANCH, s => { s.options = { cap: 'DIKAPT' }; }), cat).ok);
});

test('no scenario throws, and the form gets only what EXCEL offers', () => {
  for (const [name, spec] of SCENARIOS) assert.doesNotThrow(() => planChimney(xl(spec), cat), name);
  const o = lineOptions(cat, index);
  assert.deepEqual(o.finishes, ['SS']);
  assert.deepEqual(o.capStyles, ['STANDARD', 'DELUXE', 'REVOLVING']);
  assert.deepEqual(o.connectors, []);           // one support height for any stovepipe
  assert.equal(o.maxOffsets, 2);
  assert.equal(o.chaseAboveMinIn, 8);
  assert.equal(o.chaseFlashingCoversIn, null);
  assert.equal(o.draftGuideline, false);
  assert.ok(!o.categories.includes('PASS_THROUGH_SHIELD') && o.categories.includes('ELBOW'));
  assert.equal(o.source.document_code, 'XL-CAT-2026_01');
});
