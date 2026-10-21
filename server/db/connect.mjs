/**
 * Opens the database. On Turso set TURSO_DATABASE_URL (libsql://...) and TURSO_AUTH_TOKEN;
 * without them a local file is used, which needs no account or network.
 */
import { createClient } from '@libsql/client';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '../..');
export const DEFAULT_URL = `file:${resolve(ROOT, 'data/chimney.db')}`;

export function connect(url = process.env.TURSO_DATABASE_URL || DEFAULT_URL, authToken = process.env.TURSO_AUTH_TOKEN) {
  if (url.startsWith('file:') && url !== 'file::memory:') mkdirSync(dirname(url.slice(5)), { recursive: true });
  return createClient({ url, ...(authToken ? { authToken } : {}) });
}

/** Creates any missing tables. Safe to run on every start. */
export async function migrate(db) {
  const sql = readFileSync(resolve(HERE, 'schema.sql'), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  const stmts = sql.split(';').map(s => s.trim()).filter(Boolean);
  await db.batch(stmts, 'write');
}
