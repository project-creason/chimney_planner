/**
 * Price sheet import page (admin.html). Reads the file in the browser, guesses its layout (price-columns.js),
 * and sends only the chosen columns to the server, which matches them to the catalog: first as a preview, then,
 * on Import, for real (POST /api/admin/price-import, see server/app.mjs). Needs the planning server.
 */
import { parseCsvRows } from './csv.js';
import { readXlsx } from './xlsx-lite.js';
import { FIELDS, findHeaderRow, guessColumns, priceColumns } from './price-columns.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PASS_KEY = 'chimney-planner/admin-password';
const NEW = '__new__';
const LABELS = { part: 'Manufacturer part number', sku: 'Customer part number (SKU)', price: 'Customer price', description: 'Customer description' };
const HINTS = { part: 'Required: matches each row to the catalog', sku: 'Optional: shown on their plans and orders',
  price: 'Optional: the selling price plans show', description: 'Optional: replaces ours on their orders' };

let password = '';
let customers = [];
let catalogCodes = [];
let fileName = '';
let sheets = [];          // [{ name, rows }]
let sheetIdx = 0;
let headerIdx = 0;
let cols = { part: null, sku: null, price: null, description: null };
let previewSeq = 0;
let previewTimer = null;
let lastPreview = null;

// ------------------------------------------------------------------ server
async function api(path, body) {
  let r;
  try {
    r = await fetch(`api/admin/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${password}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new Error('The planning server could not be reached. Check your connection.'); }
  if (!(r.headers.get('content-type') || '').includes('application/json')) {
    throw Object.assign(new Error('This copy of the site has no planning server, so it cannot import prices. Use the Vercel site.'), { status: 0 });
  }
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error || `The server answered ${r.status}.`), { status: r.status });
  return j;
}

async function signIn(pass) {
  password = pass;
  const msg = $('#signInMsg');
  msg.innerHTML = '';
  try {
    const j = await api('customers');
    customers = j.customers;
    catalogCodes = j.catalog.flatMap(p => [p.order_number, p.stock_number]).filter(Boolean);
    try { sessionStorage.setItem(PASS_KEY, pass); } catch { /* private window */ }
    $('#signIn').hidden = true;
    $('#work').hidden = false;
    fillCustomers();
  } catch (e) {
    try { sessionStorage.removeItem(PASS_KEY); } catch { /* private window */ }
    msg.innerHTML = `<div class="banner crit"><p>${esc(e.message)}</p></div>`;
  }
}

// ------------------------------------------------------------------ customer
function fillCustomers(selected) {
  const sel = $('#customer');
  sel.innerHTML = customers.map(c => `<option value="${esc(c.code)}">${esc(c.name)} (${esc(c.code)})</option>`).join('') +
    `<option value="${NEW}">New customer…</option>`;
  sel.value = selected ?? (customers[0]?.code || NEW);
  customerChanged();
}
const currentCustomer = () => customers.find(c => c.code === $('#customer').value) || null;

function customerChanged() {
  const c = currentCustomer();
  document.querySelectorAll('[data-new]').forEach(el => { el.hidden = !!c; });
  $('#customerLists').innerHTML = c
    ? (c.price_lists.length
      ? `Price lists: ${c.price_lists.map(l => `<b>${esc(l.name)}</b> (${l.prices} prices, ${esc(l.currency)}, from ${esc(l.effective_from || 'always')}${l.effective_to ? ` to ${esc(l.effective_to)}` : ''})`).join(' · ')}`
      : 'No price lists yet.')
    : '';
  if (sheets.length) applyLayout();
  schedulePreview();
}

// ------------------------------------------------------------------ file
async function loadFile(file) {
  const msg = $('#fileMsg');
  msg.innerHTML = '';
  $('#result').innerHTML = '';
  fileName = file.name;
  try {
    if (/\.xlsx$/i.test(file.name)) sheets = await readXlsx(await file.arrayBuffer());
    else if (/\.(csv|txt)$/i.test(file.name)) sheets = [{ name: file.name, rows: parseCsvRows(await file.text()) }];
    else throw new Error('Choose an Excel .xlsx or a .csv file. For an old .xls, open it in Excel and save it as .xlsx.');
    sheets = sheets.filter(s => s.rows.some(r => r.some(v => String(v).trim())));
    if (!sheets.length) throw new Error('The file has no rows.');
  } catch (e) {
    sheets = [];
    msg.innerHTML = `<div class="banner crit"><p>${esc(e.message)}</p></div>`;
    for (const id of ['#sheetField', '#headerField', '#columnsCard', '#listCard', '#previewCard']) $(id).hidden = true;
    return;
  }
  // start on the sheet whose part number column matches the most catalog parts
  const score = s => {
    const h = findHeaderRow(s.rows), body = s.rows.slice(h + 1), g = guessColumns(s.rows[h] || [], body, catalogCodes);
    return g.part === null ? 0 : matchCount(body, g.part);
  };
  const scores = sheets.map(score);
  sheetIdx = scores.indexOf(Math.max(...scores));
  const saved = currentCustomer()?.import_layout;
  if (saved?.sheet && sheets.some(s => s.name === saved.sheet)) sheetIdx = sheets.findIndex(s => s.name === saved.sheet);
  $('#sheet').innerHTML = sheets.map((s, i) => `<option value="${i}">${esc(s.name)} (${s.rows.length} rows)</option>`).join('');
  $('#sheetField').hidden = sheets.length < 2;
  if (!$('#listName').value) $('#listName').value = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').slice(0, 60);
  if (!$('#from').value) $('#from').value = new Date().toISOString().slice(0, 10);
  sheetChanged();
}

const codeSet = () => new Set(catalogCodes.map(c => String(c).toUpperCase().replace(/[^A-Z0-9]/g, '')));
function matchCount(body, col) {
  const codes = codeSet();
  return body.filter(r => codes.has(String(r[col] ?? '').split(/[:|]/).pop().toUpperCase().replace(/[^A-Z0-9]/g, ''))).length;
}

function sheetChanged() {
  sheetIdx = Number($('#sheet').value || sheetIdx);
  $('#sheet').value = String(sheetIdx);
  const rows = sheets[sheetIdx].rows;
  headerIdx = findHeaderRow(rows);
  $('#headerRow').innerHTML = rows.slice(0, 15).map((r, i) =>
    `<option value="${i}">Row ${i + 1}: ${esc(r.filter(v => String(v).trim()).slice(0, 4).join(' · ').slice(0, 70) || '(blank)')}</option>`).join('');
  $('#headerField').hidden = false;
  applyLayout();
}

/** Guesses the columns, then lays the customer's saved choices over the guesses where their headers are found. */
function applyLayout() {
  const rows = sheets[sheetIdx].rows;
  const saved = currentCustomer()?.import_layout;
  if (saved?.sheet === sheets[sheetIdx].name && Number.isInteger(saved.header_row) && saved.header_row < rows.length) headerIdx = saved.header_row;
  $('#headerRow').value = String(headerIdx);
  const headers = rows[headerIdx] || [];
  cols = guessColumns(headers, rows.slice(headerIdx + 1), catalogCodes);
  if (saved?.headers) {
    for (const f of FIELDS) {
      if (!(f in saved.headers)) continue;
      const i = saved.headers[f] === null ? -1 : headers.findIndex(h => String(h).trim() === saved.headers[f]);
      if (saved.headers[f] === null) cols[f] = null; else if (i >= 0) cols[f] = i;
    }
    $('#stripPrefix').value = saved.strip_prefix || '';
    $('#prefixBox').open = !!saved.strip_prefix;
  }
  renderColumns();
}

function headerChanged() {
  headerIdx = Number($('#headerRow').value);
  const rows = sheets[sheetIdx].rows;
  cols = guessColumns(rows[headerIdx] || [], rows.slice(headerIdx + 1), catalogCodes);
  renderColumns();
}

const colName = i => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

function renderColumns() {
  const rows = sheets[sheetIdx].rows, headers = rows[headerIdx] || [];
  const width = rows.slice(headerIdx, headerIdx + 200).reduce((w, r) => Math.max(w, r.length), 0);
  const options = Array.from({ length: width }, (_, i) => `<option value="${i}">${colName(i)}: ${esc(String(headers[i] ?? '').trim() || '(no header)')}</option>`).join('');
  $('#columns').innerHTML = FIELDS.map(f => `
    <div class="field"><label for="col-${f}">${LABELS[f]}</label>
      <select id="col-${f}" data-field="${f}">${f === 'part' ? '' : '<option value="">Not in this sheet</option>'}${options}</select>
      <small>${HINTS[f]}</small></div>`).join('');
  for (const f of FIELDS) {
    const sel = $(`#col-${f}`);
    sel.value = cols[f] === null ? '' : String(cols[f]);
    sel.addEventListener('change', () => { cols[f] = sel.value === '' ? null : Number(sel.value); renderSheetPreview(); schedulePreview(); });
  }
  for (const id of ['#columnsCard', '#listCard', '#previewCard']) $(id).hidden = false;
  renderSheetPreview();
  schedulePreview();
}

function renderSheetPreview() {
  const rows = sheets[sheetIdx].rows, headers = rows[headerIdx] || [];
  const body = rows.slice(headerIdx + 1).filter(r => r.some(v => String(v).trim())).slice(0, 6);
  const width = Math.min(12, [headers, ...body].reduce((w, r) => Math.max(w, r.length), 0));
  const fieldOf = i => FIELDS.find(f => cols[f] === i);
  const idx = Array.from({ length: width }, (_, i) => i);
  const moneyCols = priceColumns(headers, rows.slice(headerIdx + 1));
  const cell = (v, i) => {
    const n = parsePriceCell(v);
    return moneyCols.has(i) && n !== null ? `<td class="money${fieldOf(i) ? ' picked' : ''}">${dollars(n)}</td>` : `<td class="${fieldOf(i) ? 'picked' : ''}">${esc(v ?? '')}</td>`;
  };
  $('#sheetPreview').innerHTML = `<thead><tr>${idx.map(i => `<th class="${fieldOf(i) ? 'picked' : ''}">${colName(i)} ${esc(headers[i] ?? '')}${fieldOf(i) ? `<br>→ ${LABELS[fieldOf(i)]}` : ''}</th>`).join('')}</tr></thead>
    <tbody>${body.map(r => `<tr>${idx.map(i => cell(r[i], i)).join('')}</tr>`).join('')}</tbody>`;
}

// ------------------------------------------------------------------ preview and import
/** Only the chosen columns go to the server, with each row's number as Excel shows it. */
function sheetRows() {
  const rows = sheets[sheetIdx].rows;
  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i], part = cols.part === null ? '' : String(r[cols.part] ?? '').trim();
    if (!part) continue;
    const row = { n: i + 1, part };
    for (const f of ['sku', 'price', 'description']) if (cols[f] !== null) row[f] = r[cols[f]] ?? '';
    out.push(row);
  }
  return out;
}

/**
 * A new customer's short internal ID, made from its name (Acme Hearth Supply -> ACMEHEARTH): the database key and
 * the order file name. Never typed or shown; a number is added when the ID is already taken.
 */
function newCode() {
  const base = ($('#newName').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16) || 'CUSTOMER').padEnd(2, 'X');
  let code = base;
  for (let i = 2; customers.some(x => x.code === code); i++) code = `${base}${i}`;
  return code;
}

function request(commit) {
  const c = currentCustomer();
  const headers = sheets[sheetIdx].rows[headerIdx] || [];
  return {
    commit,
    customer: c ? { code: c.code } : { code: newCode(), name: $('#newName').value.trim(), vertical: $('#newVertical').value },
    price_list: { name: $('#listName').value.trim(), currency: $('#currency').value.trim().toUpperCase(),
      effective_from: $('#from').value || null, effective_to: $('#to').value || null },
    strip_prefix: $('#stripPrefix').value.trim(),
    rows: sheetRows(),
    layout: { sheet: sheets[sheetIdx].name, header_row: headerIdx, strip_prefix: $('#stripPrefix').value.trim(),
      headers: Object.fromEntries(FIELDS.map(f => [f, cols[f] === null ? null : String(headers[cols[f]] ?? '').trim()])) },
  };
}

function schedulePreview() {
  if (!sheets.length || cols.part === null) return;
  clearTimeout(previewTimer);
  $('#import').disabled = true;
  previewTimer = setTimeout(runPreview, 350);
}

async function runPreview() {
  const seq = ++previewSeq;
  try {
    const r = await api('price-import', request(false));
    if (seq !== previewSeq) return;
    lastPreview = r;
    renderPreview(r);
  } catch (e) {
    if (seq !== previewSeq) return;
    lastPreview = null;
    $('#preview').innerHTML = `<div class="banner crit"><p>${esc(e.message)}</p></div>`;
    if (e.status === 401) signOut();
  }
  updateImportButton();
}

/** 74.1965 -> $74.20 (in the price list's currency when it isn't dollars). */
function dollars(v) {
  if (v == null) return '';
  const currency = /^[A-Z]{3}$/.test($('#currency').value.trim().toUpperCase()) ? $('#currency').value.trim().toUpperCase() : 'USD';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Math.round(v * 100) / 100); }
  catch { return `${v.toFixed(2)} ${currency}`; }
}
const money = dollars;
/** A sheet cell as a number, or null: "$1,234.50" and "74.1965" read, "662492006566" (a UPC) does not. */
const parsePriceCell = v => {
  const t = String(v ?? '').trim().replace(/[$,\s]/g, '');
  return /^\d{1,7}(\.\d+)?$/.test(t) ? Number(t) : null;
};
const table = (head, rows) => `<div class="table-wrap"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
const more = (shown, total) => (total > shown ? `<p class="hint" style="margin:6px 0 0">Showing the first ${shown} of ${total}.</p>` : '');

function renderPreview(r) {
  const stat = (n, label, cls = '') => `<div class="stat ${cls}"><b>${n}</b><span>${label}</span></div>`;
  const catalogTotal = r.with_price + r.catalog_without_price;
  const parts = [];
  if (r.suggestion) {
    parts.push(`<div class="banner warn" style="margin-bottom:10px"><p>${r.suggestion.rows} part numbers start with an extra code, <b>${esc(r.suggestion.prefix)}</b>, and match our catalog once it's taken off.
      <button class="btn" type="button" id="usePrefix">Ignore ${esc(r.suggestion.prefix)}</button></p></div>`);
  }
  parts.push(`<div class="stats">
    ${stat(r.matched, `of ${r.rows} rows match catalog parts`, r.matched ? 'good' : 'bad')}
    ${cols.price !== null ? stat(r.with_price, 'prices to import', r.with_price ? 'good' : 'bad') : ''}
    ${cols.sku !== null ? stat(r.with_sku, 'customer part numbers to import') : ''}
    ${cols.price !== null ? stat(r.catalog_without_price, `catalog parts still without a price (of ${catalogTotal})`, r.catalog_without_price ? 'bad' : 'good') : ''}
  </div>`);
  if (r.loose || r.by_stock_number) {
    parts.push(`<p class="hint">${[r.loose ? `${r.loose} matched after ignoring case, spaces, punctuation or a "Vendor:" prefix` : '',
      r.by_stock_number ? `${r.by_stock_number} matched by stock number` : ''].filter(Boolean).join('; ')}. Check a few below.</p>`);
  }
  parts.push(table(['Row', 'In the sheet', 'Manufacturer part', 'Customer SKU', 'Customer price', 'Customer description'], r.sample.slice(0, 12).map(m => `<tr>
    <td class="num">${m.n}</td><td class="code">${esc(sheetPart(m.n))}</td><td class="code">${esc(m.order_number)}${m.loose ? ' <span class="tag" title="Matched after ignoring case, spaces, punctuation or a code in front such as DuraVent:">near match</span>' : ''}${m.via === 'stock' ? ' <span class="tag" title="Matched by the manufacturer\'s stock number">by stock #</span>' : ''}</td>
    <td class="code">${esc(m.sku ?? '')}</td><td class="num">${money(m.price)}</td><td>${esc(m.description ?? '')}</td></tr>`)));
  parts.push(more(Math.min(12, r.sample.length), r.matched));
  if (r.catalog_without_price && cols.price !== null) {
    parts.push(`<details><summary>Catalog parts this sheet doesn't price (${r.catalog_without_price})</summary>
      <p class="hint" style="margin:6px 0 0">Plans show these as "no price". Often a part number that changed since the sheet was made.</p>
      <p class="hint" style="font-family:var(--font-mono)">${r.catalog_without_price_parts.map(p => esc(p.order_number)).join(' · ')}</p>
      ${more(r.catalog_without_price_parts.length, r.catalog_without_price)}</details>`);
  }
  if (r.no_price) {
    parts.push(`<details><summary>Matched rows whose price can't be read (${r.no_price})</summary>
      ${table(['Row', 'Catalog part', 'Price cell'], r.no_price_rows.map(x => `<tr><td class="num">${x.n}</td><td class="code">${esc(x.order_number)}</td><td>${esc(x.value)}</td></tr>`))}
      ${more(r.no_price_rows.length, r.no_price)}</details>`);
  }
  if (r.duplicates) {
    parts.push(`<details><summary>Parts listed more than once (${r.duplicates}): the first row is used</summary>
      ${table(['Row', 'Catalog part', 'First on row'], r.duplicate_rows.map(x => `<tr><td class="num">${x.n}</td><td class="code">${esc(x.order_number)}</td><td class="num">${x.first}</td></tr>`))}
      ${more(r.duplicate_rows.length, r.duplicates)}</details>`);
  }
  if (r.unmatched) {
    parts.push(`<details><summary>Rows that aren't catalog parts (${r.unmatched}): skipped</summary>
      <p class="hint" style="margin:6px 0 0">Usually other products on the sheet. Nothing is guessed.</p>
      ${table(['Row', 'In the sheet', 'Why'], r.unmatched_rows.map(x => `<tr><td class="num">${x.n}</td><td class="code">${esc(x.part)}</td><td>${esc(x.reason)}</td></tr>`))}
      ${more(r.unmatched_rows.length, r.unmatched)}</details>`);
  }
  $('#preview').innerHTML = parts.join('');
  $('#usePrefix')?.addEventListener('click', () => { $('#stripPrefix').value = r.suggestion.prefix; $('#prefixBox').open = true; schedulePreview(); });
}
const sheetPart = n => String(sheets[sheetIdx].rows[n - 1]?.[cols.part] ?? '');

function updateImportButton() {
  const c = currentCustomer(), r = lastPreview;
  const problems = [];
  if (!r || !r.matched) problems.push('no rows match the catalog yet');
  if (!c && !$('#newName').value.trim()) problems.push('give the new customer a name');
  if (!c && customers.some(x => x.name.toLowerCase() === $('#newName').value.trim().toLowerCase())) problems.push('a customer with that name exists: pick it above');
  if (cols.price !== null && !$('#listName').value.trim()) problems.push('name the price list');
  const replacing = c?.price_lists.find(l => l.name === $('#listName').value.trim());
  $('#import').disabled = problems.length > 0;
  $('#importNote').textContent = problems.length ? `To import: ${problems.join(', ')}.`
    : replacing && cols.price !== null ? `Replaces the ${replacing.prices} prices in "${replacing.name}".` : '';
}

async function runImport() {
  const btn = $('#import');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    const sent = request(true);
    const r = await api('price-import', sent);
    const code = sent.customer.code;
    const name = sent.customer.name || currentCustomer()?.name || code;
    const link = r.saved.key ? `${location.origin}${location.pathname.replace(/admin\.html$/, '')}?customer=${r.saved.key}` : null;
    $('#result').innerHTML = `<div class="banner ok"><p><strong>Imported.</strong> ${r.saved.prices} prices and ${r.saved.skus} customer part numbers saved for ${esc(name)}.
      The column choices are remembered for this customer's next sheet.</p>
      ${link ? `<p style="margin-top:8px"><b>${esc(name)}'s private planner link.</b> It is shown only this once: copy it now and send it to them privately.</p>
        <div class="link"><code id="newLink">${esc(link)}</code><button class="btn" type="button" id="copyLink">Copy</button></div>` : ''}</div>`;
    $('#copyLink')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link); $('#copyLink').textContent = 'Copied'; }
      catch { getSelection().selectAllChildren($('#newLink')); }
    });
    customers = (await api('customers')).customers;
    fillCustomers(code);
  } catch (e) {
    $('#result').innerHTML = `<div class="banner crit"><p>${esc(e.message)}</p></div>`;
    if (e.status === 401) signOut();
  } finally {
    btn.textContent = 'Import';
    updateImportButton();
  }
}

function signOut() {
  try { sessionStorage.removeItem(PASS_KEY); } catch { /* private window */ }
  $('#work').hidden = true;
  $('#signIn').hidden = false;
  $('#signInMsg').innerHTML = '<div class="banner crit"><p>Please sign in again.</p></div>';
}

// ------------------------------------------------------------------ wiring
$('#signInForm').addEventListener('submit', e => { e.preventDefault(); signIn($('#password').value); });
$('#customer').addEventListener('change', customerChanged);
$('#file').addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); });
$('#sheet').addEventListener('change', sheetChanged);
$('#headerRow').addEventListener('change', headerChanged);
$('#stripPrefix').addEventListener('input', schedulePreview);
$('#import').addEventListener('click', runImport);
for (const id of ['#newName', '#listName', '#currency', '#from', '#to']) $(id).addEventListener('input', updateImportButton);
let saved = '';
try { saved = sessionStorage.getItem(PASS_KEY) || ''; } catch { /* private window */ }
if (saved) signIn(saved);
