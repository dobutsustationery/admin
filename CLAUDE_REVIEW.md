# Review: Temporal Key Bindings Implementation

Reviewing `codex/temporal-key-bindings-design` (commits `abbe968`..`f534d1f`)
against `docs/design/TEMPORAL_KEY_BINDINGS_DESIGN.md`.

Files touched:

- `docs/design/TEMPORAL_KEY_BINDINGS_DESIGN.md` (new)
- `docs/design/README.md`
- `src/lib/inventory.ts`
- `src/lib/timestamped-action.ts`
- `tests/shopify-sync.test.ts`

## 1. Summary

The implementation captures the heart of the design:

- A `keyIdentity` substructure on `InventoryState` with the three maps the
  design specifies (`intervalsByKey`, `currentKeyByEntityId`,
  `entityIdByCurrentKey`).
- `bindNewInventoryEntity`, `renameInventoryEntityKey`,
  `closeInventoryEntityKey`, and `resolveHistoricalInventoryKey` helpers
  matching the design's binding operations.
- Entity IDs of the form `${creatingActionDocId}:${originalInventoryKey}`,
  exactly as the design proposes.
- `id` is now propagated alongside `timestamp` through `withInheritedTimestamp`
  so reducers can read the creating broadcast doc id.
- Hooks into `update_item`, `bulk_import_items`, `update_field` (subtype),
  `rename_subtype`, `retype_item`, `fix_jancode`, and `split_inventory_item` —
  the exact list the design names.
- Shopify reducers (`shopify_order_created`, `applyOrderReconciliation`) call
  the resolver against an `effectiveAtMs` derived from
  `processed_at / created_at / updated_at`, matching the design's
  "received vs effective time" distinction.
- `ShopifyLineFact` gained `rawSku` and `entityId`, satisfying the design's
  "preserve both raw and resolved" recommendation.

The four happy-path scenarios in the design's testing strategy
(retype regression, multi-hop rename + reuse, manual retype preserved across
reconciliation, refund after rename) are exercised by new tests in
`tests/shopify-sync.test.ts`.

## 2. Concerns

### 2.1 Pending Firestore writes write `validFromMs = 0`

`getTimestampMs(timestamp)` returns `0` when `timestamp` is `null`. In
`src/routes/+layout.svelte:288` actions are dispatched on the *first* snapshot
event for a given doc id, including pending writes whose
`serverTimestamp()` is still `null`. The reducer is not re-run when the
"modified" event fires with the real timestamp.

Concrete consequences for the dispatching client:

- Every binding interval the local user creates during a session has
  `validFromMs = 0` (e.g. `inventory.ts:307` → `bindNewInventoryEntity`).
- A subsequent rename of that key calls `renameInventoryEntityKey` with
  `atMs = 0` (when the rename is also pending), producing the empty interval
  `[0, 0)`. The `findActiveBindingInterval` later falls back to
  `bindNewInventoryEntity(..., 0, "...:backfill")`, materialising a phantom
  entity (`inventory.ts:375-378`).
- Reuse of the same key by the same client then opens a second `[0, inf)`
  interval, so `findBindingIntervalAt` (`inventory.ts:259`) can resolve any
  historical query to the *reused* entity instead of the original.

Other clients see real server timestamps and behave correctly, so the bug is
session-local for the actor. It is masked on cold reload because
`action-cache.ts` only stores actions whose `change.type === "added"` and
`!hasPendingWrites` (`redux-firestore.ts:401-403`). The new tests use
`withBroadcastMeta` which always supplies a non-null timestamp, so they do
not catch this.

Suggested fixes:

- In `bindNewInventoryEntity` and `renameInventoryEntityKey`, refuse to write
  intervals when `atMs <= 0`; or buffer such actions until the modified event
  with a real timestamp.
- Re-applying the action on the modified event would also work, but requires a
  way to make the binding helpers idempotent on the second apply.

### 2.2 Resolver does not flag "missing historical binding"

The design specifies four `outcome` codes
(`resolved`, `missing_historical_binding`, `ambiguous_historical_binding`,
`missing_current_key`) and explicitly calls for the
`missing_historical_binding` test to "record an exception and not mutate
shipped counts" (design §Testing Strategy item 4).

`resolveHistoricalInventoryKey` (`inventory.ts:437-455`) returns only
`{ itemKey, entityId? }`. When no interval covers `effectiveAtMs` it silently
falls back to the canonicalised raw key. Callers
(`resolveLineItemInventoryKey` at `inventory.ts:773-792`) cannot distinguish
"there was no binding" from "I resolved it"; if the key has been *reused*
since the order was placed, the reconciliation will be applied to the wrong
current entity (the new owner), with no exception logged.

The design's testing strategy item 4 has no corresponding test in
`tests/shopify-sync.test.ts`.

Suggested fix: extend the resolver return type with an explicit `outcome`
field as designed, and either log a `shopifyExceptions[orderID]` entry or
stop the inventory mutation when the outcome is
`missing_historical_binding`.

### 2.3 `isManualRetype` heuristic is fragile

`applyOrderReconciliation` (`inventory.ts:1068-1100`) uses
`fact && fact.itemKey !== resolvedKey && fact.rawSku === rawSku` to decide
whether to keep a manually retyped line through reconciliation. Two problems:

1. `fact.rawSku` is not populated on legacy facts persisted before this
   branch, so the comparison `undefined === rawSku` is always false and the
   manual retype is silently overwritten on re-reconciliation.
2. `shopify_order_created` (`inventory.ts:906-909`) does not perform the same
   check — it always overwrites `fact.itemKey` with `canonicalKey`. A
   duplicate / replayed `orders/create` event after a manual retype reverts
   the retype.

Both gaps come back to the same root cause: `retype_item` does not record any
identity-level fact saying "this order line should resolve to entity X
regardless of raw SKU." A more durable fix is to write a per-line override
into `shopifyFacts.lines[id]` (e.g. `manualEntityId`) and have both reducers
respect it.

### 2.4 `retype_item` semantics vs the binding model

`retype_item` calls `bindNewInventoryEntity(newItemKey, ...)`
(`inventory.ts:1499-1505`). For an already-existing key this is a no-op (the
helper returns the existing entityId without touching intervals), so the call
is mostly cosmetic. But the action's effect — moving an *order line* from
keyA to keyB while both items continue to exist — is not really an entity
event at all. The current code never updates the source entity's intervals
and never updates `idToHistory` on the source-side via the binding index;
all of that is handled inline in the reducer.

The design (§Actions That Must Update Bindings) lists `retype_item` among
the binding-updating actions, but it is silent on what the update should
*do*. Worth either:

- Documenting in the design that `retype_item` is a per-order override and
  *not* an entity rename, and dropping the cosmetic
  `bindNewInventoryEntity` call; or
- Promoting it to a real "manual override" stored on the order line so
  reconciliation can look it up (see 2.3).

### 2.5 Merge case leaves multiple entities pointing at one current key

`renameInventoryEntityKey` (`inventory.ts:353-412`) handles the "merge into
existing key" path correctly enough for forward lookups: closing source
intervals, leaving the target's active interval alone, and updating
`currentKeyByEntityId` for both entities. But:

- `entityIdByCurrentKey[newKey]` is overwritten only when the new key has no
  active owner. After a merge, only the *target* entity is reachable via
  the reverse map (`inventory.ts:392-406`), although both entities are now
  bound to that key.
- The design (§Merge Items) calls for "explicit merge actions that identify
  the surviving entity" and for an exception when intent is ambiguous. The
  current `update_field`/`rename_subtype` path silently merges with no
  audit trail in `keyIdentity`.

For the immediate goal (reconciliation correctness) this is acceptable, but
it should be flagged as deferred work, not "merge handled."

### 2.6 Other smaller issues

- **`fact.rawSku ||= rawSku`** (`inventory.ts:908, 1093`): empty-string
  `rawSku` is falsy and will be re-written every replay. Probably harmless,
  but `fact.rawSku ??= rawSku` is the intended semantics.
- **Backfill at atMs=0** in `renameInventoryEntityKey`
  (`inventory.ts:375-378`) interacts badly with 2.1; consider using `atMs`
  itself or refusing to backfill.
- **`cloneKeyIdentityState` deep-clones intervals** but `archive_inventory`
  (`inventory.ts:1764-1773`) still shallow-copies `idToItem` and
  `idToHistory`. Pre-existing inconsistency, but worth noting that the new
  state is *more* defensive than its neighbours.
- **Type safety**: passing the broadcast id requires `(action as any).id`
  casts at every call site. The reducer-action type
  (`timestamped-case-reducer.ts`) inherits `TimestampedAction` which now has
  optional `id`; the reducers could read `action.id` typed and avoid the
  casts.
- **`update_field` non-subtype path** correctly skips the binding update.

## 3. Test coverage

Present:

- Retype regression for `4901681382316` → `4901681382316Standard`.
- Chained rename `A→B→C` with key reuse for `A`.
- Manual `retype_item` preserved across `shopify_order_reconciled`.
- Fallback to current key when no historical interval exists.
- Refund applied to renamed current key.

Missing relative to the design's testing strategy:

- §Testing item 4 — "raw SKU has no interval at effective time, exception
  recorded, shipped untouched." The implementation does not yet record the
  exception (see 2.2), so the test cannot pass without code changes.
- §Testing item 5 — order fact created before a later replayed rename,
  verifying the stored fact follows the rename. The refund test partially
  covers this for `idToItem`, but does not assert on
  `shopifyFacts.lines[*].itemKey` after a rename that happens *after* the
  fact is recorded.
- A pending-write scenario (§2.1) — would need a test harness that simulates
  a Firestore pending write with `timestamp: null` followed by a confirmed
  modification.

## 4. Design adherence at a glance

| Design item | Status |
| --- | --- |
| `KeyBindingInterval` shape, three-map index | Implemented (`inventory.ts:71-101`) |
| `entityId = "${docId}:${originalKey}"` | Implemented (`inventory.ts:254-257`) |
| `bindNewEntity` / `renameEntity` / `closeEntity` helpers | Implemented |
| `resolveHistoricalInventoryKey` | Implemented, but no `outcome` field (2.2) |
| `effectiveAtMs` from order business time | Implemented (`inventory.ts:763-768`) |
| Binding updates on listed key-changing actions | All call sites present |
| `OrderLineFact` carries raw and resolved | `ShopifyLineFact.rawSku/entityId` added |
| Rename rewrites order facts and inventory references | Implemented via `rewriteOrderItemKeyReferences` |
| Merge actions explicit | Not implemented; silent merges still allowed (2.5) |
| Split: close source interval, new entity per output | Implemented (`inventory.ts:1947-1959`) |
| Pending-write / replay determinism | Not yet correct for the dispatching client (2.1) |

## 5. Recommendation

Land the work as a strong first step but, before relying on the binding index
for reconciliation in production, address:

1. **§2.1 Pending writes** — most likely to silently corrupt the dispatcher's
   intervals. Either guard against `atMs <= 0` or re-run the binding update
   on the modified snapshot.
2. **§2.2 Resolver outcome** — add the explicit outcome and surface
   `missing_historical_binding` as a Shopify exception, then add the
   matching test.
3. **§2.3 Manual retype durability** — write the override onto the order
   line so both `shopify_order_created` and reconciliation respect it
   independently of `rawSku` presence.

The remaining items (merge audit, dead `bindNewInventoryEntity` call in
`retype_item`, type-safety cleanups) are quality improvements rather than
correctness blockers.
