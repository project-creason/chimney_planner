/**
 * Loads one customer's sheets into the database:  npm run customer:import -- customers/ACME [--new-key]
 * Checks every row against the catalog first; if anything is wrong, nothing is written.
 * Prints the customer's private link key on its first import (or with --new-key, which retires the old link).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect, migrate } from './connect.mjs';
import { parseCsv } from './csv.mjs';
import { catalogParts, checkCustomer, writeCustomer } from './customer-store.mjs';

/** Reads customer.csv, parts.csv and prices.csv from a folder; parts and prices may be missing. */
export function readCustomerFolder(dir) {
  const sheet = name => (existsSync(join(dir, name)) ? parseCsv(readFileSync(join(dir, name), 'utf8')) : []);
  if (!existsSync(join(dir, 'customer.csv'))) throw new Error(`${dir} has no customer.csv`);
  return { customer: sheet('customer.csv'), parts: sheet('parts.csv'), prices: sheet('prices.csv') };
}

/** Returns { customer, warnings, key }; throws with every problem found, having written nothing. */
export async function importCustomer(db, dir, { newKey = false } = {}) {
  await migrate(db);
  const known = await catalogParts(db);
  if (!known.length) throw new Error('The database has no catalog yet. Run npm run db:import first.');
  const checked = checkCustomer(readCustomerFolder(dir), known);
  if (checked.errors.length) throw new Error(`Customer check failed; nothing was imported.\n${checked.errors.join('\n')}`);
  const { key } = await writeCustomer(db, checked, { newKey });
  return { customer: checked.customer, parts: checked.parts.length, prices: checked.prices.length, warnings: checked.warnings, key };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dir = args.find(a => !a.startsWith('--'));
  if (!dir) { console.error('Usage: npm run customer:import -- customers/CODE [--new-key]'); process.exit(1); }
  const db = connect();
  try {
    const r = await importCustomer(db, resolve(dir), { newKey: args.includes('--new-key') });
    console.log(`Imported ${r.customer.code} (${r.customer.name}): ${r.parts} part numbers, ${r.prices} prices` +
      (r.customer.price_list ? ` in price list '${r.customer.price_list}'` : '') + '.');
    for (const w of r.warnings) console.log(`  note: ${w}`);
    if (r.key) {
      console.log(`\nPrivate link key (shown once, not stored): ${r.key}`);
      console.log(`Customer link: <site>/?customer=${r.key}`);
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
