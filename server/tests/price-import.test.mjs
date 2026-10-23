// Price sheet import: reading .xlsx, guessing the layout, matching rows to the catalog, and the admin API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { connect, migrate, ROOT } from '../db/connect.mjs';
import { writeCatalog } from '../db/catalog-store.mjs';
import { buildCatalog } from '../db/import.mjs';
import { importCustomer } from '../db/customer-import.mjs';
import { customerPricing, readCustomer } from '../db/customer-store.mjs';
import { matchSheet, parsePrice } from '../price-import.mjs';
import { createApp } from '../app.mjs';
import { readXlsx } from '../../web/js/xlsx-lite.js';
import { findHeaderRow, guessColumns } from '../../web/js/price-columns.js';
import { parseCsvRows } from '../../web/js/csv.js';

const build = buildCatalog();
const CATALOG = build.lines.DT.parts.map(p => ({ line: 'DT', order_number: p.order_number, stock_number: p.stock_number }));
const CODES = CATALOG.flatMap(p => [p.order_number, p.stock_number]).filter(Boolean);
const stockOf = order => CATALOG.find(p => p.order_number === order).stock_number;

test('xlsx: every sheet, shared and inline text, entities, numbers to 15 digits, gaps kept in place', async () => {
  const b = readFileSync(join(ROOT, 'tests/fixtures/price-sheet.xlsx'));
  const sheets = await readXlsx(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  assert.deepEqual(sheets.map(s => s.name), ['Prices & more', 'Notes']);
  const rows = sheets[0].rows;
  assert.deepEqual(rows[2], ['Item #', 'Mfr Part No', 'Description', 'Dealer Cost', 'List Price', 'UPC']);
  assert.deepEqual(rows[3], ['SH-1001', 'Duravent:6DT-48SS', '6" x 48" chimney pipe <SS> & "more"', '150.255', '249.99', '662492000001']);
  assert.deepEqual(rows[1], []);
  assert.equal(rows[8][6], 'far cell');
  assert.equal(rows[8][0], '');
  await assert.rejects(readXlsx(new TextEncoder().encode('not a zip').buffer), /not an Excel .xlsx file/);
});

test('prices: money formats read to the cent, anything else is no price', () => {
  for (const [v, want] of [['$1,050.00', 1050], ['74.1965464744984', 74.2], [12, 12], ['USD 9.5', 9.5], ['9.50 usd', 9.5],
    ['call', null], ['N/A', null], ['', null], ['-5', null], ['(5.00)', null], [-1, null]]) {
    assert.equal(parsePrice(v), want, String(v));
  }
});

test('matching: exact, loose, "Vendor:" prefix, stock number; nothing guessed', () => {
  const rows = [
    { n: 2, part: '6DT-48SS', price: '10' },
    { n: 3, part: '6dt 36', price: '11' },
    { n: 4, part: 'DuraVent:6DT-24', price: '12', sku: ' X-24 ', description: 'Their words' },
    { n: 5, part: stockOf('6DT-12'), price: '13' },
    { n: 6, part: '16DT-WS', price: '1' },              // a bigger size, not 6DT-WS
    { n: 7, part: '6DT-48SS', price: '99' },            // second listing
    { n: 8, part: '6DT-09', price: 'call' },
    { n: 9, part: '' },
  ];
  const r = matchSheet(rows, CATALOG);
  assert.deepEqual(r.matched.map(m => [m.n, m.order_number, m.price, m.via, m.loose]), [
    [2, '6DT-48SS', 10, 'order', false], [3, '6DT-36', 11, 'order', true], [4, '6DT-24', 12, 'order', true],
    [5, '6DT-12', 13, 'stock', false], [8, '6DT-09', null, 'order', false]]);
  assert.equal(r.matched[2].sku, 'X-24');
  assert.equal(r.matched[2].description, 'Their words');
  assert.deepEqual(r.unmatched, [{ n: 6, part: '16DT-WS', reason: 'not in the catalog' }]);
  assert.deepEqual(r.duplicates, [{ n: 7, order_number: '6DT-48SS', first: 2 }]);
  assert.deepEqual(r.noPrice, [{ n: 8, order_number: '6DT-09', value: 'call' }]);
  assert.equal(r.catalogWithoutPrice.length, CATALOG.length - 4);
  assert.equal(r.suggestion, null);
});

test('matching: a distributor prefix is suggested, then stripped; digits are never stripped', () => {
  const rows = ['DUR6DT-48', 'DUR6DT-36', 'DUR-6DT-24', 'DuraVent:16DT-WS', 'DuraVent:16DT-RCS', 'DuraVent:10DT-36']
    .map((part, i) => ({ n: i + 2, part, price: '1' }));
  const r = matchSheet(rows, CATALOG);
  assert.equal(r.matched.length, 0);
  assert.deepEqual(r.suggestion, { prefix: 'DUR', rows: 3 });
  const s = matchSheet(rows, CATALOG, { stripPrefix: 'dur' });
  assert.deepEqual(s.matched.map(m => m.order_number), ['6DT-48', '6DT-36', '6DT-24']);
});

test('matching: a number in two lines is listed, not guessed', () => {
  const r = matchSheet([{ n: 2, part: '6DT-48' }], [...CATALOG, { line: 'XX', order_number: '6DT-48' }]);
  assert.match(r.unmatched[0].reason, /matches DT 6DT-48 and XX 6DT-48/);
});

test('layout: header row under a title, part column by its contents, selling price over cost, UPC is not a price', async () => {
  const b = readFileSync(join(ROOT, 'tests/fixtures/price-sheet.xlsx'));
  const rows = (await readXlsx(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)))[0].rows;
  const h = findHeaderRow(rows);
  assert.equal(h, 2);
  assert.deepEqual(guessColumns(rows[h], rows.slice(h + 1), CODES), { part: 1, sku: 0, price: 4, description: 2 });

  // a QuickBooks-style export sorted A-Z, where this manufacturer's parts come after many others
  const csv = ['Product/Service Name,Sales Description,Purchase Cost,Sales Price / Rate,MAP,SKU',
    ...Array.from({ length: 400 }, (_, i) => `Other:AA-${i},Other thing,1.00,2.00,1.50,66249200${String(i).padStart(4, '0')}`),
    'DuraVent:6DT-48SS,48" pipe,100.123,180.5,170,662492233504'].join('\n');
  const q = parseCsvRows(csv);
  assert.equal(findHeaderRow(q), 0);
  assert.deepEqual(guessColumns(q[0], q.slice(1), CODES), { part: 0, sku: 5, price: 3, description: 1 });
});

test('admin API: password, preview, import that adds SKUs without wiping others, saved layout', async () => {
  const db = connect('file::memory:');
  await migrate(db);
  await writeCatalog(db, build);
  await importCustomer(db, join(ROOT, 'customers/DEMO'));
  const call = (app, path, { body, pass = 'secret-pass' } = {}) => {
    const server = createServer(app).listen(0);
    return fetch(`http://localhost:${server.address().port}/api/admin/${path}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${pass}`, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    }).finally(() => server.close());
  };
  assert.equal((await call(createApp({ db, adminPassword: '' }), 'customers')).status, 503);
  const health = async app => { const server = createServer(app).listen(0);
    try { return await (await fetch(`http://localhost:${server.address().port}/api/health`)).json(); } finally { server.close(); } };
  assert.equal((await health(createApp({ db, adminPassword: '' }))).admin_pages, false);
  assert.equal((await health(createApp({ db, adminPassword: 'x' }))).admin_pages, true);
  const app = createApp({ db, adminPassword: 'secret-pass' });
  assert.equal((await call(app, 'customers', { pass: 'wrong' })).status, 401);

  const listed = await (await call(app, 'customers')).json();
  assert.equal(listed.customers[0].code, 'DEMO');
  assert.equal(listed.catalog.length, CATALOG.length);

  const body = {
    customer: { code: 'DEMO' }, price_list: { name: '2027 MSRP', currency: 'USD', effective_from: '2027-01-01' },
    rows: [{ n: 4, part: 'Duravent:6DT-48SS', sku: 'SH-1', price: '249.99' }, { n: 5, part: 'XX-1', price: '1' }],
    layout: { sheet: 'Prices', header_row: 2, headers: { part: 'Mfr Part No', sku: 'Item #', price: 'List Price', description: null } },
  };
  const preview = await (await call(app, 'price-import', { body })).json();
  assert.equal(preview.matched, 1);
  assert.equal(preview.unmatched, 1);
  assert.equal(preview.saved, undefined);
  assert.equal((await customerPricing(db, 'DEMO', '2027-06-01')).priceList.name, '2026 sample prices', 'a preview writes nothing');

  const done = await (await call(app, 'price-import', { body: { ...body, commit: true } })).json();
  assert.deepEqual(done.saved, { key: null, skus: 1, prices: 1 });
  const p2027 = await customerPricing(db, 'DEMO', '2027-06-01');
  assert.equal(p2027.priceList.name, '2027 MSRP');
  assert.deepEqual([...p2027.prices], [['DT|6DT-48SS', 249.99]]);
  assert.equal(p2027.skus.get('DT|6DT-48SS').sku, 'SH-1');
  assert.equal(p2027.skus.get('DT|6DT-36').sku, 'DHS-6DT-36', 'parts the sheet leaves out keep their SKUs');
  assert.equal((await readCustomer(db, 'DEMO', { priceList: '2026 sample prices' })).prices.length, CATALOG.length - 2, 'other lists stay');
  const after = await (await call(app, 'customers')).json();
  assert.deepEqual(after.customers[0].import_layout, body.layout);

  const fresh = await call(app, 'price-import', { body: { ...body, commit: true, customer: { code: 'NEWCO', name: 'New Co', vertical: 'DISTRIBUTOR' } } });
  const made = await fresh.json();
  assert.ok(made.saved.key, 'a new customer gets its private link key');
  assert.equal((await call(app, 'price-import', { body: { ...body, commit: true, customer: { code: 'x' } } })).status, 400);
  assert.equal((await call(app, 'price-import', { body: { ...body, commit: true, customer: { code: 'NOPE' } } })).status, 400, 'a new customer needs a name');
  assert.equal((await call(app, 'price-import', { body: { ...body, commit: true, rows: [{ n: 2, part: 'XX' }] } })).status, 400);
});
