# Inventory-Value Timeline: `main` vs `55a6c84`

Generated 2026-06-17. Companion to
[INVENTORY_VALUE_DELTA_VS_55A6C84.md](./INVENTORY_VALUE_DELTA_VS_55A6C84.md)
(staging `a402baa` vs `55a6c84`). This one explains the `/inventory-value`
mismatch between **`main`** (`460e3cc`) and **`55a6c84`**, using **only the
actions `55a6c84` was replayed against** — the plain June 11 backup (41,771
docs, none of the staging-only actions).

## Methodology

Same as the companion: each side's timeline is computed with **that side's own
code** (the `Value` column depends on `cost-engine`, which differs by commit).

- **`main`** = `460e3cc` code, replayed over the plain backup.
- **`55a6c84`** = `55a6c84` code, replayed over the plain backup.

Both via `buildInventoryValueReport`. Convention below matches the accountant's
TSV: **`main − 55a6c84`** (per-JAN figures quoted the same way); positives mean
`main` valued it higher. JAN aggregation cancels the bare/subtyped key-migration
display noise.

## Branch relationship — why this is a small, contained diff

`git merge-base main 55a6c84` = `460e3cc` = **main itself**. So `55a6c84` is
exactly **main plus four early branch commits**:

| Commit | Title |
|---|---|
| `1c23aa4` | Document Shopify reconcile duplicate cleanup (docs only) |
| `3061bde` | Show unmatched Shopify order lines |
| `28171f6` | **Resolve bare Shopify JANs to single subtype** |
| `55a6c84` | Improve Shopify listing mismatch review |

None of the cost-ledger rework (cost-ledger-authoritative, retype-as-sales,
archive-sweep re-derivation, zero-cost-merge, move-uncosted) is in `55a6c84` —
those all land *after* it. So `main` vs `55a6c84` isolates only the early
Shopify-listing commits, and only one of them moves inventory value.

## Timeline of mismatches

Identical through 2025; the only divergence is from **2026-03-31 onward**:

| Date | Δ Value (JPY) | Δ Cum-Inv (JPY) | Δ Sold (JPY) |
|---|---:|---:|---:|
| 2026-03-31 | +356 | 0 | −356 |
| 2026-04-30 | +1,555 | 0 | −1,555 |
| 2026-05-31 | +2,168 | 0 | −2,169 |
| 2026-06-15 Current | **+2,598** | **0** | **−2,599** |

`Value` and `Sold` are exact mirrors (+2,598 / −2,599), and **cumulative
received is unchanged (0)** at every date — the diagnostic signature of a
**sales-binding** difference, not a receipt/cost difference.

## Cause — `28171f6` binds bare Shopify SKUs, so `55a6c84` sells what `main` cannot

`28171f6` "Resolve bare Shopify JANs to single subtype" lets a bare Shopify SKU
(no subtype) bind to the single local variant for its JAN. On recent (2026-03+)
Shopify orders, that binding lets `55a6c84` **consume inventory** (record the
sale / COGS) for order lines that `main` leaves **unmatched and therefore
unsold**. So relative to `main`:

- `55a6c84` cumulative **COGS is higher** (it sold those lines) → `main − 55a6c84`
  Sold is **negative** (−2,599).
- `55a6c84` **on-hand is lower** (it shipped them) → `main − 55a6c84` Value is
  **positive** (+2,598).
- Cumulative **received is identical** — the change only affects which sales
  bind, never receipts.

The divergence starts at 2026-03-31 because that is when the affected
bare-SKU Shopify orders fall in the timeline.

## Per-JAN drivers at current (`main − 55a6c84`)

12 JANs differ — all pens / decoration stationery whose bare Shopify SKUs bind
on `55a6c84` but not `main`:

| JAN | Item | Δ Value | Δ Sold |
|---|---|---:|---:|
| 4902505673924 | Pilot Juice 0.5mm Gel Pen Set — 6 Colours | +389 | −389 |
| 4902505596698 | Pilot FriXion Erasable Highlighter Set — 6 | +324 | −324 |
| 4902505465628 | Pilot FriXion Erasable Highlighter Set — 6 | +324 | −324 |
| 4902505451409 | Pilot Juice 0.5mm Gel Pen Set — 6 Colours | +324 | −324 |
| 4977564720742 | Plus Deco Rush Decoration Tape 6mm × 4m | +178 | −178 |
| 4977564720827 | Plus Deco Rush Decoration Tape | +178 | −178 |
| 4902505660429 | Pilot ILMILY 0.5mm Nuance Black Pen | +162 | −162 |
| 4902505660436 | Pilot ILMILY 0.5mm Nuance Pen | +162 | −162 |
| 4902505660443 | Pilot ILMILY 0.5mm Nuance Pen | +162 | −162 |
| 4902505660450 | Pilot ILMILY 0.5mm Nuance Pen | +162 | −162 |
| 4977564690045 | Plus (decoration) | +127 | −127 |
| 4901681413713 | Zebra Sarasa Clip Milk Colour Pen | +106 | −106 |

`ΔCumInv = 0` for all — confirming none of these are receipt/cost changes, only
sales that bind on `55a6c84` and not on `main`.

## Contrast with the staging report

| | `main` vs `55a6c84` | staging (`a402baa`) vs `55a6c84` |
|---|---|---|
| Commits isolated | 4 early Shopify-listing commits | the full cost-ledger rework |
| First divergence | 2026-03-31 | 2024-07-02 (Amifa Order 2) |
| Cum-inv delta | 0 always | −4,550 then 0 (timing) |
| Mechanism | bare-SKU sales binding (`28171f6`) | order-date attribution, zero-cost-merge re-pricing, archive-sweep re-derivation |
| Current value delta | +2,598 | +6,717 |
| Current sold delta | −2,599 | −3,235 |

In short: going from `55a6c84` **back to `main`** removes only the bare-SKU sales
binding (a small, recent, sales-only effect); going from `55a6c84` **forward to
staging** layers on the entire cost-ledger reconstruction (the large,
historical, received/COGS effects documented in the companion report).
