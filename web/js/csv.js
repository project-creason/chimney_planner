/**
 * Small CSV reader (RFC 4180: quoted fields, doubled quotes, CRLF or LF), shared by the server's customer
 * sheets and the price import page. Reads what Excel saves, including its byte-order mark.
 */

/** Text -> rows of cells, as written. */
export function parseCsvRows(text) {
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
  return rows;
}

/** Text -> [{ column: value }], with the header row's names trimmed. Blank lines are skipped. */
export function parseCsv(text) {
  const [head, ...body] = parseCsvRows(text).filter(r => r.some(v => v.trim() !== ''));
  if (!head) return [];
  const cols = head.map(h => h.trim());
  return body.map(r => Object.fromEntries(cols.map((c, i) => [c, (r[i] ?? '').trim()])));
}
