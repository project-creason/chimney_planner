# DuraTech Chimney Planner

Enter details about a home and a wood stove or factory-built fireplace, and get a complete Duravent
DuraTech (5"–8") chimney parts list that follows Duravent's instructions and NFPA 211.

The live site runs in the browser: plain HTML and JavaScript plus the catalog as JSON. A server version is in
`server/`: the catalog and rules live in a database (SQLite, hosted on Turso) and the browser asks the server for
the parts list, so the rules aren't visible in the page. Both use the same planner engine and must give identical plans.

## Folders

| Folder | What it holds |
|---|---|
| `catalog/` | The editable source: Duravent catalog data and rules as CSV files. See `catalog/README.md`. |
| `tools/build_catalog.py` | Checks the CSVs and builds `web/catalog/*.json`. Python 3, standard library only. |
| `web/` | The website itself. This folder is what gets hosted. |
| `server/` | The API and database: `schema.sql`, CSV import and export, and the HTTP server. |
| `tests/` | Automated tests for the planner and the form, plus 282 recorded plans every change must reproduce. |
| `server/tests/` | Database and API tests (need `npm install`). |

## Common tasks

```sh
npm run build:catalog   # after editing any CSV in catalog/
npm install             # once, for the database client
npm test                # run all the tests (Node 22+)
npm run db:import       # check the CSVs and load them into the database (data/chimney.db unless TURSO_DATABASE_URL is set)
npm run db:export -- DIR   # write the database back out as CSVs in the catalog/ layout
npm run server          # API on http://localhost:8787 (POST /api/plan, GET /api/lines)
node tools/make_golden.mjs # re-record the 282 plans, only when a plan is meant to change
cd web && python3 -m http.server 8000   # try it at http://localhost:8000
```

Opening `web/index.html` by double-clicking won't work: the browser blocks it from loading its own files from disk.

## Database (Turso)

Without settings, the server and import use a local file, `data/chimney.db`. To use Turso, set
`TURSO_DATABASE_URL` (`libsql://...`) and `TURSO_AUTH_TOKEN`, then run `npm run db:import`. The import replaces
the catalog and rules as a whole; customer tables (part numbers, prices, stricter rules) are never touched by it.

## Hosting

The `web/` folder is a static site and works on any static host (GitHub Pages, Netlify, Cloudflare Pages).

**GitHub Pages:** in this repository go to **Settings → Pages → Build and deployment** and set **Source** to
**GitHub Actions**. Every push to `main` then rebuilds the catalog, runs the tests, and publishes `web/`.
Pages on a private repository needs a paid GitHub plan; on a free plan, make the repository public or use Netlify.

**Google Sites:** host the site first, then in Google Sites use **Insert → Embed → By URL** with the site's address.
