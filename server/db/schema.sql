-- Chimney Planner database (SQLite / libSQL, hosted on Turso).
-- Three layers: the catalog (what a manufacturer sells), the rules (what an installation must meet)
-- and customers (what a retailer or distributor adds on top). Catalog and rule tables are replaced
-- as a whole by each import; customer tables are never touched by an import, so they refer to parts
-- by line code + order number instead of row ids.
-- Values with more than one part (lists, maps, ranges, settings) are JSON text.

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------------ catalog layer
CREATE TABLE IF NOT EXISTS manufacturers (
  code      TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  website   TEXT,
  logo_file TEXT,                 -- file name in catalog/logos/, served at /logos/<file>
  sort      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  code          TEXT PRIMARY KEY,
  manufacturer  TEXT NOT NULL REFERENCES manufacturers(code),
  document_code TEXT,
  title         TEXT,
  published     TEXT,
  sort          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS product_lines (
  code                         TEXT PRIMARY KEY,
  manufacturer                 TEXT NOT NULL REFERENCES manufacturers(code),
  name                         TEXT NOT NULL,
  family                       TEXT NOT NULL,
  status                       TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PLANNED', 'RETIRED')),
  fuels                        TEXT NOT NULL DEFAULT '[]',   -- JSON list
  listing                      TEXT,
  listing_file                 TEXT,
  clearance_to_combustibles_in REAL,
  joint_overlap_in             REAL,
  wall_thickness_in            REAL,
  continuous_flue_temp_f       INTEGER,
  default_source               TEXT REFERENCES sources(code),
  notes                        TEXT,
  sort                         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sizes (
  line     TEXT NOT NULL REFERENCES product_lines(code),
  size     TEXT NOT NULL,           -- text so coaxial lines can use keys like 4x6-5/8
  flue_in  REAL NOT NULL,
  outer_in REAL,
  sort     INTEGER NOT NULL,
  PRIMARY KEY (line, size)
);

CREATE TABLE IF NOT EXISTS categories (
  code        TEXT PRIMARY KEY,     -- shared by every manufacturer: the job a part does
  name        TEXT NOT NULL,
  system_zone TEXT NOT NULL,
  description TEXT,
  sort        INTEGER NOT NULL
);

-- What a part can carry beyond its core columns. placement says where the engine finds it:
-- 'part' = a field on the part, 'attribute' = part.attributes, 'adjustability' = part.adjustability[size].
CREATE TABLE IF NOT EXISTS spec_defs (
  key            TEXT PRIMARY KEY,
  type           TEXT NOT NULL,     -- bool, number, text, enum, list, map, range
  allowed_values TEXT NOT NULL DEFAULT '[]',
  unit           TEXT,
  categories     TEXT NOT NULL DEFAULT '[]',
  description    TEXT,
  placement      TEXT NOT NULL CHECK (placement IN ('part', 'attribute', 'adjustability')),
  sort           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS parts (
  id            INTEGER PRIMARY KEY,
  line          TEXT NOT NULL REFERENCES product_lines(code),
  order_number  TEXT NOT NULL,
  stock_number  TEXT,
  category      TEXT NOT NULL REFERENCES categories(code),
  description   TEXT NOT NULL,
  finish        TEXT,
  carton_filler INTEGER NOT NULL DEFAULT 0,
  optional      INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  source_page   INTEGER,
  note          TEXT,
  sort          INTEGER NOT NULL,
  UNIQUE (line, order_number)
);

CREATE TABLE IF NOT EXISTS part_sizes (
  part_id INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  size    TEXT NOT NULL,
  sort    INTEGER NOT NULL,
  PRIMARY KEY (part_id, size)
);

CREATE TABLE IF NOT EXISTS part_specs (
  part_id  INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  spec_key TEXT NOT NULL REFERENCES spec_defs(key),
  size     TEXT NOT NULL DEFAULT '',  -- '' = applies to every size of the part
  value    TEXT NOT NULL,             -- JSON
  PRIMARY KEY (part_id, spec_key, size)
);

CREATE TABLE IF NOT EXISTS part_dimensions (
  part_id  INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  label    TEXT NOT NULL,             -- the letter on the manufacturer's drawing
  value_in REAL,
  value_text TEXT,
  meaning  TEXT,
  sort     INTEGER NOT NULL,
  PRIMARY KEY (part_id, label)
);

-- Manufacturer charts the engine reads by name (elbow_offsets, support_box_pitch).
CREATE TABLE IF NOT EXISTS lookup_tables (
  id      INTEGER PRIMARY KEY,
  line    TEXT NOT NULL REFERENCES product_lines(code),
  name    TEXT NOT NULL,
  columns TEXT NOT NULL,              -- JSON list, the CSV column order
  UNIQUE (line, name)
);

CREATE TABLE IF NOT EXISTS lookup_rows (
  table_id INTEGER NOT NULL REFERENCES lookup_tables(id) ON DELETE CASCADE,
  sort     INTEGER NOT NULL,
  row      TEXT NOT NULL,             -- JSON object
  PRIMARY KEY (table_id, sort)
);

CREATE TABLE IF NOT EXISTS line_compatibility (
  line           TEXT NOT NULL REFERENCES product_lines(code),
  other_line     TEXT NOT NULL REFERENCES product_lines(code),
  relationship   TEXT NOT NULL,
  via_categories TEXT NOT NULL DEFAULT '[]',
  note           TEXT,
  source_ref     TEXT,
  sort           INTEGER NOT NULL
);

-- ------------------------------------------------------------------ rules layer
CREATE TABLE IF NOT EXISTS rule_defs (
  key         TEXT PRIMARY KEY,       -- generic: offset.max_count, not dt.max_offsets
  kind        TEXT NOT NULL CHECK (kind IN ('LIMIT', 'REQUIREMENT', 'ADVICE')),
  direction   TEXT CHECK (direction IN ('MIN', 'MAX', 'EXACT')),
  unit        TEXT,
  engine_uses INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  sort        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  rule_key   TEXT NOT NULL REFERENCES rule_defs(key),
  scope      TEXT NOT NULL,           -- GLOBAL, a manufacturer code or a product line code
  authority  TEXT NOT NULL,           -- MANUFACTURER, NFPA211, IRC, LOCAL, INDUSTRY
  value      REAL,
  value_max  REAL,
  unit       TEXT,
  statement  TEXT NOT NULL,
  source_ref TEXT,
  verified   INTEGER NOT NULL DEFAULT 0,
  sort       INTEGER NOT NULL,
  PRIMARY KEY (rule_key, scope)
);

CREATE TABLE IF NOT EXISTS catalog_imports (
  id          INTEGER PRIMARY KEY,
  imported_at TEXT NOT NULL,
  source      TEXT NOT NULL,          -- where the CSVs came from (folder, git commit)
  summary     TEXT NOT NULL           -- JSON: parts per line, warnings
);

-- ------------------------------------------------------------------ customer layer
-- Never changed by a catalog import. Used from step 4 (part numbers, prices, stricter rules).
CREATE TABLE IF NOT EXISTS customers (
  code     TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  vertical TEXT CHECK (vertical IN ('RETAIL', 'DISTRIBUTOR', 'SERVICE', 'MANUFACTURER', 'INSPECTOR')),
  settings TEXT NOT NULL DEFAULT '{}'  -- JSON: branding, questions shown or locked, modules
);

CREATE TABLE IF NOT EXISTS customer_parts (
  customer     TEXT NOT NULL REFERENCES customers(code) ON DELETE CASCADE,
  line         TEXT NOT NULL,
  order_number TEXT NOT NULL,
  sku          TEXT NOT NULL,          -- the customer's own part number
  description  TEXT,
  PRIMARY KEY (customer, line, order_number)
);

CREATE TABLE IF NOT EXISTS price_lists (
  id             INTEGER PRIMARY KEY,
  customer       TEXT NOT NULL REFERENCES customers(code) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'USD',
  effective_from TEXT,
  effective_to   TEXT
);

CREATE TABLE IF NOT EXISTS prices (
  price_list_id INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  line          TEXT NOT NULL,
  order_number  TEXT NOT NULL,
  price         REAL NOT NULL,
  PRIMARY KEY (price_list_id, line, order_number)
);

-- Rows of an imported price sheet that matched no catalog part yet (other product lines, usually). They are kept
-- so that when a line is added to the catalog, its parts pick up these SKUs and prices without a re-import
-- (see promoteSavedRows in server/db/customer-store.mjs). price_list is '' for a sheet imported without prices.
CREATE TABLE IF NOT EXISTS saved_sheet_rows (
  customer    TEXT NOT NULL REFERENCES customers(code) ON DELETE CASCADE,
  price_list  TEXT NOT NULL DEFAULT '',
  row_n       INTEGER NOT NULL,          -- the row number in the sheet, as Excel shows it
  part        TEXT NOT NULL,             -- as written in the sheet
  sku         TEXT,
  price       REAL,
  description TEXT,
  PRIMARY KEY (customer, price_list, row_n)
);

-- A customer may make a rule stricter, never looser; the server refuses a looser value on save.
CREATE TABLE IF NOT EXISTS customer_rules (
  customer  TEXT NOT NULL REFERENCES customers(code) ON DELETE CASCADE,
  rule_key  TEXT NOT NULL,
  value     REAL,
  value_max REAL,
  statement TEXT NOT NULL,
  PRIMARY KEY (customer, rule_key)
);
