/**
 * HTTP API for the planner. The catalog and rules stay on the server; the browser sends answers
 * and gets back the parts list.
 *
 *   GET  /api/health
 *   GET  /api/lines                 active product lines with manufacturer name, logo, sizes, finishes and the
 *                                   elbow offset chart (the form offers only the shifts the chart makes)
 *   POST /api/plan   { spec }       -> { manufacturer, line, plan }   (spec = ChimneySpec, see web/js/engine/spec.js)
 *                                   with an X-Customer-Key header, also `order`: the parts at that customer's SKUs
 *                                   and prices (see server/pricing.mjs)
 *   GET  /api/customer              the customer an X-Customer-Key belongs to, and its current price list
 *   GET  /api/admin/customers       customers (price lists, saved import layouts) and catalog numbers } with Authorization:
 *   POST /api/admin/price-import    match a price sheet's rows to the catalog; saves with commit } Bearer <ADMIN_PASSWORD>
 *   GET  /logos/<file>              manufacturer logos from catalog/logos/
 */
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCatalog } from '../web/js/engine/catalog.js';
import { planChimney } from '../web/js/engine/planner.js';
import { readCatalog } from './db/catalog-store.mjs';
import { catalogPartsWithStock, customerByKey, customerPricing, listCustomers, writePriceImport } from './db/customer-store.mjs';
import { priceOrder } from './pricing.mjs';
import { matchSheet } from './price-import.mjs';

// Not imported from db/connect.mjs, so a host can hand in its own database client (see api/_handler.js).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MAX_BODY = 100_000;
const MAX_ADMIN_BODY = 4_000_000;    // a whole distributor price sheet; Vercel refuses bodies over 4.5 MB
const MAX_SHEET_ROWS = 50_000;
const LIST_CAP = 500;                // rows listed per kind in a preview; the counts are always complete
const LOGO_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** Keeps the catalog in memory and reloads it when a newer import lands. */
function catalogCache(db) {
  let importId = null, loaded = null;
  return async () => {
    const row = (await db.execute('SELECT max(id) AS id FROM catalog_imports')).rows[0];
    const id = row?.id ?? null;
    if (id == null) throw Object.assign(new Error('The database has no catalog yet. Run npm run db:import.'), { status: 503 });
    if (id !== importId || !loaded) {
      const { index, lines } = await readCatalog(db);
      loaded = { index, lines, catalogs: new Map(Object.entries(lines).map(([c, l]) => [c, makeCatalog(index, l)])) };
      importId = id;
    }
    return loaded;
  };
}

const manufacturerOut = m => m && ({ code: m.code, name: m.name, website: m.website ?? null,
  logo_url: m.logo_file ? `/logos/${encodeURIComponent(m.logo_file)}` : null });

const digest = v => createHash('sha256').update(String(v)).digest();
const fail = (status, message) => Object.assign(new Error(message), { status });

export function createApp({ db, allowedOrigin = process.env.ALLOWED_ORIGIN || '*', adminPassword = process.env.ADMIN_PASSWORD } = {}) {
  const load = catalogCache(db);
  /** Admin routes need Authorization: Bearer <ADMIN_PASSWORD>; with no password set they are switched off. */
  const requireAdmin = async req => {
    if (!adminPassword) throw fail(503, 'The admin pages are switched off: set ADMIN_PASSWORD on the server.');
    const given = /^Bearer (.+)$/.exec(req.headers?.authorization || '')?.[1] || '';
    if (!timingSafeEqual(digest(given), digest(adminPassword))) {
      await new Promise(r => setTimeout(r, 400));   // slows password guessing
      throw fail(401, 'Wrong admin password.');
    }
  };
  /** The customer whose private link the page was opened with; null when there is none; 403 when it's wrong. */
  const customerOf = async req => {
    const key = req.headers?.['x-customer-key'];
    if (!key) return null;
    const c = await customerByKey(db, String(key));
    if (!c) throw Object.assign(new Error('This customer link is not valid. Ask for a new one.'), { status: 403 });
    return c;
  };

  const routes = {
    'GET /api/health': async () => ({ ok: true }),

    'GET /api/lines': async () => {
      const { lines } = await load();
      return Object.values(lines).map(l => ({
        code: l.line.code, name: l.line.name, family: l.line.family,
        manufacturer: manufacturerOut(l.manufacturer),
        sizes: l.sizes.map(s => s.size),
        outer_in: Object.fromEntries(l.sizes.map(s => [s.size, s.outer_in])),
        finishes: [...new Set(l.parts.filter(p => p.category === 'CHIMNEY_PIPE').map(p => p.finish).filter(Boolean))],
        elbow_offsets: l.lookups?.elbow_offsets || [],
      }));
    },

    'GET /api/customer': async (body, req) => {
      const c = await customerOf(req);
      if (!c) throw Object.assign(new Error('Send the customer key in X-Customer-Key.'), { status: 400 });
      const { priceList } = await customerPricing(db, c.code);
      return { code: c.code, name: c.name, price_list: priceList };
    },

    'GET /api/admin/customers': async (body, req) => {
      await requireAdmin(req);
      // the catalog's numbers let the import page spot which column holds part numbers
      const [customers, catalog] = await Promise.all([listCustomers(db), catalogPartsWithStock(db)]);
      return { customers, catalog };
    },

    /**
     * { customer: { code, name, vertical }, price_list: { name, currency, effective_from, effective_to },
     *   rows: [{ n, part, sku, price, description }], strip_prefix, layout, commit }
     * Without commit it only reports what would happen; with it, saves (see writePriceImport).
     */
    'POST /api/admin/price-import': async (body, req) => {
      await requireAdmin(req);
      const rows = body?.rows;
      if (!Array.isArray(rows)) throw fail(400, 'Send the sheet as rows.');
      if (rows.length > MAX_SHEET_ROWS) throw fail(413, `The sheet has more than ${MAX_SHEET_ROWS} rows.`);
      const r = matchSheet(rows, await catalogPartsWithStock(db), { stripPrefix: body.strip_prefix || '' });
      const cap = list => list.slice(0, LIST_CAP);
      const report = {
        rows: rows.length, matched: r.matched.length,
        with_sku: r.matched.filter(m => m.sku).length, with_price: r.matched.filter(m => m.price != null).length,
        loose: r.matched.filter(m => m.loose).length, by_stock_number: r.matched.filter(m => m.via === 'stock').length,
        unmatched: r.unmatched.length, duplicates: r.duplicates.length, no_price: r.noPrice.length,
        catalog_without_price: r.catalogWithoutPrice.length, suggestion: r.suggestion,
        sample: cap(r.matched), unmatched_rows: cap(r.unmatched), duplicate_rows: cap(r.duplicates),
        no_price_rows: cap(r.noPrice), catalog_without_price_parts: cap(r.catalogWithoutPrice),
      };
      if (!body.commit) return report;
      if (!r.matched.length) throw fail(400, 'No rows match the catalog, so there is nothing to import.');
      const saved = await writePriceImport(db, { customer: body.customer || {}, priceList: body.price_list,
        matched: r.matched, layout: body.layout });
      return { ...report, saved };
    },

    'POST /api/plan': async (body, req) => {
      const spec = body?.spec;
      if (!spec || typeof spec !== 'object') throw Object.assign(new Error('Send { "spec": { ... } }.'), { status: 400 });
      const { catalogs } = await load();
      const cat = catalogs.get(spec.line);
      if (!cat) throw Object.assign(new Error(`Unknown product line '${spec.line}'.`), { status: 400 });
      const customer = await customerOf(req);
      const out = { manufacturer: manufacturerOut(cat.manufacturer), line: { code: cat.line.code, name: cat.line.name },
        plan: planChimney(structuredClone(spec), cat) };
      if (customer) {
        out.order = { customer: { code: customer.code, name: customer.name },
          ...priceOrder(out.plan.parts, cat.line.code, await customerPricing(db, customer.code)) };
      }
      return out;
    },
  };

  return async function handle(req, res) {
    const cors = { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Headers': 'Content-Type, X-Customer-Key, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    const send = (status, body, headers = {}) => {
      const isBuf = Buffer.isBuffer(body);
      res.writeHead(status, { ...cors, 'Content-Type': isBuf ? headers['Content-Type'] : 'application/json', ...headers });
      res.end(isBuf ? body : JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'OPTIONS') return send(204, '');
      if (req.method === 'GET' && url.pathname.startsWith('/logos/')) {
        const file = basename(decodeURIComponent(url.pathname.slice(7)));
        const type = LOGO_TYPES[extname(file).toLowerCase()];
        if (!type) return send(404, { error: 'Not found' });
        try {
          return send(200, await readFile(resolve(ROOT, 'catalog/logos', file)), { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
        } catch { return send(404, { error: 'Not found' }); }
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return send(404, { error: 'Not found' });
      let body;
      if (req.method === 'POST') {
        const limit = url.pathname.startsWith('/api/admin/') ? MAX_ADMIN_BODY : MAX_BODY;
        let raw = '';
        if ('body' in req) {
          // Vercel reads the body before the handler runs and parses JSON itself
          try { body = req.body; } catch { return send(400, { error: 'Body must be JSON' }); }
          if (Buffer.isBuffer(body) || typeof body === 'string') { raw = String(body); body = undefined; }
          else if (body == null) raw = '';
        } else {
          for await (const chunk of req) {
            raw += chunk;
            if (raw.length > limit) return send(413, { error: 'Request too large' });
          }
        }
        if (body === undefined) {
          if (raw.length > limit) return send(413, { error: 'Request too large' });
          try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'Body must be JSON' }); }
        }
      }
      return send(200, await route(body, req), { 'Cache-Control': 'no-store' });
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return send(status, { error: status === 500 ? 'Server error' : e.message });
    }
  };
}
