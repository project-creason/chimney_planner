/**
 * Loads the CSV catalog into the database:  npm run db:import [-- --catalog DIR]
 * Runs the same checks as the website build (tools/build_catalog.py) first; if they fail, nothing is written.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect, migrate, ROOT } from './connect.mjs';
import { writeCatalog } from './catalog-store.mjs';

/** Validates a catalog folder and returns the build ({ index, lines }); throws with the build's messages on failure. */
export function buildCatalog(catalogDir = resolve(ROOT, 'catalog')) {
  const out = mkdtempSync(join(tmpdir(), 'catalog-build-'));
  try {
    execFileSync('python3', [resolve(ROOT, 'tools/build_catalog.py'), '--catalog', catalogDir, '--out', out],
      { encoding: 'utf8', stdio: 'pipe' });
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    const lines = Object.fromEntries(Object.entries(index.line_files)
      .map(([code, file]) => [code, JSON.parse(readFileSync(join(out, file), 'utf8'))]));
    return { index, lines };
  } catch (e) {
    throw new Error(`Catalog check failed; nothing was imported.\n${e.stdout || e.message}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export async function importCatalog(db, catalogDir) {
  const build = buildCatalog(catalogDir);
  await migrate(db);
  return writeCatalog(db, build, catalogDir || 'catalog');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--catalog');
  const dir = i > 0 ? resolve(process.argv[i + 1]) : undefined;
  const db = connect();
  try {
    const summary = await importCatalog(db, dir);
    console.log(`Imported. Parts per line: ${JSON.stringify(summary)}`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
