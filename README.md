# Chimney Planner

Enter details about a home and a wood stove or factory-built fireplace, and get a complete chimney parts list
that follows the chimney maker's instructions and NFPA 211. Two product lines are loaded: Duravent DuraTech and
ICC EXCEL (both 5"–8"); the page has a picker to switch between them. Adding a line is data only: see
`catalog/README.md`.

The same page runs two ways. Where it is served with the planner API (on Vercel), every plan is worked out by the
server from the database (SQLite, hosted on Turso). Where there is no API (GitHub Pages, a plain static server), it
loads the catalog as JSON and runs the engine in the browser. Both use the same planner engine and must give identical
plans; the results say which one made the plan ("worked out by the planning server" or "in this browser").

## Folders

| Folder | What it holds |
|---|---|
| `catalog/` | The editable source: each product line's parts and rules as CSV files. See `catalog/README.md`. |
| `tools/build_catalog.py` | Checks the CSVs and builds `web/catalog/*.json`. Python 3, standard library only. |
| `web/` | The website itself. This folder is what gets hosted. |
| `customers/` | Retailers' and distributors' own part numbers and prices. Only the made-up `DEMO` is committed. See `customers/README.md`. |
| `server/` | The API and database: `schema.sql`, CSV import and export, customer pricing, and the HTTP server. |
| `api/` | The API as Vercel functions (`/api/lines`, `/api/plan`, `/api/customer`, `/api/health`, `/api/admin/*`), all running `server/app.mjs`. |
| `tests/` | Automated tests for the planner and the form, plus 282 recorded plans per product line that every change must reproduce. |
| `server/tests/` | Database and API tests (need `npm install`). |

## Common tasks

```sh
npm run build:catalog   # after editing any CSV in catalog/
npm install             # once, for the database client
npm test                # run all the tests (Node 22+)
npm run db:import       # check the CSVs and load them into the database (data/chimney.db unless TURSO_DATABASE_URL is set)
npm run db:export -- DIR   # write the database back out as CSVs in the catalog/ layout
npm run customer:import -- customers/DEMO   # check and load a customer's SKUs and prices; prints its private link key
npm run customer:export -- DEMO DIR         # write a customer's sheets back out
npm run server          # API on http://localhost:8787 (POST /api/plan, GET /api/lines)
npm run dev             # site + API together on http://localhost:3000, as Vercel serves them
npm run check:api -- URL   # send every line's recorded scenarios to a running API and compare
node tools/make_golden.mjs [LINE]   # re-record a line's 282 plans (default DT), only when they are meant to change
cd web && python3 -m http.server 8000   # try it at http://localhost:8000
```

Opening `web/index.html` by double-clicking won't work: the browser blocks it from loading its own files from disk.

## Database (Turso)

Without settings, the server and import use a local file, `data/chimney.db`. To use Turso, set
`TURSO_DATABASE_URL` (`libsql://...`) and `TURSO_AUTH_TOKEN`, then run `npm run db:import`. The import replaces
the catalog and rules as a whole; customer tables (part numbers, prices, stricter rules) are never touched by it.

Distributors' price sheets, in whatever layout they come, are loaded on `/admin.html` (needs `ADMIN_PASSWORD`
set on the server; see `customers/README.md`). A customer's private link, `/?customer=<key>`, shows the plan with their SKUs, prices and a subtotal, and adds a
"Download order" button (a CSV with SKU, manufacturer part number, quantity, unit price and line total). Only the
server has customer data, so the GitHub Pages copy shows no prices.

## Hosting

**Vercel (site + API):** `vercel.json` serves `web/` as the site and `api/` as the server, on the free Hobby plan.
In Vercel choose **Add New → Project**, import this repository and leave the build settings as they are. Under
**Settings → Environment Variables** add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` (a read-only Turso token is
enough; the site never writes), then redeploy. Every push to a pull request's branch after the import gets its own preview address
(open it from **Deployments**); the production address shows `main`.

The `web/` folder on its own is a static site and works on any static host (GitHub Pages, Netlify, Cloudflare
Pages); there it plans in the browser.

**GitHub Pages:** in this repository go to **Settings → Pages → Build and deployment** and set **Source** to
**GitHub Actions**. Every push to `main` then rebuilds the catalog, runs the tests, and publishes `web/`.
Pages on a private repository needs a paid GitHub plan; on a free plan, make the repository public or use Netlify.

**Google Sites:** host the site first, then in Google Sites use **Insert → Embed → By URL** with the site's address.
