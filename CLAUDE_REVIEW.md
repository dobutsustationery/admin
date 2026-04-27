# Review: Temporal Key Bindings Implementation

Reviewing `codex/temporal-key-bindings-design` against
`docs/design/TEMPORAL_KEY_BINDINGS_DESIGN.md`.

Two review passes:

- **Pass 1** — initial implementation through commit `f534d1f`.
- **Pass 2** — Gemini's refinements in `3cb2703`
  ("Refine temporal key bindings: address pending writes and manual retype
  durability"), summarised in `GEMINI_RESPONSE.md`.

Files touched in this branch:

- `docs/design/TEMPORAL_KEY_BINDINGS_DESIGN.md` (new)
- `docs/design/README.md`
- `src/lib/inventory.ts`
- `src/lib/timestamped-action.ts`
- `tests/shopify-sync.test.ts`
- `tests/unit/shopify-history.test.ts` (added in pass 2)

Test status after pass 2: **`bun run test` → 265 passed, 1 skipped**, including
the 16 cases in `tests/shopify-sync.test.ts`.

## 1. Original implementation (pass 1)

The original commits captured the heart of the design:

- `keyIdentity` substructure on `InventoryState` with the three maps the
  design specifies.
- `bindNewInventoryEntity`, `renameInventoryEntityKey`,
  `closeInventoryEntityKey`, and `resolveHistoricalInventoryKey` helpers.
- Entity ids of the form `${creatingActionDocId}:${originalInventoryKey}`.
- `id` propagated alongside `timestamp` through `withInheritedTimestamp`.
- Hooks into the full list of binding-affecting actions
  (`update_item`, `bulk_import_items`, `update_field` (subtype),
  `rename_subtype`, `retype_item`, `fix_jancode`, `split_inventory_item`).
- Shopify reducers using `effectiveAtMs` from order business time.
- `ShopifyLineFact` carrying `rawSku` and `entityId`.

Pass 1 raised three correctness blockers:

1. **§2.1 Pending writes** — `null` server timestamp produced
   `validFromMs = 0`, corrupting the dispatcher's intervals.
2. **§2.2 Resolver outcome** — silently fell back to the raw key when no
   interval covered the effective time, so reused keys could misroute
   reconciliation with no exception.
3. **§2.3 Manual retype durability** — `isManualRetype` heuristic depended
   on `fact.rawSku`, missing on legacy facts; `shopify_order_created` did
   not check it at all.

…plus smaller observations on merge auditing, `||=` vs `??=` on `rawSku`,
type-safety, and missing tests for the design's testing-strategy items 4
and 5.

## 2. What pass 2 fixed

Read against the pass-1 list:

### 2.1 Pending writes — addressed

`bindNewInventoryEntity`, `renameInventoryEntityKey`, and
`closeInventoryEntityKey` now early-return when
`atMs <= 0 && !actionType.includes(":backfill")`
(`inventory.ts:307-336`, `inventory.ts:353-412`, `inventory.ts:414-441`).

`applyInventoryUpdate` was also changed to call `bindNewInventoryEntity`
unconditionally (`inventory.ts:715-718`), with the comment
"it handles its own idempotency." This is the catch-up path: if a pending
update_item sets `idToItem[key]` but the binding is guarded out,
a later replay (cold reload, or a subsequent update_item against the same
key with a real timestamp) will create the binding. Verified by the new
test `guards against pending writes with atMs=0`.

The verdict: pending dispatches no longer leave `validFromMs=0` intervals
in the index. Bindings come into existence only when a real timestamp is
available. Acceptable, though there is a small new wrinkle worth flagging
in §3.2.

### 2.2 Resolver outcome — addressed

`HistoricalSkuResolution` now carries an explicit
`outcome: "resolved" | "missing_historical_binding" |
"ambiguous_historical_binding" | "missing_current_key"`
field (`inventory.ts:445-487`).

Both `shopify_order_created` (`inventory.ts:912-928`) and
`applyOrderReconciliation` (`inventory.ts:1098-1167`) read the outcome and
record `"Missing historical binding for SKU: ..."` Shopify exceptions when
a line cannot be temporally resolved. The previous fall-back-to-raw-key
behaviour is gone.

The new test `records an exception and does not mutate shipped counts if no
historical binding interval exists` covers the design's testing-strategy
item 4.

### 2.3 Manual retype durability — addressed

`ShopifyLineFact` gains `manualEntityId?` (`inventory.ts:46`).

`retype_item` records the new entity id on the order line when it rewrites
`shopifyFacts` (`inventory.ts:1551-1568`). Both Shopify reducers now look
up the current key for the manual entity *first*; if it resolves, the line
uses that key regardless of what `rawSku` says
(`inventory.ts:944-955`, `inventory.ts:1109-1124`). The fragile
`fact.rawSku === rawSku` heuristic is preserved as a fallback for legacy
facts that pre-date `manualEntityId`.

The existing test `preserves retype_item correction across later shopify
reconciliation` continues to pass; a future test exercising
`shopify_order_created` re-fire after a manual retype would harden this
further.

### 2.4 Smaller items

- `fact.rawSku ||= rawSku` → `fact.rawSku ??= rawSku`
  (`inventory.ts:956`, `inventory.ts:1147-1148`). Empty-string raw SKUs
  are no longer silently re-overwritten.
- `getTimestampMs` is now a thin wrapper over the shared `toTimestampMs`
  helper (`inventory.ts:205-208`), eliminating duplicated parsing logic.

## 3. Remaining concerns after pass 2

### 3.1 Reconciliation still mutates shipped on `missing_historical_binding` if order.items already had impact

`applyOrderReconciliation` builds `currentInventoryImpact` from
`order.items` *before* the line loop (`inventory.ts:1086-1091`). If a
prior successful reconciliation populated `order.items` with `qty 3` on
keyA, and a subsequent reconciliation now resolves the same line as
`missing_historical_binding`:

- The line is skipped → `itemQtyMap[keyA]` stays at 0.
- The "leftover currentInventoryImpact" loop
  (`inventory.ts:1175-1192`) reads `keyA → 3` and decrements
  `idToItem[keyA].shipped` by 3 with a "Missing item reset" history entry.

So an exception is recorded but the inventory *is* mutated, contradicting
the design's "records an exception and does not mutate shipped counts."
The new test does not cover this multi-pass case (it tests an order whose
binding was missing from the start; `order.items` was empty).

Suggested fix: when at least one line in a reconciliation payload returns
`missing_historical_binding`, either (a) abort the reconciliation entirely
for that order, or (b) carry the previous `order.items` impact for the
unresolved line forward into `itemQtyMap` so the subtraction is a no-op.

### 3.2 `applyInventoryUpdate` "always try to bind" can mint phantom entities for orphaned keys

The new unconditional `bindNewInventoryEntity` call works fine when
`entityIdByCurrentKey[key]` is set (early return). But if state ever has
`idToItem[key]` populated without a matching binding entry — for example a
pending rename that left `idToItem[oldKey]` deleted but the dispatcher
later re-issues `update_item({id: oldKey, ...})` — the helper will create
a brand-new entity at the *current* timestamp, despite the item not really
being new. In practice `rename_subtype`/`update_field` delete the source
`idToItem` entry, so this is hard to hit, but the comment "it handles its
own idempotency" overstates the guarantee. Worth a follow-up assertion or
a more careful check (e.g. only bind when no closed interval exists for
the key in the current half-open window).

### 3.3 `manualEntityId` may not be set during pending dispatch

`retype_item` only writes `fact.manualEntityId` when
`bindNewInventoryEntity` returns truthy. With the pass-1 fix in place, a
pending retype (`atMs <= 0`) returns `undefined`, so `manualEntityId` is
*not* recorded for the optimistic apply. Within the session, a later
reconciliation could still revert the retype via the legacy
`isManualRetype` heuristic — which is fine *if* `fact.rawSku` is set (the
new fact was created above with `rawSku` populated), but the user-visible
window is back to the same fragility pass-1 worried about, just narrower
in time. Cold reload restores correctness because the action replays with
its real timestamp. Acceptable, but worth a test that exercises the
pending → confirmed lifecycle for `retype_item`.

### 3.4 Merge case still under-modelled

Pass 1's §2.5 stands: `update_field`/`rename_subtype` silently merge into
existing keys without an explicit merge action, and only the surviving
target's entity is reachable via `entityIdByCurrentKey`. The merged
entity stays mapped via `currentKeyByEntityId` only. `GEMINI_RESPONSE.md`
explicitly defers this. Forward lookups continue to work; a follow-up
should add the explicit merge action the design recommends.

### 3.5 Missing test for design strategy item 5

"Stored order line fact follows a later replayed rename." The refund test
exercises this for `idToItem`, but no test asserts that
`shopifyFacts.lines[*].itemKey` is updated when a rename happens *after*
the fact was recorded. `rewriteOrderItemKeyReferences` does the work, so
the test is straightforward to add.

### 3.6 Type-safety polish (deferred)

`(action as any).id` and `(action as any).timestamp` casts remain at every
binding call site. `TimestampedPayloadAction` already exists in
`timestamped-case-reducer.ts`; threading it through the relevant reducers
would make `id` and `timestamp` first-class without the casts. Gemini
explicitly deferred this, and the call sites are localised, so it is
quality-of-life rather than correctness.

## 4. Design adherence at a glance (post pass 2)

| Design item | Status |
| --- | --- |
| `KeyBindingInterval` shape, three-map index | Implemented |
| `entityId = "${docId}:${originalKey}"` | Implemented |
| Bind / rename / close helpers | Implemented, with pending-write guards |
| `resolveHistoricalInventoryKey` returning `outcome` | Implemented (new in pass 2) |
| `effectiveAtMs` from order business time | Implemented |
| Binding updates on listed key-changing actions | Implemented |
| `OrderLineFact` carries raw, resolved, manual override | `rawSku`, `entityId`, `manualEntityId` |
| Rename rewrites order facts and inventory references | Implemented via `rewriteOrderItemKeyReferences` |
| Missing-binding exceptions on Shopify lines | Implemented (new in pass 2) |
| Manual retype durable across reconciliation | Implemented via `manualEntityId` (pass 2) |
| Pending-write / replay determinism | Guarded by `atMs <= 0` early-return (pass 2) |
| Merge actions explicit, surviving entity recorded | Still deferred (§3.4) |

## 5. Tests

Existing (carried through pass 2):

- Retype regression for `4901681382316` → `4901681382316Standard`.
- Chained rename `A→B→C` with key reuse for `A`.
- Manual `retype_item` preserved across `shopify_order_reconciled`.
- Refund applied to renamed current key.

New in pass 2:

- `records an exception and does not mutate shipped counts if no historical
  binding interval exists` — covers design strategy item 4.
- `guards against pending writes with atMs=0` — covers the §2.1 fix.
- `tests/unit/shopify-history.test.ts` updated to seed items via
  `update_item` so they have real bindings.

Still missing:

- Multi-pass reconciliation where a previously-resolved line later resolves
  as `missing_historical_binding` (§3.1).
- Pending → confirmed lifecycle for `retype_item` (§3.3).
- Stored fact follows a later replayed rename (§3.5).

## 6. Recommendation

Pass 2 closed the three correctness blockers identified in pass 1, and the
existing test suite (266 cases) is green. The work is in a good state to
merge as a foundational layer for temporal binding correctness.

Before relying on the index for production reconciliation in edge cases,
file follow-ups for:

1. **§3.1 Reconciliation + missing binding** — the design's "do not
   mutate" contract is not yet honoured when prior `order.items` already
   carry impact for the unresolved key. Likely the highest-value
   remaining fix.
2. **§3.4 Explicit merge action** — the design specifically calls for
   one; until it lands, `update_field`/`rename_subtype` merges leak only
   one survivor entity into `entityIdByCurrentKey`.
3. **§3.5** and **§3.3** test coverage so future regressions in the
   rename-after-fact and pending-retype flows surface in CI.

The smaller cleanups (§3.2 phantom-entity guard, §3.6 type-safety) are
quality-of-life and can ride along when next touched.
