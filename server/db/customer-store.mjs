/**
 * Customers: a retailer's or distributor's own part numbers and prices for the catalog's parts.
 *
 * A customer folder holds three sheets (see customers/README.md):
 *   customer.csv   one row: code, name, vertical, price_list, currency, effective_from, effective_to
 *   parts.csv      line, order_number, sku, description     (line may be blank when the order number is unique)
 *   prices.csv     line, order_number, price
 *
 *   checkCustomer(sheets, catalogParts)  -> { errors, warnings, customer, parts, prices }   (pure)
 *   writeCustomer(db, checked, { newKey }) replaces the customer's part numbers and that price list
 *   readCustomer(db, code)                 the same sheets back, for export
 *   customerByKey(db, key)                 the customer a private link's key belongs to, or null
 *   customerPricing(db, code, today)       part numbers and the price list in effect today, keyed `line|order_number`
 *   listCustomers(db)                      customers with their price lists and saved import layout, for the admin page
 *   writePriceImport(db, ...)              saves a matched price sheet from the admin page (see server/price-import.mjs)
 *
 * Customer rows refer to parts by line + order number, never by row id, so a catalog import leaves them alone.
 * A customer's private link carries a random key; only its SHA-256 is stored (settings.access_key_sha256).
 */
import { createHash, randomBytes } from 'node:crypto';

export const VERTICALS = ['RETAIL', 'DISTRIBUTOR', 'SERVICE', 'MANUFACTURER', 'INSPECTOR'];
const CODE = /^[A-Z0-9][A-Z0-9_-]{1,19}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const hashKey = key => createHash('sha256').update(String(key)).digest('hex');
const all = async (db, sql, args = []) => (await db.execute({ sql, args })).rows;

/** "$1,234.50" -> 1234.5; null when it isn't a price. */
function money(text) {
  const t = String(text).replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/**
 * Checks a customer's sheets against the catalog. Every problem is reported as file:row (row 2 is the first
 * line under the header, as Excel numbers it); any error means nothing should be written.
 * sheets = { customer: rows, parts: rows, prices: rows } from parseCsv; catalogParts = [{ line, order_number }].
 */
export function checkCustomer(sheets, catalogParts) {
  const errors = [], warnings = [];
  const linesOf = new Map();
  for (const p of catalogParts) linesOf.set(p.order_number, [...(linesOf.get(p.order_number) || []), p.line]);
  const known = new Set(catalogParts.map(p => `${p.line}|${p.order_number}`));

  const head = sheets.customer || [];
  if (head.length !== 1) errors.push(`customer.csv: needs exactly one row under the header, found ${head.length}`);
  const c = head[0] || {};
  const customer = {
    code: (c.code || '').toUpperCase(), name: c.name || '', vertical: (c.vertical || '').toUpperCase() || null,
    price_list: c.price_list || '', currency: (c.currency || 'USD').toUpperCase(),
    effective_from: c.effective_from || null, effective_to: c.effective_to || null,
  };
  if (head.length === 1) {
    if (!CODE.test(customer.code)) errors.push('customer.csv:2: code must be 2-20 letters, digits, - or _ (e.g. ACME)');
    if (!customer.name) errors.push('customer.csv:2: name is blank');
    if (customer.vertical && !VERTICALS.includes(customer.vertical)) errors.push(`customer.csv:2: vertical must be one of ${VERTICALS.join(', ')} or blank`);
    if (!/^[A-Z]{3}$/.test(customer.currency)) errors.push('customer.csv:2: currency must be a 3-letter code such as USD');
    for (const k of ['effective_from', 'effective_to']) {
      if (customer[k] && !DATE.test(customer[k])) errors.push(`customer.csv:2: ${k} must be a date like 2026-01-31 or blank`);
    }
    if (customer.effective_from && customer.effective_to && customer.effective_to < customer.effective_from) {
      errors.push('customer.csv:2: effective_to is before effective_from');
    }
    if ((sheets.prices || []).length && !customer.price_list) errors.push('customer.csv:2: price_list is blank, so the prices have no list to go in');
  }

  /** The part a row names, or null after reporting why not. */
  const resolve = (file, n, row) => {
    const order = row.order_number;
    if (!order) { errors.push(`${file}:${n}: order_number is blank`); return null; }
    if (row.line) {
      if (!known.has(`${row.line}|${order}`)) { errors.push(`${file}:${n}: ${row.line} ${order} is not in the catalog`); return null; }
      return { line: row.line, order_number: order };
    }
    const lines = linesOf.get(order) || [];
    if (!lines.length) { errors.push(`${file}:${n}: ${order} is not in the catalog`); return null; }
    if (lines.length > 1) { errors.push(`${file}:${n}: ${order} is in more than one line (${lines.join(', ')}); fill in line`); return null; }
    return { line: lines[0], order_number: order };
  };

  const parts = [], seenPart = new Map(), seenSku = new Map();
  (sheets.parts || []).forEach((row, i) => {
    const n = i + 2, p = resolve('parts.csv', n, row);
    if (!row.sku) errors.push(`parts.csv:${n}: sku is blank`);
    if (!p || !row.sku) return;
    const k = `${p.line}|${p.order_number}`;
    if (seenPart.has(k)) { errors.push(`parts.csv:${n}: ${p.order_number} is already on row ${seenPart.get(k)}`); return; }
    seenPart.set(k, n);
    if (seenSku.has(row.sku)) warnings.push(`parts.csv:${n}: SKU ${row.sku} is also used on row ${seenSku.get(row.sku)}`);
    else seenSku.set(row.sku, n);
    parts.push({ ...p, sku: row.sku, description: row.description || null });
  });

  const prices = [], seenPrice = new Map();
  (sheets.prices || []).forEach((row, i) => {
    const n = i + 2, p = resolve('prices.csv', n, row);
    const price = money(row.price ?? '');
    if (price === null) errors.push(`prices.csv:${n}: price '${row.price ?? ''}' is not a number`);
    if (!p || price === null) return;
    const k = `${p.line}|${p.order_number}`;
    if (seenPrice.has(k)) { errors.push(`prices.csv:${n}: ${p.order_number} is already on row ${seenPrice.get(k)}`); return; }
    seenPrice.set(k, n);
    prices.push({ ...p, price });
  });

  const noSku = catalogParts.filter(p => !seenPart.has(`${p.line}|${p.order_number}`)).length;
  const noPrice = catalogParts.filter(p => !seenPrice.has(`${p.line}|${p.order_number}`)).length;
  if (noSku) warnings.push(`${noSku} catalog part${noSku > 1 ? 's have' : ' has'} no SKU; plans show the manufacturer's number for them`);
  if (noPrice) warnings.push(`${noPrice} catalog part${noPrice > 1 ? 's have' : ' has'} no price; plans show them as "no price"`);
  return { errors, warnings, customer, parts, prices };
}

/** The catalog's parts, for checkCustomer. */
export const catalogParts = db => all(db, 'SELECT line, order_number FROM parts ORDER BY line, sort');
/** The same with stock numbers, which price sheets often use instead. */
export const catalogPartsWithStock = db => all(db, 'SELECT line, order_number, stock_number FROM parts ORDER BY line, sort');

/**
 * Saves a checked customer in one transaction: the customer row, all of its part numbers (replaced), and the
 * named price list (replaced; other price lists stay). Returns { key } when a new private-link key was made:
 * on the customer's first import, or with newKey. The key is not stored and can't be shown again.
 */
async function settingsWithKey(db, code, newKey) {
  const old = (await all(db, 'SELECT name, vertical, settings FROM customers WHERE code = ?', [code]))[0];
  const settings = old ? JSON.parse(old.settings || '{}') : {};
  let key = null;
  if (newKey || !settings.access_key_sha256) {
    key = randomBytes(18).toString('base64url');
    settings.access_key_sha256 = hashKey(key);
  }
  return { old, settings, key };
}

/** Statements that replace one named price list with these prices. */
function replacePriceList(code, { name, currency, effective_from, effective_to }, prices) {
  const list = 'SELECT id FROM price_lists WHERE customer = ? AND name = ?';
  return [
    { sql: `DELETE FROM prices WHERE price_list_id IN (${list})`, args: [code, name] },
    { sql: 'DELETE FROM price_lists WHERE customer = ? AND name = ?', args: [code, name] },
    { sql: 'INSERT INTO price_lists (customer, name, currency, effective_from, effective_to) VALUES (?, ?, ?, ?, ?)',
      args: [code, name, currency, effective_from ?? null, effective_to ?? null] },
    ...prices.map(p => ({ sql: `INSERT INTO prices (price_list_id, line, order_number, price) SELECT id, ?, ?, ? FROM (${list})`,
      args: [p.line, p.order_number, p.price, code, name] })),
  ];
}

export async function writeCustomer(db, { customer: c, parts, prices }, { newKey = false } = {}) {
  const { settings, key } = await settingsWithKey(db, c.code, newKey);
  const s = [
    { sql: `INSERT INTO customers (code, name, vertical, settings) VALUES (?, ?, ?, ?)
            ON CONFLICT (code) DO UPDATE SET name = excluded.name, vertical = excluded.vertical, settings = excluded.settings`,
      args: [c.code, c.name, c.vertical, JSON.stringify(settings)] },
    { sql: 'DELETE FROM customer_parts WHERE customer = ?', args: [c.code] },
    ...parts.map(p => ({ sql: 'INSERT INTO customer_parts (customer, line, order_number, sku, description) VALUES (?, ?, ?, ?, ?)',
      args: [c.code, p.line, p.order_number, p.sku, p.description] })),
  ];
  if (c.price_list) s.push(...replacePriceList(c.code, { ...c, name: c.price_list }, prices));
  await db.batch(s, 'write');
  return { key };
}

/**
 * Saves a price sheet matched by matchSheet. SKUs and descriptions in the sheet are added or updated (parts the
 * sheet leaves out keep theirs); the named price list is replaced by the sheet's prices, when it has any.
 * `layout` (the columns picked on the page) is remembered for the customer's next sheet.
 * customer = { code, name, vertical }: a new code creates the customer and returns its private link key.
 */
export async function writePriceImport(db, { customer: c, priceList, matched, layout }) {
  if (!CODE.test(c.code || '')) throw Object.assign(new Error('Customer code must be 2-20 letters, digits, - or _ (e.g. ACME).'), { status: 400 });
  const { old, settings, key } = await settingsWithKey(db, c.code, false);
  if (!old && !c.name) throw Object.assign(new Error('A new customer needs a name.'), { status: 400 });
  if (c.vertical && !VERTICALS.includes(c.vertical)) throw Object.assign(new Error(`Vertical must be one of ${VERTICALS.join(', ')}.`), { status: 400 });
  const prices = matched.filter(m => m.price != null);
  if (prices.length) {
    if (!priceList?.name) throw Object.assign(new Error('Name the price list.'), { status: 400 });
    if (!/^[A-Z]{3}$/.test(priceList.currency || '')) throw Object.assign(new Error('Currency must be a 3-letter code such as USD.'), { status: 400 });
    for (const k of ['effective_from', 'effective_to']) {
      if (priceList[k] && !DATE.test(priceList[k])) throw Object.assign(new Error(`${k} must be a date like 2026-01-31.`), { status: 400 });
    }
  }
  if (layout) settings.import_layout = layout;
  const s = [
    { sql: `INSERT INTO customers (code, name, vertical, settings) VALUES (?, ?, ?, ?)
            ON CONFLICT (code) DO UPDATE SET name = excluded.name, vertical = excluded.vertical, settings = excluded.settings`,
      args: [c.code, c.name || old.name, c.vertical ?? old?.vertical ?? null, JSON.stringify(settings)] },
    ...matched.filter(m => m.sku).map(m => ({
      sql: `INSERT INTO customer_parts (customer, line, order_number, sku, description) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (customer, line, order_number) DO UPDATE SET sku = excluded.sku,
              description = coalesce(excluded.description, customer_parts.description)`,
      args: [c.code, m.line, m.order_number, m.sku, m.description] })),
  ];
  if (prices.length) s.push(...replacePriceList(c.code, priceList, prices));
  await db.batch(s, 'write');
  return { key, skus: matched.filter(m => m.sku).length, prices: prices.length };
}

export async function listCustomers(db) {
  const [customers, lists] = await Promise.all([
    all(db, 'SELECT code, name, vertical, settings FROM customers ORDER BY name'),
    all(db, `SELECT l.customer, l.name, l.currency, l.effective_from, l.effective_to, count(p.order_number) AS prices
             FROM price_lists l LEFT JOIN prices p ON p.price_list_id = l.id GROUP BY l.id ORDER BY l.effective_from DESC`),
  ]);
  return customers.map(c => ({
    code: c.code, name: c.name, vertical: c.vertical,
    import_layout: JSON.parse(c.settings || '{}').import_layout ?? null,
    price_lists: lists.filter(l => l.customer === c.code).map(l => ({ name: l.name, currency: l.currency,
      effective_from: l.effective_from, effective_to: l.effective_to, prices: Number(l.prices) })),
  }));
}

/** The price list in effect on `today` (YYYY-MM-DD): the latest start among those whose dates include it. */
async function currentPriceList(db, code, today) {
  return (await all(db, `SELECT * FROM price_lists WHERE customer = ?
      AND (effective_from IS NULL OR effective_from <= ?) AND (effective_to IS NULL OR effective_to >= ?)
      ORDER BY effective_from IS NULL, effective_from DESC, id DESC LIMIT 1`, [code, today, today]))[0] || null;
}

/** A customer's sheets as checkCustomer returns them; with no `priceList` named, the one in effect today. */
export async function readCustomer(db, code, { priceList, today = new Date().toISOString().slice(0, 10) } = {}) {
  const row = (await all(db, 'SELECT * FROM customers WHERE code = ?', [code]))[0];
  if (!row) return null;
  const list = priceList
    ? (await all(db, 'SELECT * FROM price_lists WHERE customer = ? AND name = ?', [code, priceList]))[0] || null
    : await currentPriceList(db, code, today);
  const parts = await all(db, 'SELECT line, order_number, sku, description FROM customer_parts WHERE customer = ? ORDER BY line, order_number', [code]);
  const prices = list ? await all(db, 'SELECT line, order_number, price FROM prices WHERE price_list_id = ? ORDER BY line, order_number', [list.id]) : [];
  return {
    customer: { code: row.code, name: row.name, vertical: row.vertical, price_list: list?.name ?? '', currency: list?.currency ?? 'USD',
      effective_from: list?.effective_from ?? null, effective_to: list?.effective_to ?? null },
    parts: parts.map(p => ({ line: p.line, order_number: p.order_number, sku: p.sku, description: p.description })),
    prices: prices.map(p => ({ line: p.line, order_number: p.order_number, price: p.price })),
  };
}

export async function customerByKey(db, key) {
  if (!key) return null;
  const row = (await all(db, "SELECT code, name FROM customers WHERE json_extract(settings, '$.access_key_sha256') = ?", [hashKey(key)]))[0];
  return row ? { code: row.code, name: row.name } : null;
}

/** What priceOrder needs: { priceList, skus, prices } with maps keyed `line|order_number`. */
export async function customerPricing(db, code, today = new Date().toISOString().slice(0, 10)) {
  const list = await currentPriceList(db, code, today);
  const [parts, prices] = await Promise.all([
    all(db, 'SELECT line, order_number, sku, description FROM customer_parts WHERE customer = ?', [code]),
    list ? all(db, 'SELECT line, order_number, price FROM prices WHERE price_list_id = ?', [list.id]) : [],
  ]);
  return {
    priceList: list && { name: list.name, currency: list.currency, effective_from: list.effective_from, effective_to: list.effective_to },
    skus: new Map(parts.map(p => [`${p.line}|${p.order_number}`, { sku: p.sku, description: p.description }])),
    prices: new Map(prices.map(p => [`${p.line}|${p.order_number}`, p.price])),
  };
}
