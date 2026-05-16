# Manage Variants modal — cannot remove an erroneous subtype on live listings

## Symptom

On a live listing, opening **Manage Variants** and marking a variant
for removal (the ✕ button → "Removing" badge) leaves the **Confirm
Changes** button disabled. There is no way to take an
incorrectly-created subtype off a live listing through the UI.

## Root cause

`src/lib/components/ListingVariantModal.svelte`.

The modal enforces a **quantity-conservation invariant**: the sum of
the per-variant allocations must equal the total stock available on
the listing.

```ts
// totalAvailable: sum of EVERY associated item's qty (line ~112)
$: totalAvailable = (() => {
  const sourceMap = new Map<string, number>();
  associatedItems.forEach((i) => sourceMap.set(i.id, i.qty || 0));
  if (selectedItemToAdd && !sourceMap.has(selectedItemToAdd.id)) {
    sourceMap.set(selectedItemToAdd.id, selectedItemToAdd.qty || 0);
  }
  return Array.from(sourceMap.values()).reduce((s, q) => s + q, 0);
})();

// totalAllocated: sum of proposedQtys (+ new variant qty) (line ~124)
$: totalAllocated = Object.values(proposedQtys).reduce((s,q)=>s+(q||0),0)
                    + (newVariantQty || 0);

$: isAllocationValid = Math.abs(totalAllocated - totalAvailable) < 0.001;
```

`toggleRemoval` (line ~134) zeroes the removed row's allocation:

```ts
next.add(rowId);
proposedQtys[rowId] = 0; // Zero out qty on removal
```

So when a variant is marked for removal:

- `totalAllocated` **drops** by that variant's qty (its `proposedQtys`
  entry is now `0`), but
- `totalAvailable` is **unchanged** — it still iterates *all*
  `associatedItems`, including the one being removed.

Therefore `totalAllocated < totalAvailable`, `isAllocationValid`
becomes `false`, and the Confirm button is disabled:

```svelte
disabled={!isAllocationValid ||
  (mode === "add" && !selectedItemToAdd && pendingRemovals.size === 0)}
```

The second clause already permits a removal-only save
(`pendingRemovals.size > 0` makes it false). The **only** blocker is
`!isAllocationValid`. A pure removal can never balance — by
definition you are discarding the removed variant's units — so the
modal can never be saved for a removal. This is the logic that
"prevents it."

The conservation invariant is correct for **split** (redistributing N
units among variants — nothing created or destroyed) but wrong for
**removal of an erroneous subtype**, where the whole intent is to
discard a bogus variant and leave the remaining real variants
untouched.

## What removal would do downstream (for reference)

It is only the *gate* that is broken; the downstream is already
wired:

- `handleSave` → `confirmManage` event `{ proposedQtys, removals }`
  (`ListingVariantModal.svelte:206-212`).
- `onConfirmManage` live branch (`listing-detail/+page.svelte:1831`)
  applies `proposedQtys` updates, then `handleRemovals(removals)`.
- `handleRemovals` live branch (`:1565`) dispatches, per removed
  itemId, `update_field({ id, field:"handle", to:"" })` — i.e. it
  **detaches the item from the listing** (clears the handle); it does
  not delete the inventory row. That is the correct semantic for
  "this subtype is on the listing in error — take it off."

## Secondary issue (worth fixing in the same change)

`toggleRemoval` sets `proposedQtys[rowId] = 0`, and `onConfirmManage`
applies `proposedQtys` **before** `handleRemovals`:

```ts
Object.entries(proposedQtys).forEach(([itemId, newQty]) => {
  const item = $store.inventory.idToItem[itemId];
  if (item && item.qty !== newQty) {
    dispatchBroadcast(update_field({ id: itemId, field: "qty",
      from: item.qty, to: newQty }));   // newQty === 0 for removed rows
  }
});
handleRemovals(removals);
```

So a removed variant's inventory row also has its **qty forced to 0**
before its handle is cleared. For a genuinely erroneous subtype
(phantom stock) that is harmless, but if the row happens to be a real
inventory item being detached, this destroys its on-hand quantity as
a side effect. Removal from a listing should not mutate inventory
quantity.

## Proposed clean fix (two small, surgical parts)

### 1. Exclude pending-removal rows from `totalAvailable`

`src/lib/components/ListingVariantModal.svelte`, `totalAvailable`:

```ts
$: totalAvailable = (() => {
  const sourceMap = new Map<string, number>();
  associatedItems.forEach((i) => {
    const rowId = i.variantId || i.id;
    if (pendingRemovals.has(rowId)) return; // removed → not in the pool
    sourceMap.set(i.id, i.qty || 0);
  });
  if (selectedItemToAdd && !sourceMap.has(selectedItemToAdd.id)) {
    sourceMap.set(selectedItemToAdd.id, selectedItemToAdd.qty || 0);
  }
  return Array.from(sourceMap.values()).reduce((s, q) => s + q, 0);
})();
```

Now both sides drop by the removed variant's qty (allocated is
already 0 via `toggleRemoval`; available now excludes it), so a
removal-only change balances and **Confirm enables**. Split/add flows
are unaffected (no removals ⇒ identical to today). The
`pendingRemovals` keying matches the existing `rowId =
i.variantId || i.id` convention, and keying the map by `i.id`
preserves the multi-JAN-shared-listing dedupe behavior.

### 2. Don't zero inventory qty for removed rows

`src/routes/listing-detail/+page.svelte`, `onConfirmManage` live
branch — skip the qty update for ids scheduled for removal so removal
purely detaches:

```ts
const removalSet = new Set(removals);
Object.entries(proposedQtys).forEach(([itemId, newQty]) => {
  if (removalSet.has(itemId)) return; // removal handled below; don't touch qty
  const item = $store.inventory.idToItem[itemId];
  if (item && item.qty !== newQty) {
    dispatchBroadcast(update_field({ id: itemId, field: "qty",
      from: item.qty, to: newQty as number }));
  }
});
handleRemovals(removals);
```

(Optionally also drop the `proposedQtys[rowId] = 0` line in
`toggleRemoval`; part 2 makes it inert, but removing it keeps the
intent clearer. Either is fine — part 2 is the safety-critical half.)

## Scope / risk

- Part 1 is a pure UI gating change in one reactive block; it cannot
  affect replay or stored state.
- Part 2 narrows which `update_field(qty)` actions are dispatched on a
  manage-save; it only *suppresses* a qty write for rows the user is
  removing, which is the desired behavior. It does not change the
  removal path itself (`handleRemovals` still clears the handle).
- No reducer, schema, or replay impact. The downstream removal
  mechanism (`update_field handle → ""`) is unchanged and already
  exercised by the create-mode flow.

## Test plan (when implemented)

- Unit/component: with one variant marked removed and others
  untouched, `isAllocationValid` is `true` and `handleSave` emits
  `confirmManage` with the removed `rowId` in `removals` and no qty
  delta for it.
- E2E (live mode, `e2e/015-listings-creation` style): open Manage
  Variants on a live listing with ≥2 variants, mark one ✕, Confirm is
  enabled, save dispatches `update_field(handle → "")` for the
  removed item and **no** `update_field(qty → 0)` for it; the variant
  disappears from the listing and the other variant's qty is intact.
- Regression: split and add flows still require balanced allocation
  (no `pendingRemovals` ⇒ `totalAvailable` identical to today).
