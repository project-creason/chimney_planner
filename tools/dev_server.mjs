/**
 * The site and the API on one port, the way Vercel serves them:  npm run dev  -> http://localhost:3000
 * With TURSO_DATABASE_URL set, /api/* runs the Vercel handler (api/_handler.js) against Turso;
 * without it, the local database file from npm run db:import.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { ROOT, connect, migrate } from '../server/db/connect.mjs';
import { createApp } from '../server/app.mjs';

const WEB = resolve(ROOT, 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

let api;
if (process.env.TURSO_DATABASE_URL) api = (await import('../api/_handler.js')).default;
else { const db = connect(); await migrate(db); api = createApp({ db }); }

const port = Number(process.env.PORT) || 3000;
createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (path.startsWith('/api/') || path.startsWith('/logos/')) return api(req, res);
  const file = resolve(WEB, '.' + (path.endsWith('/') ? path + 'index.html' : path));
  if (!file.startsWith(WEB + sep)) { res.writeHead(404); return res.end('Not found'); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, () => console.log(`Site and API on http://localhost:${port} (${process.env.TURSO_DATABASE_URL ? 'Turso' : 'local database'})`));
