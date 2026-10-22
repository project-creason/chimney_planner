/**
 * The planner API as Vercel functions. Each file in api/ is one route; they all share this handler,
 * which is server/app.mjs talking to Turso. Files starting with _ are not routes.
 *
 * Vercel settings: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (Project → Settings → Environment Variables).
 */
import { createClient } from '@libsql/client/web';
import { createApp } from '../server/app.mjs';

// The web client talks to Turso over HTTPS and needs no native module, which suits serverless hosts.
// Created once per warm instance, so the catalog stays cached between requests.
let handle;
export default function handler(req, res) {
  if (!handle) {
    const url = process.env.TURSO_DATABASE_URL;
    if (!url) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'The server has no database settings yet (TURSO_DATABASE_URL).' }));
    }
    handle = createApp({ db: createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN }) });
  }
  return handle(req, res);
}
