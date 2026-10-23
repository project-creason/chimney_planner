/**
 * Reads the cell text of an Excel .xlsx file, enough for a price sheet: every sheet's name and its rows of
 * cells as strings. No formatting, formulas are read as their saved results. No library: an .xlsx is a zip of
 * XML files, unzipped here with the browser's (or Node's) DecompressionStream.
 *
 *   readXlsx(arrayBuffer) -> [{ name, rows: [[cell, ...], ...] }]
 */

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** zip -> Map(path -> () => Promise<string>), reading only the files asked for. */
function unzip(buf) {
  const bytes = new Uint8Array(buf), view = new DataView(buf);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('This is not an Excel .xlsx file (or it is damaged). Save it as .xlsx or .csv and try again.');
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const files = new Map(), text = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('The .xlsx file is damaged.');
    const method = view.getUint16(p + 10, true), size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = text.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    files.set(name, async () => {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + size);
      if (method === 0) return text.decode(data);
      if (method === 8) return text.decode(await inflate(data));
      throw new Error(`The .xlsx file uses a compression this page can't read (method ${method}). Save it as .csv instead.`);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unescape = s => s.replace(/&(lt|gt|quot|apos|amp|#x[0-9a-f]+|#\d+);/gi, (_, e) => (
  { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e.toLowerCase()]
  ?? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))));
const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
/** All the <t> text inside a piece of XML, joined (rich text splits one string into several runs). */
const texts = xml => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => unescape(m[1])).join('');
const colIndex = ref => [...ref.replace(/\d+$/, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
/** 24.989999999999998 -> "24.99": Excel keeps 15 significant digits. */
const number = v => (v.trim() === '' || Number.isNaN(Number(v)) ? v : String(Number(Number(v).toPrecision(15))));

export async function readXlsx(buf) {
  const files = unzip(buf);
  const read = async path => (files.has(path) ? files.get(path)() : '');
  const shared = [...(await read('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => texts(m[1]));
  const rels = new Map([...(await read('xl/_rels/workbook.xml.rels')).matchAll(/<Relationship\b[^>]*>/g)]
    .map(m => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const sheets = [];
  for (const m of (await read('xl/workbook.xml')).matchAll(/<sheet\b[^>]*>/g)) {
    const target = rels.get(attr(m[0], 'r:id')) || '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const rows = [];
    for (const c of (await read(path)).matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1], 'r');
      if (!ref) continue;
      const type = attr(c[1], 't'), body = c[2] || '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value;
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = texts(body);
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'str' || type === 'e') value = unescape(v ?? '');
      else value = number(unescape(v ?? ''));
      const r = Number(ref.match(/\d+$/)[0]) - 1, col = colIndex(ref);
      while (rows.length <= r) rows.push([]);
      while (rows[r].length < col) rows[r].push('');
      rows[r][col] = value;
    }
    sheets.push({ name: unescape(attr(m[0], 'name') || `Sheet ${sheets.length + 1}`), rows });
  }
  return sheets;
}
