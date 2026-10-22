# Customers

A customer is a retailer or distributor that sells the parts the planner lists. Each one gets its own part
numbers (SKUs), its own prices and a private link to the planner that shows them.

**Real customers' sheets are not committed.** This repository is public, so `.gitignore` keeps everything here
except this file and the made-up `DEMO` customer. Keep real sheets somewhere private and import them from there.

## The sheets

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

Customer pricing needs the planning server (the Vercel site). The GitHub Pages copy plans in the browser and
has no customer data.
