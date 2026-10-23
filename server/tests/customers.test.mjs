// Customers: sheet checks, import and export round trip, pricing a plan, the order CSV, and the API with a private link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { connect, migrate, ROOT } from '../db/connect.mjs';
import { writeCatalog } from '../db/catalog-store.mjs';
import { buildCatalog } from '../db/import.mjs';
import { parseCsv } from '../db/csv.mjs';
import { checkCustomer, customerByKey, customerPricing, readCustomer } from '../db/customer-store.mjs';
import { importCustomer, readCustomerFolder } from '../db/customer-import.mjs';
import { exportCustomer } from '../db/customer-export.mjs';
import { priceOrder } from '../pricing.mjs';
import { createApp } from '../app.mjs';
import { orderCsv } from '../../web/js/order-csv.js';
import { EXAMPLE_RANCH } from '../../web/js/engine/spec.js';

const DEMO = join(ROOT, 'customers/DEMO');
const build = buildCatalog();
const CATALOG = build.lines.DT.parts.map(p => ({ line: 'DT', order_number: p.order_number }));

async function freshDb() {
  const db = connect('file::memory:');
  await migrate(db);
  await writeCatalog(db, build);
  return db;
}
function withSheets(edit) {
  const dir = mkdtempSync(join(tmpdir(), 'customer-'));
  cpSync(DEMO, dir, { recursive: true });
  edit(dir);
  return dir;
}

test('CSV reader: quotes, doubled quotes, CRLF, a byte-order mark and blank lines', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n1,\n'),
    [{ a: 'x, y', b: 'say "hi"' }, { a: '1', b: '' }]);
});

test('the demo customer passes its checks and maps every catalog part but one', () => {
  const r = checkCustomer(readCustomerFolder(DEMO), CATALOG);
  assert.deepEqual(r.errors, []);
  assert.equal(r.customer.code, 'DEMO');
  assert.equal(r.parts.length, CATALOG.length - 1);
  assert.match(r.warnings.join('\n'), /1 catalog part has no SKU/);
  assert.match(r.warnings.join('\n'), /2 catalog parts have no price/);
});

test('bad rows are reported by file and row', () => {
  const sheets = {
    customer: [{ code: 'x', name: '', vertical: 'SHOP', price_list: '', currency: 'dollars', effective_from: '2026-02-01', effective_to: '2026-01-01' }],
    parts: [{ order_number: 'NOPE', sku: 'A' }, { order_number: '6DT-48', sku: '' }, { line: 'DT', order_number: '6DT-36', sku: 'B' },
      { order_number: '6DT-36', sku: 'C' }],
    prices: [{ order_number: '6DT-36', price: 'call' }, { order_number: '6DT-36', price: '$1,050.00' }],
  };
  const { errors } = checkCustomer(sheets, CATALOG);
  for (const want of [/customer.csv:2: code/, /customer.csv:2: name is blank/, /customer.csv:2: vertical/, /customer.csv:2: currency/,
    /effective_to is before/, /price_list is blank/, /parts.csv:2: NOPE is not in the catalog/, /parts.csv:3: sku is blank/,
    /parts.csv:5: 6DT-36 is already on row 4/, /prices.csv:2: price 'call' is not a number/]) {
    assert.ok(errors.some(e => want.test(e)), `expected ${want} in\n${errors.join('\n')}`);
  }
  assert.equal(errors.length, 10);
  const ok = checkCustomer({ ...sheets, customer: [{ code: 'ACME', name: 'Acme', price_list: 'L' }], parts: [], prices: sheets.prices.slice(1) }, CATALOG);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.prices[0].price, 1050);
});

test('an order number in two lines needs its line', () => {
  const both = [...CATALOG, { line: 'XX', order_number: '6DT-36' }];
  const { errors } = checkCustomer({ customer: [{ code: 'AB', name: 'A' }], parts: [{ order_number: '6DT-36', sku: 'S' }], prices: [] }, both);
  assert.match(errors[0], /in more than one line \(DT, XX\); fill in line/);
});

test('import, export and import again give the same customer; a bad sheet writes nothing', async () => {
  const db = await freshDb();
  const first = await importCustomer(db, DEMO);
  assert.ok(first.key && first.key.length >= 20);
  const before = await readCustomer(db, 'DEMO');
  assert.equal(before.parts.length, CATALOG.length - 1);
  assert.equal(before.prices.length, CATALOG.length - 2);

  const out = mkdtempSync(join(tmpdir(), 'customer-export-'));
  const bad = withSheets(dir => writeFileSync(join(dir, 'prices.csv'), 'line,order_number,price\nDT,6DT-36,free\n'));
  try {
    await exportCustomer(db, 'DEMO', out);
    const again = await importCustomer(db, out);
    assert.equal(again.key, null, 'the private link stays the same on a re-import');
    assert.deepStrictEqual(await readCustomer(db, 'DEMO'), before);
    assert.equal((await customerByKey(db, first.key)).code, 'DEMO');

    await assert.rejects(importCustomer(db, bad), /nothing was imported[\s\S]*prices.csv:2: price 'free'/);
    assert.deepStrictEqual(await readCustomer(db, 'DEMO'), before);

    const rotated = await importCustomer(db, DEMO, { newKey: true });
    assert.equal(await customerByKey(db, first.key), null, 'the old link stops working');
    assert.equal((await customerByKey(db, rotated.key)).code, 'DEMO');
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});

test('the price list in effect on the day is used; a re-import of the same list replaces it', async () => {
  const db = await freshDb();
  await importCustomer(db, DEMO);
  const next = withSheets(dir => {
    writeFileSync(join(dir, 'customer.csv'), 'code,name,price_list,currency,effective_from\nDEMO,Demo,2027 prices,USD,2027-01-01\n');
    writeFileSync(join(dir, 'prices.csv'), 'order_number,price\n6DT-36,99\n');
  });
  try {
    await importCustomer(db, next);
    assert.equal((await customerPricing(db, 'DEMO', '2026-06-01')).priceList.name, '2026 sample prices');
    const p2027 = await customerPricing(db, 'DEMO', '2027-03-01');
    assert.equal(p2027.priceList.name, '2027 prices');
    assert.equal(p2027.prices.get('DT|6DT-36'), 99);
    assert.equal(p2027.prices.size, 1);
    assert.equal((await customerPricing(db, 'DEMO', '2025-06-01')).priceList, null);
    writeFileSync(join(next, 'prices.csv'), 'order_number,price\n6DT-48,120\n');
    await importCustomer(db, next);
    assert.deepEqual([...(await customerPricing(db, 'DEMO', '2027-03-01')).prices], [['DT|6DT-48', 120]]);
  } finally { rmSync(next, { recursive: true, force: true }); }
});

test('pricing a parts list: totals in cents, gaps listed, custom parts never priced', () => {
  const parts = [
    { order_number: 'A', description: 'Pipe A', qty: 3, optional: false, non_catalog: false },
    { order_number: 'B', description: 'Cap B', qty: 1, optional: true, non_catalog: false },
    { order_number: 'C', description: 'Unmapped', qty: 2, optional: false, non_catalog: false },
    { order_number: 'CUSTOM-CHASE-COVER', description: 'Custom', qty: 1, optional: false, non_catalog: true },
  ];
  const pricing = {
    priceList: { name: 'L', currency: 'USD' },
    skus: new Map([['DT|A', { sku: 'X-A', description: 'Their pipe' }], ['DT|B', { sku: 'X-B', description: null }],
      ['DT|CUSTOM-CHASE-COVER', { sku: 'nope' }]]),
    prices: new Map([['DT|A', 0.1], ['DT|B', 19.99], ['DT|C', 5], ['DT|CUSTOM-CHASE-COVER', 1]]),
  };
  const o = priceOrder(parts, 'DT', pricing);
  assert.equal(o.subtotal, 30.29);   // 0.30 + 19.99 + 10.00, not 30.290000000000003
  assert.deepEqual(o.items.map(i => [i.sku, i.description, i.line_total, i.missing]), [
    ['X-A', 'Their pipe', 0.3, []], ['X-B', 'Cap B', 19.99, []], [null, 'Unmapped', 10, ['sku']], [null, 'Custom', null, ['sku', 'price']]]);
  assert.equal(o.missing, 2);
  assert.equal(o.currency, 'USD');

  const csv = orderCsv(o, { customer: 'Acme', title: 'DuraTech 6" chimney' });
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], '"DuraTech 6"" chimney"');
  assert.equal(lines[1], 'Customer: Acme');
  assert.equal(lines[4], 'SKU,Manufacturer part number,Description,Qty,Unit price,Line total,Currency,Check');
  assert.equal(lines[5], 'X-A,A,Their pipe,3,0.10,0.30,USD,');
  assert.equal(lines[7], ',C,Unmapped,2,5.00,10.00,USD,no SKU');
  assert.equal(lines[8], ',CUSTOM-CHASE-COVER,Custom,1,,,USD,not a catalog part: quote separately');
  assert.equal(lines[9], ',,Subtotal,,,30.29,USD,1 line without a price is not in the subtotal');
});

test('API: a private link adds the customer order to plans; a wrong one is refused', async () => {
  const db = await freshDb();
  const { key } = await importCustomer(db, DEMO);
  const server = createServer(createApp({ db })).listen(0);
  const base = `http://localhost:${server.address().port}`;
  const plan = headers => fetch(`${base}/api/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ spec: EXAMPLE_RANCH }) });
  try {
    const plain = await (await plan({})).json();
    assert.equal(plain.order, undefined);

    const r = await (await plan({ 'X-Customer-Key': key })).json();
    assert.deepStrictEqual(r.plan, plain.plan, 'pricing never changes the plan');
    assert.deepEqual(r.order.customer, { code: 'DEMO', name: 'Demo Hearth Supply (sample data)' });
    assert.equal(r.order.price_list, '2026 sample prices');
    assert.equal(r.order.items.length, plain.plan.parts.length);
    assert.deepEqual(r.order.items.map(i => i.order_number), plain.plan.parts.map(p => p.order_number));
    for (const i of r.order.items.filter(i => !i.missing.length)) assert.equal(i.sku, `DHS-${i.order_number}`);
    const sum = r.order.items.reduce((t, i) => t + Math.round((i.line_total ?? 0) * 100), 0) / 100;
    assert.equal(r.order.subtotal, sum);
    assert.ok(r.order.subtotal > 0);

    assert.equal((await plan({ 'X-Customer-Key': 'wrong' })).status, 403);
    const who = await fetch(`${base}/api/customer`, { headers: { 'X-Customer-Key': key } });
    assert.deepEqual(await who.json(), { code: 'DEMO', name: 'Demo Hearth Supply (sample data)',
      price_list: { name: '2026 sample prices', currency: 'USD', effective_from: '2026-01-01', effective_to: null } });
    assert.equal((await fetch(`${base}/api/customer`)).status, 400);
    assert.equal((await fetch(`${base}/api/customer`, { headers: { 'X-Customer-Key': 'wrong' } })).status, 403);
    const pre = await fetch(`${base}/api/plan`, { method: 'OPTIONS' });
    assert.match(pre.headers.get('access-control-allow-headers'), /X-Customer-Key/);
  } finally { server.close(); }
});

test('the demo sheets in the repository are the only customer committed', () => {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^customers\/\*$/m);
});
