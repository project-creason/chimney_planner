/**
 * HTTP API for the planner. The catalog and rules stay on the server; the browser sends answers
 * and gets back the parts list.
 *
 *   GET  /api/health
 *   GET  /api/lines                 active product lines with manufacturer name, logo, sizes, finishes and the
 *                                   elbow offset chart (the form offers only the shifts the chart makes)
 *   POST /api/plan   { spec }       -> { manufacturer, line, plan }   (spec = ChimneySpec, see web/js/engine/spec.js)
 *   GET  /logos/<file>              manufacturer logos from catalog/logos/
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCatalog } from '../web/js/engine/catalog.js';
import { planChimney } from '../web/js/engine/planner.js';
import { readCatalog } from './db/catalog-store.mjs';

// Not imported from db/connect.mjs, so a host can hand in its own database client (see api/_handler.js).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MAX_BODY = 100_000;
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

export function createApp({ db, allowedOrigin = process.env.ALLOWED_ORIGIN || '*' } = {}) {
  const load = catalogCache(db);

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

    'POST /api/plan': async body => {
      const spec = body?.spec;
      if (!spec || typeof spec !== 'object') throw Object.assign(new Error('Send { "spec": { ... } }.'), { status: 400 });
      const { catalogs } = await load();
      const cat = catalogs.get(spec.line);
      if (!cat) throw Object.assign(new Error(`Unknown product line '${spec.line}'.`), { status: 400 });
      return { manufacturer: manufacturerOut(cat.manufacturer), line: { code: cat.line.code, name: cat.line.name },
        plan: planChimney(structuredClone(spec), cat) };
    },
  };

  return async function handle(req, res) {
    const cors = { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Headers': 'Content-Type',
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
        let raw = '';
        if ('body' in req) {
          // Vercel reads the body before the handler runs and parses JSON itself
          try { body = req.body; } catch { return send(400, { error: 'Body must be JSON' }); }
          if (Buffer.isBuffer(body) || typeof body === 'string') { raw = String(body); body = undefined; }
          else if (body == null) raw = '';
        } else {
          for await (const chunk of req) {
            raw += chunk;
            if (raw.length > MAX_BODY) return send(413, { error: 'Request too large' });
          }
        }
        if (body === undefined) {
          if (raw.length > MAX_BODY) return send(413, { error: 'Request too large' });
          try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'Body must be JSON' }); }
        }
      }
      return send(200, await route(body));
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return send(status, { error: status === 500 ? 'Server error' : e.message });
    }
  };
}
