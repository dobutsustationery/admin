# Design — Received Inventory + Weighted Moving-Average Cost

Follows `COST_SHOULD_BE_MOVING_AVERAGE.md` (PR #135). Concrete design
+ sequenced, independently-shippable milestones. Decision taken:
**option (a)** — order imports carry a received date; missing/historical
dates fall back to the action timestamp and are **flagged for review**;
a new route lets us see and **edit** received dates so past imports can
be corrected to the true receipt date.

## Goals

1. Inventory `cost` is a **perpetual weighted moving-average**, not
   last-write-wins.
2. Cost changes are driven by **receipts dated when goods were
   received**, not when the order CSV was processed. Editing a
   received date re-derives the average deterministically.
3. Every cost change writes a structured **audit entry to item
   history** (old→new, lot qty/cost, formula, source).
4. Operators can see/repair received dates (**/received-inventory**)
   and supply cost for JANs with no received-order coverage via a
   **manual dated-cost flow** surfaced on an exceptions page.

## Hard constraints (must respect)

- **Replay determinism.** Reducers must not read wall-clock
  (`scripts/check-no-date-now-in-reducers.mjs` enforces this). Every
  date the algorithm uses must come from **action payloads**, never
  `Date.now()`.
- **Event-sourced.** All new state transitions are broadcast actions,
  replayable; conclusions logged to `idToHistory`.
- **Schema bump.** New persisted state (cost-lot ledger, received-order
  registry) is a non-backward-compatible shape change ⇒ bump
  `CURRENT_SCHEMA_VERSION` (4→5) so hydrated clients discard the
  snapshot and re-derive via full replay. Cold replay is ~16 s after
  the perf work (PRs #129/#130), acceptable.
- **Validation.** The "before/after diff = 0" guarantee no longer
  applies (cost changes broadly by design). Validation = hand-computed
  expected averages for the 5 known multi-lot items + a sample of
  other multi-order JANs, the SKU/cost CLI deltas, a determinism hash,
  and pre-push.

## Data model

### Received-order registry (new `inventory` sub-state)

```
receivedOrders: {
  [orderKey: string]: {
    orderKey: string;          // stable id (orderImport session id)
    name: string;              // session/file name
    receivedAt: number;        // ms; the authoritative receipt date
    dateSource: "ui" | "action-timestamp" | "manual";
    needsReview: boolean;      // true when dateSource !== "ui"
    importedAtMs: number;      // processing time (for display only)
  }
}
```

### Cost-lot ledger (per item)

```
costLots: {
  [itemKey: string]: Array<{
    receivedAt: number;        // sort key (NOT processing time)
    qty: number;               // units received in this lot
    unitCost: number;          // per-unit supplier cost for the lot
    source: string;            // orderKey | "manual" | "shopify" | "update_field"
    actionId?: string;
  }>
}
```

`cost` (and an `onHandValue`) are **derived**, never mutated forward:
a pure fold over `costLots[itemKey]` **sorted by `receivedAt`**,
interleaved with shipments by date. Re-running the fold after any lot
insert/date-edit yields the temporally-correct average — this is what
makes "process last year's order today, affect the past" work.

## Algorithm — perpetual weighted moving average

Fold events for an item in `receivedAt`/saleDate order:

- **Receipt** `(qtyIn, costIn)`:
  - if `onHandQty <= 0` **or** current `avgCost` is 0/unknown →
    `avgCost = costIn` (establish/overwrite basis, per the explicit
    rule "if cost was previously 0, overwrite").
  - else `avgCost = (onHandQty·avgCost + qtyIn·costIn) /
    (onHandQty + qtyIn)`.
  - `onHandQty += qtyIn`.
- **Shipment/sale** `qtyOut`: `onHandQty -= qtyOut`; `avgCost`
  unchanged; COGS = `qtyOut·avgCost` (recorded, not yet surfaced).
- **Archive / zeroing** (`archive_inventory`): `onHandQty = 0`,
  basis reset; next receipt re-establishes `avgCost`.
- **Manual cost adjustment**: explicit `avgCost` correction (audited),
  not a receipt.

Worked checks (must match in tests):
- User example: 10@¥100, sell 2, 10@¥75 ⇒ `(8·100 + 10·75)/18 =
  ¥86.11`.
- `4902778028179Black`: lot1 ¥282.70 (Order 1) + lot2 ¥243 (Order 5)
  ⇒ receipt-weighted ≈ ¥262.85 (exact depends on interleaved sales;
  the date-ordered fold computes the true figure).

## Received-date sourcing (option a)

- The order-import UI flow gains a **received-date input**; the
  emitted action carries `receivedAt` + `dateSource:"ui"`.
- **Historical/replayed** order imports with no `receivedAt` →
  `receivedAt = importAction effective timestamp`,
  `dateSource:"action-timestamp"`, `needsReview:true`.
- `/received-inventory` lists every received order; **edit-date**
  dispatches `set_received_order_date` (event-sourced) → flips
  `dateSource:"manual"`, clears `needsReview`, and the cost fold
  re-derives all affected items' averages (+ audit history entries).

## New routes / actions

- Route **`/received-inventory`**: table of `receivedOrders`
  (name, receivedAt, source badge, ⚠ needsReview, edit-date).
- Route **`/cost-exceptions`** (or a tab): JANs with on-hand stock
  but **no received-order cost lot**; a **manual dated-cost** form →
  `manual_cost_entry({ itemKey, unitCost, qty, receivedAt, note })`
  (a synthetic lot; audited).
- New actions (all event-sourced, in `inventory` slice):
  `record_received_order`, `set_received_order_date`,
  `manual_cost_entry`. Order-import NEW/MATCH stop overwriting `cost`
  and instead append to `costLots` (via the import orchestration).

## Milestones (sequenced, each its own PR, each validated)

**M0 (this doc).** Design + decision (a).

**M1 — Hold/neutralize #134.** Re-land bucket-B *derivation*
(`Total Wholesale ÷ (PCS×Unit)`) but as a value that flows into the
lot model, not an overwrite. (If #134 is still open, convert it; else
follow-up.) Net: stop making the 5 items worse.

**M2 — Cost-lot ledger + moving-average fold (no UI).** Add
`costLots` state + pure fold; order-import NEW/MATCH and the
existing cost writers append lots (receivedAt = action timestamp,
dateSource action-timestamp). Derive `cost` from the fold. Schema
bump 4→5. Structured audit history on every cost change. Validate vs
hand-computed 5 + CLI deltas + determinism hash.

**M3 — Received-order registry + `record_received_order`.** Populate
`receivedOrders` from order-import sessions; `needsReview` for
action-timestamp dates. No behaviour change to cost yet beyond M2.

**M4 — `/received-inventory` route.** Read-only table first, then
edit-date (`set_received_order_date`) → re-derived averages + audit.
E2E coverage.

**M5 — Order-import UI received-date capture.** New imports emit
`dateSource:"ui"`; no `needsReview`.

**M6 — Cost-exceptions page + `manual_cost_entry`.** Enumerate
uncovered JANs; manual dated-cost lot; audited. Drives remaining
SKU-review COST (buckets C/D) toward 0 with real dated data.

Each milestone: before/after on `production-backup-may-16`, the
SKU/cost CLI, unit tests for the fold (incl. **out-of-received-order
insertion** = the temporal guarantee), and pre-push.

## Interaction with open PRs

- **#133 (fix A)** — keep/merge; supplies the per-lot cost the ledger
  consumes.
- **#134 (fix B)** — **hold**; superseded by M1 (derivation reused as
  a lot input, not an overwrite).
- **#135** — rationale; this is its concrete design.

## Open questions for owner

1. Authoritative received date when the supplier CSV lacks one and
   the operator doesn't know it — best estimate + `needsReview`, or
   block import?
2. Are Shopify-import / `update_field` cost writes **corrections**
   (set avg directly, audited) or ignored once order-lot data exists?
3. Opening-balance bootstrap for items whose earliest receipts
   predate any cost data — leave uncosted (exceptions page) until a
   manual dated entry is supplied? (Recommended.)
4. COGS/valuation surfacing — out of scope here (the fold computes it;
   where it's reported is a later design).
