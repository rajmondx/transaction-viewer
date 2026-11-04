# Transaction Viewer

**▶ Live demo: [rajmondx.github.io/transaction-viewer](https://rajmondx.github.io/transaction-viewer/)** — **ready to use, no install.**

Open the link, drop a bank statement CSV, browse your spending. No account, no sign-up and no setup
step in between; free and 100% open source ([MIT](LICENSE)).

A **fully static** browser dashboard for bank statement CSVs. No server, no accounts, no data
ever leaves your machine: settings live in **localStorage**, uploaded statements in **IndexedDB**.
Built for GitHub Pages — the whole app is the static files in `dist/`.

![Transaction Viewer](https://img.shields.io/badge/works%20offline-PWA-blue) ![tests](https://img.shields.io/badge/tests-vitest-green)

## What it does

- **Add CSV** button, or **drop files anywhere on the page**: the schema is detected per file and
  confirmed in a dialog before anything is stored. Drop a **.json** instead and the app recognizes
  whether it is category settings or a CSV schema and imports it.
- **Spending** — category × month matrix, month and category toggles, average modes, monthly
  stacked chart and share chart (each on its own full-width row; the monthly one scrolls inside its
  card instead of squeezing anything out). Clicking a month bar switches that card to the
  **single-month view**: the month's categories as share bars like the Share chart, plus
  Expenses/Income/Net/transactions for that month and a tx count per category — and a **Return**
  button shows the normal Monthly chart again. Share bar names get their own column from tablet width up
  and move inside the bar on phones (contrast color, so pale categories stay readable); a
  **Sub-categories** toggle lists each child in a lighter shade directly under its parent, with
  percentages still relative to the top level (it applies to the month view too). Columns are resizable (drag a header edge,
  double-click the handle for automatic width), the row ends with **Total** and **Average** sits
  just before it, and expanding a row shows its transactions as a striped list. Three footer rows
  under the matrix — **Total Income**, **Total Expenses** and **Total Net** (income − expenses) —
  sum the visible categories independently of the shown measure; each carries a thicker top line
  marking it as a table sum, not a category row.
- **Categories** — rule editor (text / case-sensitive / fuzzy / regex, IBANs, date ranges,
  priority order, live preview per category, conflict hints for rules that overlap), several
  settings bundles you can switch between, **Auto Colorize**, and **Let AI write the categories**
  (it only writes a prompt — see below).
  On phones and tablets the settings-files panel sits above the category cards instead of floating
  over them.
- **CSV** — search, amount/date/category filters, resizable columns, paging. **Click** a cell to
  select that one value (Ctrl+C copies it); **double-click** to mark the whole column and copy every
  value in it, one per line.
- **Export CSV** — the header carries an **Export** button (download icon, next to print) on both
  table pages. It never downloads directly: first a dialog spells out **what exactly would be
  exported** — row scope (all filtered rows or the current page), order, columns, active filters —
  and only **Download CSV** confirms. The CSV page exports the table as displayed (one signed
  Amount column while amounts are merged, Category included); the Spending page exports the matrix
  with its shown months, **Total**/**Average** and the three Total footer rows (dimmed hidden
  categories included, switchable in the dialog). Plain signed amounts (`-1234.50`), `dd.mm.yyyy`
  dates, BOM so Excel reads the UTF-8 file cleanly.
- **Print** — clean black-on-white PDFs of both tables, with the options you last used remembered.
- **Sticky headers** — in both tables the header sticks under the menu while scrolling and releases
  exactly at the bottom of the table (it no longer floats over the charts below it).
- **Load demo data** on the empty pages: an anonymized English sample statement (common Swiss,
  German and online shops) so you can try everything without touching your real data.
- Straight corners, zebra-striped tables, full-width layout, light/dark theme, installable PWA.

## Run

```
npm install
npm run dev        # vite dev server (the app itself needs no backend) at http://localhost:5173
npm run build      # static output in dist/
npm run preview    # serve the built dist/ locally
npm run test       # vitest: CSV parsing/mappers, dedup, ingest, category engine, search, print, charts, CSV export, AI prompt
npm run typecheck
```

> Windows note: PowerShell blocks `.ps1` shims on this machine — use `npm.cmd` / `npx.cmd`.
> The parse tests read `data/test.csv`; the gitignored real-world sample in `example/` is optional
> and those tests skip themselves when it is absent.

## Deploy to GitHub Pages

`.github/workflows/deploy.yml` builds `dist/` and publishes it on every push to `main`;
`.github/workflows/ci.yml` runs typecheck, tests and a build on every push and pull request.
One-time setup: **repo Settings → Pages → Build and deployment → Source: GitHub Actions**.
The site is built with `base: './'` (see `vite.config.ts`) so it works under
`https://<user>.github.io/<repo>/`, and `public/.nojekyll` keeps Pages from filtering the output.

## Two independent settings

Category settings and CSV schemas are **separate** — one dataset can mix statements from several
banks, each file parsed with its own schema.

### 1. Category settings (`banking.settings` in localStorage)

Stored as one document `{ active, files: { name → bundle } }`; a bundle is

```json
{
  "name": "default",
  "categories": [
    {
      "tag": "Rent",
      "tag_father": "Housing",
      "color": "#719cfb",
      "iban": ["CH89 0839 0039 7668 1000 2"],
      "search_tag": ["case_insensitive", "something in text",
                      { "text": "ACME", "case_sensitive": true },
                      { "text": "mls", "fuzzy": true }]
    }
  ]
}
```

- The Settings tab exports/imports bundles as JSON, saves to localStorage, and seeds the `default`
  bundle (starter categories) on first launch. Switching bundles only re-classifies transactions —
  it never re-parses files.
- `search_tag` entries: plain strings (default **case-insensitive contains**) or objects
  `{ "text", "case_sensitive"?, "fuzzy"?, "regex" }`; flag tokens `case_insensitive`
  (typo `case_insentive` tolerated), `case_sensitive`, `fuzzy`, `plain`, `regex` change the mode of
  all **following** plain-string entries.
- A category matches when: (no `iban` list OR tx IBAN in list) AND (no `search_tag` OR any rule
  matches the description) AND (tx date inside its own `date_from`/`date_to` if set).
- **First matching category in file order wins.** Unmatched → `Uncategorized`.
- Overlap is shown, never resolved for you: the Categories sidebar lists every category whose
  own rules match loaded transactions that a higher-priority category takes away (an amber chip
  on the card says the same, e.g. `never wins · 2 hidden by Online Shopping`), and flags a rule
  identical to one already decided above, a `tag` used twice, and an empty `search_tag` (which
  matches every transaction). Clicking a conflict expands the card to the transactions behind it:
  every rule claiming the row is listed, the one that decided it in green, the ones that matched
  but were overruled in red. Matching itself only ever reads the file order — nothing is
  re-sorted, merged or rewritten.
- `tag_father` builds the tree; per category optional `color`, `enabled`, `date_from`, `date_to`.
- Bundles that still contain a `mapper` key (from older versions) load fine — the key is ignored.
- **Auto Colorize** gives every top-level category a basic palette color and each sub-category a
  slightly lighter shade of its parent, so charts and legends stay readable.

### 2. CSV schemas / mappers (`banking.mappers` in localStorage)

A mapper maps a bank's CSV columns onto the internal fields (booking date, description,
transaction ID, IBAN, credit/debit or single signed amount…).

- Built-in schema **"Alternative Bank Schweiz"**
  (`Buchungsdatum, Valutadatum, Auftragsnummer, Konto, Kontoalias, IBAN, Buchungstext, Gutschrift,
  Belastung`) is always offered; custom mappers live in the registry.
- **Every uploaded CSV stores its own mapper snapshot** (in IndexedDB) — editing or deleting a
  saved mapper never changes files you uploaded before; it only affects future uploads.
  To re-parse an old file, re-upload it (or re-map it via "Mappers…").
- **Exported JSON of either kind can be dropped anywhere on the page**: the app tells a category
  settings file (has a `categories` array) apart from a CSV schema (has a `columns` mapping) and
  imports it into the right place. A settings dump with several bundles inside is imported bundle
  by bundle; existing names are only replaced after you confirm.

### Add CSV modal (where mappers live)

CSVs are added with the **Add CSV** button (header, or on the CSV page — a page without
data shows an **Upload first a CSV** box you can click), or by **dropping files anywhere on
the page** while you are on any tab. Either way it **stores nothing yet** — it opens the modal:

1. Each file's header is scored against built-in + saved mappers; the best match is preselected
   ("Alternative Bank Schweiz — 100 % header match"), otherwise columns are auto-guessed into a
   Custom mapping.
2. Per file you can keep the detected schema, switch to any preset, or map columns yourself
   (live preview of parsed rows, amounts, count).
3. A custom mapping can be **"Save as mapper"** — it becomes a preset for all future uploads.
4. The modal also manages the registry: rename / duplicate / export / import / delete saved mappers.
5. **Add to dataset** stores the files with their mapper snapshots and ingests them.

"Re-map stored files" from the CSV tab opens the same dialog with every stored file, preselected
with its snapshot — only the files you actually change are re-parsed.

Encoding: decoded as UTF-8 with Windows-1252 fallback; amounts tolerate `CHF`, `’`/`.`/`,`
groupings and decimal commas; dates tolerate `DD.MM.YYYY`, `DD/MM/YYYY`, `DD-MM-YYYY`, ISO.

### Demo data

`src/seed/demoCsv.ts` generates the sample statement behind **Load demo data**: six months of
English transactions in the built-in layout, with common Swiss shops (Migros, Coop, Denner, Galaxus,
Ricardo…), German shops (REWE, EDEKA, dm, Rossmann, MediaMarkt, Kaufland…) and online shops
(Amazon, Zalando, Temu, AliExpress, eBay, Vinted…), plus a few rows that stay deliberately
uncategorized. Payees, IBANs and amounts are invented; nothing real is in there. It goes through the
normal upload path, so it is stored, categorized and removed like any other file.

## Let AI write the categories

The app never contacts an AI. The button on the Categories page builds a **prompt** describing this
JSON format, the matching rules and your current categories; you paste it into whichever assistant
you use, add your CSV (or its most important lines) to that chat, and paste the answer back into
**Raw JSON** on the Categories page — then Save.

- **Add CSV into prompt** puts your transactions into the prompt. The dialog notes that a model
  provider may train on what you share — at your own discretion.
- When on and you have ≤ 150 rows, all of them go in. Above that, `simplifyTxs()` shrinks the list:
  rows of the same IBAN whose booking text is at least 50 % identical collapse into one line with a
  count and a summed amount, and if there are still more than 150 lines, the 150 most frequent ones
  are used.
- With the toggle off, the prompt carries only your current categories, so add a few real booking
  texts to the chat yourself.

## Duplicate handling (overlapping timelines)

Monthly exports re-list boundary transactions. Dedup key = **Transaction ID + IBAN + amount**:

- different amount with the same ID → treated as **separate** transactions
  (both legs of an internal transfer stay visible);
- same ID + amount, different text → merged, the **longer text wins**;
- same ID + amount, different date → merged, the **newer booking/value date wins** (booking and
  value date); the text/date rules apply independently of each other;
- rows without a transaction ID fall back to exact-content matching (IBAN + date + amount + text).

Merging runs across **all** stored files, so overlapping statements of different banks or repeated
uploads of the same file are safe (same-name uploads replace; merged rows collapse).

## Printing

The header print button opens a dialog for the current page (CSV table or Spending matrix) and both
**remember what you last printed** in localStorage. Defaults: CSV → booking date + description, one
merged signed Amount column, category merged into the description, bold income, landscape;
Spending → graphs on the same page, landscape, page numbers, summary blocks and the Total
Income / Expenses / Net totals footer off. Output is black-on-white, hidden categories and months are left out; pick
*Save as PDF* to keep the file.

## Privacy & storage layout

| What | Where |
| --- | --- |
| Category settings bundles `{ active, files }` | localStorage `banking.settings` |
| Saved custom mappers | localStorage `banking.mappers` |
| Uploaded CSVs (raw text + mapper snapshot) | IndexedDB `banking` → store `csv_files` |
| Per-settings spending view, page size, column widths, theme | localStorage `banking.*` |
| Spending table column widths | localStorage `banking.spendingColW` |
| Print dialog options (per page) + shared font/size | localStorage `banking.csvPrintOpts`, `banking.spendingPrintOpts`, `banking.printStyle` |
| "Add CSV into prompt" preference (data stays local unless you paste it) | localStorage `banking.aiIncludeCsv` |

Clearing site data wipes everything; use Export JSON / keep your CSVs for backup.

## License

MIT — see [LICENSE](LICENSE). Source: <https://github.com/rajmondx/transaction-viewer>.
