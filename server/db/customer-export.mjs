/**
 * Writes a customer's sheets back out, ready to edit in Excel and import again:
 *   npm run customer:export -- CODE OUT_DIR [--price-list NAME]
 * Without --price-list, the price list in effect today is written.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect } from './connect.mjs';
import { toCsv } from './csv.mjs';
import { readCustomer } from './customer-store.mjs';

export const CUSTOMER_COLS = ['code', 'name', 'vertical', 'price_list', 'currency', 'effective_from', 'effective_to'];

export async function exportCustomer(db, code, outDir, opts) {
  const data = await readCustomer(db, code, opts);
  if (!data) throw new Error(`No customer '${code}'.`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'customer.csv'), toCsv(CUSTOMER_COLS, [data.customer]), 'utf8');
  writeFileSync(join(outDir, 'parts.csv'), toCsv(['line', 'order_number', 'sku', 'description'], data.parts), 'utf8');
  writeFileSync(join(outDir, 'prices.csv'), toCsv(['line', 'order_number', 'price'], data.prices), 'utf8');
  return data;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--price-list');
  const priceList = i >= 0 ? args.splice(i, 2)[1] : undefined;
  const [code, out] = args;
  if (!code || !out) { console.error('Usage: npm run customer:export -- CODE OUT_DIR [--price-list NAME]'); process.exit(1); }
  const db = connect();
  try {
    const d = await exportCustomer(db, code.toUpperCase(), resolve(out), { priceList });
    console.log(`Exported ${d.customer.code}: ${d.parts.length} part numbers, ${d.prices.length} prices to ${resolve(out)}`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
