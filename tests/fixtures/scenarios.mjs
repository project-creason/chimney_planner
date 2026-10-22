/**
 * A wide matrix of chimney specs, used to prove two catalog paths (JSON files and the database)
 * and engine refactors give identical plans. Built from the three examples by varying one or two
 * answers at a time; failing plans (bad combinations) are kept on purpose, since errors must match too.
 */
import { EXAMPLE_RANCH, EXAMPLE_THROUGH_WALL, EXAMPLE_CHASE_FIREPLACE } from '../../web/js/engine/spec.js';
import { BOSTON_1200 } from './boston-1200.mjs';

const clone = o => structuredClone(o);
const SIZES = [5, 6, 7, 8];

function* ranch() {
  for (const size of SIZES) for (const finish of ['SS', 'GA']) for (const pitch of [0, 3, 6, 9, 12, 16]) {
    const s = clone(EXAMPLE_RANCH);
    s.finish = finish; s.appliance.collarSizeIn = size; s.roof.pitch = pitch;
    yield [`ranch ${size}" ${finish} ${pitch}/12`, s];
  }
  for (const support of ['SQUARE', 'SQUARE_COLLAR', 'ROUND', 'FLAT_UNPAINTED']) for (const size of SIZES) {
    for (const roundTrim of support === 'ROUND' ? ['ROUND', 'SQUARE'] : [undefined]) {
      const s = clone(EXAMPLE_RANCH);
      s.appliance.collarSizeIn = size;
      s.route.ceiling.support = support;
      if (roundTrim) s.route.ceiling.roundTrim = roundTrim;
      yield [`ranch ${size}" support ${support}${roundTrim ? ' trim ' + roundTrim : ''}`, s];
    }
  }
  for (const surface of ['SHINGLE', 'METAL_CORRUGATED', 'TILE']) for (const pitch of [4, 8, 12]) {
    const s = clone(EXAMPLE_RANCH);
    s.roof.surface = surface; s.roof.pitch = pitch;
    yield [`ranch roof ${surface} ${pitch}/12`, s];
  }
  for (const connectorLine of ['DB', 'DVL']) for (const pitch of [2, 6, 8, 12, 14, 18]) for (const size of [6, 8]) {
    const s = clone(EXAMPLE_RANCH);
    s.connectorLine = connectorLine; s.appliance.collarSizeIn = size;
    s.route = { type: 'CEILING', ceiling: { style: 'CATHEDRAL', elevationIn: 120, pitch }, atticAbove: false };
    s.roof = { pitch, surface: 'SHINGLE', penetrationElevationIn: 130, horizontalToRidgeFt: 6 };
    yield [`cathedral ${connectorLine} ${size}" ${pitch}/12`, s];
  }
  for (const h of [3, 8, 14, 20, 30]) for (const angle of ['AUTO', 15, 30]) for (const rise of [undefined, 40, 70]) {
    const s = clone(EXAMPLE_RANCH);
    s.route.offsets = [{ horizontalIn: h, angle, ...(rise ? { availableRiseIn: rise } : {}) }];
    yield [`offset ${h}" ${angle} rise ${rise ?? '-'}`, s];
  }
  {
    const s = clone(EXAMPLE_RANCH);
    s.route.offsets = [{ horizontalIn: 8 }, { horizontalIn: 12 }];
    yield ['two offsets', s];
    const t = clone(s);
    t.route.offsets.push({ horizontalIn: 4 });
    yield ['three offsets', t];
  }
  for (const manual of [{ minSystemHeightFt: 12 }, { minSystemHeightFt: 25 }, { maxSystemHeightFt: 16 },
    { maxOffsets: 0 }, { offsetAnglesDeg: [15] }, { requiresRoofRadiationShield: true },
    { acceptsChimney: 'OTHER' }, { acceptsChimney: 'NOT_STATED' }, { acceptsChimney: 'USER_CONFIRMED' }]) {
    const s = clone(EXAMPLE_RANCH);
    Object.assign(s.appliance, manual);
    s.route.offsets = [{ horizontalIn: 10 }];
    yield [`ranch manual ${JSON.stringify(manual)}`, s];
  }
  for (const opts of [{ cap: 'DIKAPT' }, { sparkArrestor: true }, { lockingBands: true },
    { cap: 'DIKAPT', sparkArrestor: true, lockingBands: true }]) for (const size of SIZES) {
    const s = clone(EXAMPLE_RANCH);
    s.appliance.collarSizeIn = size; s.options = opts;
    yield [`ranch ${size}" options ${JSON.stringify(opts)}`, s];
  }
  for (const alt of [{ highAltitude: true }, { siteElevationFt: 1500 }, { siteElevationFt: 6000 }]) {
    const s = { ...clone(EXAMPLE_RANCH), ...alt };
    yield [`ranch altitude ${JSON.stringify(alt)}`, s];
    const t = clone(s);
    t.route.offsets = [{ horizontalIn: 10 }];
    yield [`ranch altitude + offset ${JSON.stringify(alt)}`, t];
  }
  for (const floors of [[204], [204, 312]]) {
    const s = clone(EXAMPLE_RANCH);
    s.route.floorPenetrationsIn = floors; s.route.throughLivingSpace = true;
    s.roof = { pitch: 6, surface: 'SHINGLE', penetrationElevationIn: floors.at(-1) + 46, horizontalToRidgeFt: 20 };
    yield [`ranch ${floors.length + 1} stories`, s];
  }
  for (const reducedClearance of [true, false]) for (const support of ['SQUARE', 'SQUARE_COLLAR']) {
    const s = clone(EXAMPLE_RANCH);
    Object.assign(s.route.ceiling, { reducedClearance, support });
    yield [`ranch reduced clearance ${reducedClearance} ${support}`, s];
  }
  for (const ridge of [undefined, 0, 4, 9.5, 12]) {
    const s = clone(EXAMPLE_RANCH);
    if (ridge === undefined) delete s.roof.horizontalToRidgeFt; else s.roof.horizontalToRidgeFt = ridge;
    s.nearbyWithin10ft = [{ label: 'dormer', elevationIn: 190 }];
    yield [`ranch ridge ${ridge ?? 'none'} + dormer`, s];
  }
  {
    const s = clone(EXAMPLE_RANCH);
    s.roof.deckUndersideElevationIn = 128;
    s.route.offsets = [{ horizontalIn: 12 }];
    yield ['ranch offset bounded by deck', s];
    const t = clone(EXAMPLE_RANCH);
    t.appliance.collarSizeIn = 6; t.size = 7;
    yield ['ranch size mismatch', t];
  }
}

function* wall() {
  for (const size of SIZES) for (const finish of ['SS', 'GA']) for (const thimble of ['STANDARD', 'INSULATED']) {
    const s = clone(EXAMPLE_THROUGH_WALL);
    s.appliance.collarSizeIn = size; s.finish = finish; s.route.thimble = thimble;
    yield [`wall ${size}" ${finish} ${thimble}`, s];
  }
  for (const t of [4, 6, 10.5, 14, 20]) for (const cladding of ['VINYL', 'BRICK', 'STUCCO']) {
    const s = clone(EXAMPLE_THROUGH_WALL);
    s.route.wallThicknessIn = t; s.route.cladding = cladding;
    yield [`wall ${t}" ${cladding}`, s];
  }
  for (const standoffIn of [2, 4, 6, 8]) for (const eave of ['NONE', 'THROUGH_OVERHANG']) {
    const s = clone(EXAMPLE_THROUGH_WALL);
    s.route.standoffIn = standoffIn; s.route.eave = eave;
    yield [`wall standoff ${standoffIn} ${eave}`, s];
  }
  for (const top of [108, 200, 300]) for (const near of [150, 260, 400]) {
    const s = clone(EXAMPLE_THROUGH_WALL);
    s.route.wallTopElevationIn = top; s.nearbyWithin10ft = [{ label: 'roof edge', elevationIn: near }];
    yield [`wall top ${top} nearby ${near}`, s];
  }
  for (const manual of [{ minRiseBeforeHorizontalIn: 24 }, { minHorizontalToCeilingIn: 18 }, { minSystemHeightFt: 20 }]) {
    const s = clone(EXAMPLE_THROUGH_WALL);
    Object.assign(s.appliance, manual);
    s.route.collarToWallIn = 20; s.route.roomCeilingElevationIn = 96;
    yield [`wall manual ${JSON.stringify(manual)}`, s];
  }
}

function* fireplace() {
  for (const size of SIZES) for (const finish of ['SS', 'GA']) {
    const s = clone(EXAMPLE_CHASE_FIREPLACE);
    s.appliance.collarSizeIn = size; s.finish = finish;
    yield [`chase fp ${size}" ${finish}`, s];
  }
  for (const topRule of ['CODE', 'TWO_FT', 'SET']) for (const above of [undefined, 4, 6, 30]) {
    if (topRule !== 'SET' && above !== undefined) continue;
    const s = clone(EXAMPLE_CHASE_FIREPLACE);
    s.route.exit.topRule = topRule;
    if (above !== undefined) s.route.exit.aboveChaseIn = above;
    yield [`chase rule ${topRule} ${above ?? ''}`, s];
  }
  for (const extra of [{ airIntake: true }, { shroud: true }, { chaseWidthIn: 30, chaseDepthIn: 30 }, { chaseTopElevationIn: undefined }]) {
    const s = clone(EXAMPLE_CHASE_FIREPLACE);
    Object.assign(s.route.exit, extra);
    yield [`chase ${JSON.stringify(extra)}`, s];
  }
  for (const connection of ['ANCHOR_PLATE', 'ANCHOR_PLATE_DAMPER', 'DIRECT']) for (const shield of ['FIRESTOP', 'PASS_THROUGH']) {
    const s = clone(EXAMPLE_CHASE_FIREPLACE);
    s.appliance.connection = connection; s.route.penetrationShield = shield;
    yield [`fp ${connection} ${shield}`, s];
  }
  for (const size of SIZES) for (const pitch of [4, 8, 12]) {
    const s = clone(EXAMPLE_CHASE_FIREPLACE);
    s.appliance.collarSizeIn = size;
    s.route = { type: 'FIREPLACE', floorPenetrationsIn: [108], atticAbove: true, exit: { type: 'ROOF' } };
    s.roof = { pitch, surface: 'SHINGLE', penetrationElevationIn: 240, horizontalToRidgeFt: 10 };
    yield [`fp roof exit ${size}" ${pitch}/12`, s];
  }
  {
    const s = clone(EXAMPLE_CHASE_FIREPLACE);
    s.route.offsets = [{ horizontalIn: 12 }];
    yield ['chase fp offset', s];
    const t = clone(EXAMPLE_CHASE_FIREPLACE);
    t.appliance.type = 'STOVE';
    yield ['stove on fireplace route', t];
  }
}

export const SCENARIOS = [...ranch(), ...wall(), ...fireplace(), ['Boston 1200', clone(BOSTON_1200)]];

/** Lines whose plans for every scenario are recorded, and where. DuraTech keeps its original file name. */
export const GOLDEN_LINES = ['DT', 'XL'];
export const goldenFile = line => (line === 'DT' ? 'golden-plans.json' : `golden-plans-${line}.json`);
/** A scenario's spec for a line: the same answers, that line's parts. DuraTech specs are used exactly as written. */
export const specFor = (spec, line) => (line === 'DT' ? spec : { ...spec, line });
