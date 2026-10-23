/**
 * Turns a plan's parts list into a customer's order: their SKU and description, their price, line totals and a
 * subtotal. Pure, so it is tested without a database. Money is worked in whole cents.
 *
 *   priceOrder(parts, lineCode, pricing)   pricing = customerPricing(db, code) from db/customer-store.mjs
 *
 * A part with no SKU keeps the manufacturer's number and one with no price has no line total; both are listed
 * under `missing` so an order export never drops a part silently. Parts that aren't the manufacturer's (a custom
 * chase cover) are always listed as missing a price.
 */
const cents = v => Math.round(v * 100);

export function priceOrder(parts, lineCode, { priceList, skus, prices }) {
  let subtotal = 0;
  const items = parts.map(p => {
    const key = `${lineCode}|${p.order_number}`;
    const mapped = p.non_catalog ? null : skus.get(key);
    const price = p.non_catalog ? undefined : prices.get(key);
    const missing = [];
    if (!mapped) missing.push('sku');
    if (price == null) missing.push('price');
    const total = price == null ? null : cents(price) * p.qty;
    if (total != null) subtotal += total;
    return {
      qty: p.qty, sku: mapped?.sku ?? null, order_number: p.order_number,
      description: mapped?.description || p.description,
      unit_price: price ?? null, line_total: total == null ? null : total / 100,
      optional: p.optional, non_catalog: p.non_catalog, missing,
    };
  });
  return {
    price_list: priceList?.name ?? null, currency: priceList?.currency ?? null,
    items, subtotal: subtotal / 100, missing: items.filter(i => i.missing.length).length,
  };
}
