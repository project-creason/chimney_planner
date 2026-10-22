/**
 * Small CSV reader and writer for the customer sheets (RFC 4180: quoted fields, doubled quotes, CRLF or LF).
 * Reads what Excel saves, including its byte-order mark.
 */

/** Text -> [{ column: value }], with the header row's names trimmed. Blank lines are skipped. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.some(v => v.trim() !== ''));
  if (!head) return [];
  const cols = head.map(h => h.trim());
  return body.map(r => Object.fromEntries(cols.map((c, i) => [c, (r[i] ?? '').trim()])));
}

const cell = v => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (cols, rows) => [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n') + '\n';
