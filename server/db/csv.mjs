/** CSV for the customer sheets: the reader is shared with the price import page (web/js/csv.js). */
export { parseCsv } from '../../web/js/csv.js';

const cell = v => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (cols, rows) => [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n') + '\n';
