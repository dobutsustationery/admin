# SKU Review COST exceptions — supplier-CSV categorization

## Scope

The SKU Review CLI (`scripts/sku-review-cli.ts`) reports **497 COST
exceptions** (items with no `cost`) on `../production-backup-may-16`.
This investigation cross-references every missing-cost item against the
incoming supplier order-import CSVs and categorizes each as:

- **(A)** cost was in the CSV's mapped column but never reached the item
- **(B)** cost was in the CSV but in a column the parser ignores (missed)
- **(C)** cost is absent from the CSV data entirely
- **(D)** the JAN never appears in any order-import CSV

Read-only analysis. Reproducer: `/tmp/cost-analysis.ts` /
`/tmp/trace-jan-cost.ts` (steps inline below).

## The 6 supplier CSVs (orderImport/append_raw_rows)

| file | rows | has `unit price (yen)` | cost-ish headers | rows w/ used col | rows w/ alt only | rows no cost |
|---:|---:|:--:|---|---:|---:|---:|
| 0 | 43 | yes | list price; unit price excluding tax（c rank）; line item price in lev; **unit price (yen)** | 37 | 6 | 0 |
| 1 | 137 | yes | **unit price (yen)**; cost; total wholesale amount yen; per item cost; total per item cost; … | 137 | 0 | 0 |
| 2 | 94 | yes | **unit price (yen)**; unit price (bgn) | 94 | 0 | 0 |
| 3 | 143 | yes | **unit price (yen)**; unit price jpy | 143 | 0 | 0 |
| 4 | 71 | **no** | total wholesale amount yen | 0 | 71 | 0 |
| 5 | 103 | **no** | *(none)* | 0 | 0 | 103 |

Files 0–3 carry per-unit cost in `unit price (yen)`. File 4 has only a
*total* wholesale column and no per-unit price. File 5 has no
cost-like column at all.

## Categorization of the 497 missing-cost items

```
A) cost FOUND in mapped col, never applied : 251
B) cost MISSED (value in a non-mapped col) :  63   (total wholesale amount yen ×63, list price ×1, c-rank ×1)
C) cost MISSING from data (JAN in CSV, no cost value) : 181
D) JAN not in ANY order-import CSV          :   2
```

## Root causes

### (A) 251 — `mapOrderToInventory` drops `cost` (biggest, clear bug)

Drilling one example, JAN `4542804127539`:

- Supplier CSV row: `unit price (yen) = "JPY 62 "` — cost present.
- Order parser (`order-import-slice.ts:171`) correctly yields
  `cost = parseFloat("JPY 62 ".replace(/[^0-9.]/g,"")) = 62`.
- Replay: at `orderImport/import_batch` the item is **created with
  `cost: undefined`** and never gains a cost.

Cause: the order-import NEW path builds the inventory item through
`mapOrderToInventory` (`src/lib/root-reducer.ts`):

```ts
const mapOrderToInventory = (importItem: any): Item => ({
  janCode: importItem.janCode,
  subtype: "",
  description: importItem.description,
  hsCode: importItem.hsCode || "",
  image: "",
  qty: importItem.qty,
  pieces: 1,
  shipped: 0,
  creationDate: "Unknown",
  timestamp: 0,
  price: importItem.price,
  weight: importItem.weight,
  countryOfOrigin: importItem.countryOfOrigin,
  // ⬅ cost is parsed but NOT copied here
});
```

It maps `price`, `weight`, `countryOfOrigin` but **omits `cost`**.
Every item first created by an order import therefore loses its
supplier cost permanently (the MATCH path only re-applies cost
`if (item.cost !== undefined)` on a later matched, non-conflicting
import — which never happens for these bare-JAN-only rows). All 251
A-items are clean bare-JAN rows with no costed sibling, consistent
with this.

### (B) 63 — strict single-header cost mapping (the only un-fuzzy field)

`order-import-slice.ts:170-173`:

```ts
// Map CSV 'unit price (yen)' (supplier cost) to 'cost'. Strict match required.
cost: row["unit price (yen)"]
  ? parseFloat(row["unit price (yen)"].replace(/[^0-9.]/g, ""))
  : undefined,
```

`qty`, `description`, `weight`, `hsCode`, `countryOfOrigin` all use
fuzzy `getValueByHeaders([...matchers])`. **`cost` alone uses a single
exact key.** File 4 (71 rows) names its cost-bearing column
`total wholesale amount yen`; files 0 contribute a `list price` and a
c-rank column. None match `unit price (yen)` → `cost: undefined`.

Caveat for the fix: `total wholesale amount yen` is a **line total**,
not per-unit — broadening must map only genuine *per-unit* columns
(`unit price jpy`, `unit price (jpy)`, `per item cost`, `cost`, …) or
derive per-unit = total ÷ qty. A naive "any cost-ish header" match
would write wrong (inflated) costs.

### (C) 181 + (D) 2 — no per-item supplier cost in the data

File 5 (103 rows, no cost-ish column) plus other rows where no
cost-like column held a value. Not code-fixable from these CSVs —
requires supplier data or manual cost entry.

## Recommendations

| Bucket | Count | Action |
|---|---:|---|
| **A** | 251 | **Add `cost: importItem.cost` to `mapOrderToInventory`** (`root-reducer.ts`). One field; directly recovers ~251 exceptions. Validate with the established full Apr/May replay before/after inventory diff — expect only `cost` populated on order-import-created items, no other field movement. |
| **B** | 63 | Replace the strict `row["unit price (yen)"]` with `getValueByHeaders` over per-**unit** cost matchers (`unit price (yen)`, `unit price jpy`, `unit price (jpy)`, `per item cost`, `total per item cost`?, `cost`). Explicitly **exclude** total columns (`total wholesale amount …`) unless divided by qty. Lower-confidence than A — needs per-supplier verification that each chosen column is per-unit. |
| **C/D** | 183 | Not solvable in code. Needs supplier cost data or operator entry; out of scope for the import pipeline. |

Net: code fixes A + B can clear **~314 of 497** COST exceptions
(A is the safe, high-leverage one to do first). The remaining ~183
are genuine data gaps.

## Reproduction

```bash
# Categorize (replays may-16, joins missing-cost items ↔ supplier CSVs)
bun run /tmp/cost-analysis.ts        # script body in this PR's history

# Trace one A-item's cost lifecycle
bun run /tmp/trace-jan-cost.ts       # JAN 4542804127539
```

(Both helper scripts were ad-hoc; the durable instrument is
`scripts/sku-review-cli.ts` — `--summary` for the COST count,
`--report` for the per-item CSV including the `cost` column.)
