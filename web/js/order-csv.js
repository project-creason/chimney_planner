/**
 * The order export: one row per part with the customer's SKU, the manufacturer's order number, quantity, unit
 * price and line total, then the subtotal. Rows missing a SKU or price say so in the last column, so nothing is
 * dropped quietly. Opens in Excel (byte-order mark, CRLF) and imports into most order and cart systems.
 *
 *   orderCsv(order, { customer, title })   order = the `order` the planning server returns with a plan
 */
const cell = v => {
  const t = String(v ?? '');
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const amount = v => (v == null ? '' : v.toFixed(2));

export const ORDER_COLS = ['SKU', 'Manufacturer part number', 'Description', 'Qty', 'Unit price', 'Line total', 'Currency', 'Check'];

export function orderCsv(order, { customer, title } = {}) {
  const check = i => [
    i.non_catalog ? 'not a catalog part: quote separately' : '',
    i.missing.includes('sku') && !i.non_catalog ? 'no SKU' : '',
    i.missing.includes('price') && !i.non_catalog ? 'no price' : '',
  ].filter(Boolean).join('; ');
  const rows = order.items.map(i => [i.sku ?? '', i.order_number, i.description, i.qty, amount(i.unit_price),
    amount(i.line_total), order.currency ?? '', check(i)]);
  const head = [
    [title ?? 'Order'],
    customer ? [`Customer: ${customer}`] : null,
    order.price_list ? [`Price list: ${order.price_list}`] : null,
  ].filter(Boolean);
  const unpriced = order.items.filter(i => i.line_total == null).length;
  const foot = [['', '', 'Subtotal', '', '', amount(order.subtotal), order.currency ?? '',
    unpriced ? `${unpriced} line${unpriced > 1 ? 's' : ''} without a price ${unpriced > 1 ? 'are' : 'is'} not in the subtotal` : '']];
  return '﻿' + [...head, [], ORDER_COLS, ...rows, ...foot].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
