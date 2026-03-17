# Fix JAN Code Action Design

## Problem

We currently have `retype_item`, but it is order-line scoped (`orderID`, `qty`) and intended for correcting what was packed on an order, not correcting a wrong JAN on an inventory item.

For inventory-level JAN correction, we need a first-class action that re-keys an item across state without requiring an order.

## Why `retype_item` Is Not Enough

- `retype_item` requires an `orderID` and only moves shipped quantity associated with that order.
- It does not represent "this inventory item was keyed under the wrong JAN".
- It is semantically wrong for replay/audit when no order event exists.
- In `+layout`, we already guard against malformed self-retype events, which is another signal this path is not robust for inventory re-keying.

## Proposed Action

```ts
export const fix_jancode = createAction<{
  itemKey: string; // current inventory key (old key)
  newJanCode: string; // corrected JAN
  subtype?: string; // optional override; default = existing subtype
  mergeMode?: "strict" | "merge_if_identical"; // default strict
  reason?: string; // optional audit note
}>("fix_jancode");
```

### Canonicalization Rules

- `itemKey` is canonicalized through `canonicalizeInventoryItemKey`.
- `newJanCode` is normalized with current JAN normalization rules.
- `subtype` defaults to the source item's subtype.
- `targetKey = makeInventoryItemKey(newJanCode, subtype)`.

## Scope: State That Must Be Updated

This action must migrate references from `oldKey` to `newKey`, and from `oldJan` to `newJan` where JAN-based keys exist.

### 1. `inventory` slice

#### `inventory.idToItem`

- Source item must exist (`oldKey`).
- If `oldKey === newKey`: no-op (record idempotent history entry).
- If `newKey` missing: move item to `newKey`, update `janCode`, keep subtype.
- If `newKey` exists:
  - `strict`: abort with no mutation + history note.
  - `merge_if_identical`: allow merge only if `itemsLookIdentical(old, target)` is true.
  - Merge quantities: `qty +=`, `shipped +=`.
  - Keep one canonical item at `newKey`.
- Remove `oldKey` from `idToItem`.

#### `inventory.idToHistory`

- Merge old/new histories into `newKey` (sorted by `val`).
- Add explicit event entry documenting JAN correction and old/new key.
- Remove `oldKey` history bucket after merge (avoid dangling primary lookup).

#### `inventory.orderIdToOrder[*].items`

- Replace every line item `itemKey === oldKey` with `newKey`.
- If an order already has `newKey`, sum quantities into one line.

#### `inventory.hiddenExceptions`

- If `hiddenExceptions[oldKey]` exists, move it to `hiddenExceptions[newKey]`.

#### Not Mutated

- `archivedInventoryState`, `hiddenInventoryState`, `archivedInventoryDate`, `salesEvents` remain historical snapshots and are not rewritten.

### 2. `listings` slice

#### `listings.idToHandle`

- Move mapping `oldKey -> handle` to `newKey -> handle`.

#### `listings.handleToListing`

- Keep listing entity stable.
- If listing carries legacy `(listing as any).janCode === oldJan`, update to `newJan` when safe (single-source or obvious match).

### 3. `photos` slice

`photos.janCodeToPhotos` uses JAN/subtype keys, not inventory item keys.

- Rename group keys:
  - `oldJan` -> `newJan` (blank subtype case)
  - `oldJan:subtype` -> `newJan:subtype`
- Merge if destination group already exists.

### 4. `listingCreation` slice

Draft proposals hold inventory references and JAN-based group references.

- For every proposal:
  - replace `inventoryItemIds` entry `oldKey -> newKey`
  - replace `variants[*].itemId` `oldKey -> newKey`
  - update `photoGroupIds` entries from old JAN-key forms to new JAN-key forms
  - update `variants[*].photoGroupKey` similarly
- If `proposal.janCode === oldJan` and this correction targets the base JAN, re-key proposal to `newJan` and update:
  - `proposals` dictionary key
  - `activeBatchJans`
  - `originalBatchJans`
- If destination proposal key already exists, run deterministic merge policy (same policy as existing proposal merge paths).

### 5. Import slices (to avoid dangling manual-resolution refs)

- `orderImport.resolutions`: rewrite `itemKey` references from `oldKey` to `newKey`.
- `shopifyImport.resolutions`: rewrite `payload.itemKey` references from `oldKey` to `newKey`.

## Root Reducer Orchestration Changes

`root-reducer.ts` should treat `fix_jancode` as a key-mutation event in the same orchestration block as `rename_subtype`/`retype_item`, plus the extra migrations above.

Specifically:

- include `fix_jancode` in key-sync detection
- run listings/photo/listingCreation/import-resolution migrations after core inventory reducer
- emit synthetic logs for any implicit group/proposal renames (same pattern as current synthetic `photos/rename_jan_group`)

## Key Audit / Ghost Mapping

`keyAudit` should register old key as a ghost of new key for `fix_jancode`, same as subtype rename behavior.

- update `getIncomingIdObservations` and ghost-registration branch to include `fix_jancode`
- enables replay/debugging for stale references still using old keys

## Idempotency + Replay Behavior

- Replaying the same `fix_jancode` should be safe:
  - if `oldKey` missing but `newKey` already contains corrected item, treat as no-op.
- Deterministic merge behavior:
  - no time-dependent randomness
  - explicit merge mode in payload

## Invariants After `fix_jancode`

1. `inventory.idToItem[oldKey]` does not exist.
2. `inventory.idToItem[newKey]` exists and has `janCode === newJanCode`.
3. No `orderIdToOrder[*].items[*].itemKey === oldKey`.
4. No `listings.idToHandle[oldKey]`.
5. No `listingCreation` variant/item list reference to `oldKey`.
6. No `photos.janCodeToPhotos` key in old JAN form for the corrected subtype/base key.

## Suggested UI Entry Point

Add a dedicated "Fix JAN Code" control in inventory-facing views (`/inventory` row actions, and optionally `/itemhistory`), not in order views.

Minimal flow:

1. User chooses an item.
2. User enters corrected JAN.
3. UI previews old key -> new key and merge/conflict result.
4. User confirms dispatch of `fix_jancode`.

## Test Plan

### Unit: `inventory` reducer

- move to empty target
- merge into existing identical target
- strict conflict reject
- order line migration + duplicate consolidation
- hidden exception migration
- idempotent replay

### Unit: `rootReducer` orchestration

- listings id map migration
- photos jan group rename/merge
- listingCreation itemId + proposal key rewrite
- import resolution key rewrite
- keyAudit ghost registration

### Replay / integration

- historical log replay with `fix_jancode` in middle of listing creation flow
- verify no stale-key access warnings except expected ghost lookups
