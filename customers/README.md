# Customers

A customer is a retailer or distributor that sells the parts the planner lists. Each one gets its own part
numbers (SKUs), its own prices and a private link to the planner that shows them.

**Real customers' sheets are not committed.** This repository is public, so `.gitignore` keeps everything here
except this file and the made-up `DEMO` customer. Keep real sheets somewhere private and import them from there.

## Importing a distributor's own price sheet (the easy way)

Open `/admin.html` on the Vercel site and sign in with the admin password (`ADMIN_PASSWORD`, set in Vercel →
Project → Settings → Environment Variables; without it the page is switched off). Upload the sheet as it came,
Excel (.xlsx) or CSV, with any headers:

1. Pick the customer, or create one (it gets its private link when you import).
2. Upload the file. The page picks the sheet, the header row and the columns (manufacturer part number, their SKU,
   price, description); change any that are wrong. A selling price (Sales Price, MSRP, List) is preferred over cost.
3. Name the price list and the date it takes effect.
4. Check the preview: how many rows match catalog parts, which catalog parts still have no price, which rows were
   skipped and why. Part numbers match exactly, then ignoring case and punctuation, then after a `Vendor:` prefix,
   then by stock number. Nothing is guessed: a row that matches nothing is listed and kept for later (below).
5. Import. SKUs in the sheet are added or updated (others are kept) and the named price list is replaced. The
   column choices are remembered for that customer's next sheet.

Rows for parts the catalog doesn't have yet (usually other product lines on the same sheet) are kept in the
database with their price list. When `npm run db:import` adds a line whose parts match them, they become the
customer's SKUs and prices automatically, without importing the sheet again.

The sheets themselves never reach the repository; only their rows are stored, in the database.

## The sheets (command line)

One folder per customer, three CSV files (Excel is fine; save as CSV):

| File | Columns | |
|---|---|---|
| `customer.csv` | `code, name, vertical, price_list, currency, effective_from, effective_to` | one row. `code` is short (ACME); `vertical` is RETAIL, DISTRIBUTOR, SERVICE, MANUFACTURER, INSPECTOR or blank; dates are like 2026-01-31 and may be blank |
| `parts.csv` | `line, order_number, sku, description` | the manufacturer's order number and the customer's own SKU. `line` (DT) can be blank when the order number is in only one line; `description` is optional and replaces the catalog's on their orders |
| `prices.csv` | `line, order_number, price` | the customer's price for each part, in the price list named in `customer.csv`. `$` and thousands commas are fine |

Parts without a SKU or price still appear in plans, with the manufacturer's number and "no price", and the order
export marks them so nothing is dropped.

## Commands

```
npm run customer:import -- customers/DEMO            check the sheets, then load them (nothing is written if a row is wrong)
npm run customer:import -- customers/DEMO --new-key  the same, and replace the private link (the old one stops working)
npm run customer:export -- DEMO out/DEMO             write the sheets back out (the price list in effect today)
npm run customer:export -- DEMO out/DEMO --price-list "2026 sample prices"
```

Errors name the file and row, as Excel numbers them (row 2 is the first under the header).

Importing replaces all of the customer's part numbers and the price list with the same name; other price lists
stay. When several lists are in effect, plans use the one that started most recently. A catalog import never
touches customers.

## The private link

The first import prints a key once; it isn't stored anywhere it can be read back (the database keeps only a hash).
The customer's link is the site address with `?customer=<key>`, for example
`https://<your-site>/?customer=Ab3...`. Anyone with the link sees that customer's SKUs and prices, so send it
privately. If it leaks, import again with `--new-key`.

Customer pricing comes from the planning server (the Vercel site), the only place customer data is kept.
