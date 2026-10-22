// Database path: import, read back, export round trip, every recorded plan through the database, and the API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { connect, migrate, ROOT } from '../db/connect.mjs';
import { writeCatalog, readCatalog } from '../db/catalog-store.mjs';
import { buildCatalog, importCatalog } from '../db/import.mjs';
import { exportCatalog } from '../db/export.mjs';
import { createApp } from '../app.mjs';
import { makeCatalog } from '../../web/js/engine/catalog.js';
import { compareAll } from '../../tests/parity.test.mjs';
import { EXAMPLE_RANCH } from '../../web/js/engine/spec.js';

const build = buildCatalog();
const withoutTime = b => { const { built_at, ...index } = b.index; return { ...b, index }; };
async function freshDb() {
  const db = connect('file::memory:');
  await migrate(db);
  await writeCatalog(db, build);
  return db;
}

test('the database returns exactly the catalog that was imported', async () => {
  const db = await freshDb();
  assert.deepStrictEqual(await readCatalog(db), withoutTime(build));
});

test('exporting to CSV and importing again gives the same catalog', async () => {
  const db = await freshDb();
  const dir = mkdtempSync(join(tmpdir(), 'catalog-export-'));
  try {
    await exportCatalog(db, dir);
    assert.deepStrictEqual(withoutTime(buildCatalog(dir)), withoutTime(build));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a catalog that fails its checks writes nothing', async () => {
  const db = await freshDb();
  const dir = mkdtempSync(join(tmpdir(), 'catalog-bad-'));
  try {
    cpSync(join(ROOT, 'catalog'), dir, { recursive: true });
    const parts = join(dir, 'lines/DT/parts.csv');
    writeFileSync(parts, readFileSync(parts, 'utf8').replace(',CAP,', ',NOT_A_CATEGORY,'));
    await assert.rejects(importCatalog(db, dir), /unknown category 'NOT_A_CATEGORY'[\s\S]*nothing was imported|nothing was imported[\s\S]*NOT_A_CATEGORY/i);
    assert.deepStrictEqual(await readCatalog(db), withoutTime(build));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a line missing a rule the engine needs is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-norule-'));
  try {
    cpSync(join(ROOT, 'catalog'), dir, { recursive: true });
    const rules = join(dir, 'shared/rules.csv');
    writeFileSync(rules, readFileSync(rules, 'utf8').split('\n').filter(l => !l.startsWith('offset.max_count,')).join('\n'));
    assert.throws(() => buildCatalog(dir), /active line DT has no rule for: offset.max_count/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every recorded scenario plans identically from the database', async t => {
  const { index, lines } = await readCatalog(await freshDb());
  for (const line of ['DT', 'XL']) assert.equal(compareAll(makeCatalog(index, lines[line]), t, line), 0, line);
});

test('API: lines with manufacturer, plans, and errors', async () => {
  const db = await freshDb();
  const server = createServer(createApp({ db })).listen(0);
  const base = `http://localhost:${server.address().port}`;
  try {
    const lines = await (await fetch(`${base}/api/lines`)).json();
    assert.equal(lines[0].code, 'DT');
    assert.deepEqual(lines[0].manufacturer, { code: 'DURAVENT', name: 'Duravent', website: 'www.duravent.com', logo_url: null });
    assert.deepEqual(lines[0].sizes, ['5', '6', '7', '8']);
    assert.deepEqual(lines[0].outer_in, { 5: 7, 6: 8, 7: 9, 8: 10 });
    assert.deepEqual(lines[0].elbow_offsets, build.lines.DT.lookups.elbow_offsets);

    const post = body => fetch(`${base}/api/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const r = await post(JSON.stringify({ spec: EXAMPLE_RANCH }));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.manufacturer.name, 'Duravent');
    assert.equal(j.line.name, 'DuraTech');
    const golden = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/golden-plans.json'), 'utf8'));
    assert.deepStrictEqual(j.plan, golden.find(g => g.name === 'ranch 6" SS 6/12').result);   // the same spec as EXAMPLE_RANCH

    assert.equal((await post(JSON.stringify({ spec: { ...EXAMPLE_RANCH, line: 'XX' } }))).status, 400);
    assert.equal((await post('not json')).status, 400);
    assert.equal((await post(JSON.stringify({}))).status, 400);
    assert.equal((await fetch(`${base}/logos/..%2Fshared%2Frules.csv`)).status, 404);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally { server.close(); }
});

test('API: an empty database says to import the catalog', async () => {
  const db = connect('file::memory:');
  await migrate(db);
  const server = createServer(createApp({ db })).listen(0);
  try {
    const r = await fetch(`http://localhost:${server.address().port}/api/lines`);
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /db:import/);
  } finally { server.close(); }
});

test('API: a body the host already parsed (as Vercel does) plans the same', async () => {
  const handle = createApp({ db: await freshDb() });
  const call = body => new Promise(done => {
    const res = { writeHead(status) { this.status = status; }, end(text) { done({ status: this.status, json: JSON.parse(text) }); } };
    handle({ method: 'POST', url: '/api/plan', headers: {}, body }, res);
  });
  const golden = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/golden-plans.json'), 'utf8'));
  const r = await call({ spec: EXAMPLE_RANCH });
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.json.plan, golden.find(g => g.name === 'ranch 6" SS 6/12').result);
  assert.equal((await call(JSON.stringify({ spec: EXAMPLE_RANCH }))).status, 200);
  assert.equal((await call('not json')).status, 400);
  assert.equal((await call(undefined)).status, 400);
});
