# Review: Temporal Key Bindings Implementation

Reviewing `codex/temporal-key-bindings-design` against
`docs/design/TEMPORAL_KEY_BINDINGS_DESIGN.md`.

Three review passes:

- **Pass 1** — initial implementation through commit `f534d1f`.
- **Pass 2** — Gemini's first round of refinements in `3cb2703`
  ("Refine temporal key bindings: address pending writes and manual retype
  durability").
- **Pass 3** — Gemini's second round in `252fa5b`
  ("Refine temporal key bindings: address reconciliation safety and pending
  write edge cases").

Files in this branch:

- `docs/design/TEMPORAL_KEY_BINDINGS_DESIGN.md` (new)
- `docs/design/README.md`
- `src/lib/inventory.ts`
- `src/lib/timestamped-action.ts`
- `tests/shopify-sync.test.ts` (19 cases after pass 3)
- `tests/unit/shopify-history.test.ts` (4 cases)
- `GEMINI_RESPONSE.md`, `CLAUDE_REVIEW.md`

Test status after pass 3: **`bun run test` → 268 passed, 1 skipped**, including
the 19 cases in `tests/shopify-sync.test.ts`.

## 1. What pass 3 changed

Three production code edits and three new tests, plus an updated
`GEMINI_RESPONSE.md`.

### 1.1 Reconciliation no longer subtracts shipped on missing-binding (§3.1)

`applyOrderReconciliation` now carries the unresolved line forward into
`itemQtyMap` before the diff loop runs (`inventory.ts:1167-1182`):

```ts
} else {
  // resolution failed
  if (fact) {
    const canonicalKey = canonicalizeInventoryItemKey(fact.itemKey);
    const currentQty = rawOrder.cancelled_at
      ? 0
      : li.quantity - (li.refund_quantity || 0);
    itemQtyMap[canonicalKey] =
      (itemQtyMap[canonicalKey] || 0) + currentQty;
  }
  // ...record exception
}
```

The diff loop (`inventory.ts:1199-1220`) sees matching values in
`itemQtyMap` and `currentInventoryImpact`, so `diff = 0` and shipped is
untouched. Verified by the new test
`does not mutate shipped count for previously resolved lines if they later
fail resolution (§3.1)`.

Caveat: the carry-forward uses `li.quantity - li.refund_quantity` rather
than the previous `order.items` impact for that key. If the new payload's
quantity differs from what the prior fact recorded (e.g. quantity changed
upstream while the binding became unresolvable), the diff is non-zero and
shipped is adjusted — the design's "do not mutate" contract is honoured
only when quantities match. For the realistic case of the same payload
re-resolving differently, this is fine. A tighter fix would copy from
`currentInventoryImpact[canonicalKey]` instead.

### 1.2 Phantom-entity guard in `bindNewInventoryEntity` (§3.2)

`inventory.ts:310-323`:

```ts
const activeInterval = findActiveBindingInterval(
  identity.intervalsByKey[key],
);
if (activeInterval) {
  identity.entityIdByCurrentKey[key] = activeInterval.entityId;
  identity.currentKeyByEntityId[activeInterval.entityId] = key;
  return activeInterval.entityId;
}
```

Before allocating a new entity, the helper now adopts any active
(open-ended) interval still indexed against the key. This protects against
state where `intervalsByKey[key]` carries an active binding but
`entityIdByCurrentKey[key]` is missing — for instance, a future bug or
partial state migration that drops the reverse map.

In the current code paths (renames always close the source interval and
delete the reverse map together), there is no normal route into that
desynced state, so the guard is purely defensive. It is harmless and the
runtime cost is `findActiveBindingInterval` (O(n) over a key's intervals,
which is small in practice).

### 1.3 `retype_item` updates `manualEntityId` even when itemKey already moved (§3.3)

`inventory.ts:1584-1593`:

```ts
if (
  fact.itemKey === itemKey ||
  (fact.itemKey === newItemKey && !fact.manualEntityId)
) {
  fact.itemKey = newItemKey;
  if (newEntityId) {
    fact.manualEntityId = newEntityId;
  }
}
```

The added second condition catches the case where the optimistic apply
already set `fact.itemKey` to `newItemKey` but did not record
`manualEntityId` (because the bind helper guarded out at
`atMs <= 0`). On a subsequent dispatch with a real timestamp, the loop
matches by `newItemKey` and back-fills `manualEntityId`.

**Practical reach:** under `+layout.svelte:271-289` an action is
dispatched at most once per id per session (`executedActions[id]` and
`store.getState().history.executedActions[id]` both gate it). For the
dispatching client, the pending apply *is* the only apply; the modified
snapshot does not re-dispatch. Confirmed clients (other users, cold
reload) only ever see a single apply with a real timestamp, where
`fact.itemKey === itemKey` matches the original first condition. So the
new `(fact.itemKey === newItemKey && !fact.manualEntityId)` branch fires
only if the same id is dispatched twice — which I could not produce from
the normal Firestore listener path.

To verify the branch's behaviour I ran a small probe (twin dispatches of
`retype_item` with the same id) and observed:

- `fact.manualEntityId` is correctly back-filled. ✅ (this is the fix.)
- `order.items[*].qty` is **doubled** (1 → 2) because the reducer
  unconditionally adds `qty` to the new key's order line on every dispatch.
- `idToItem[*].shipped` is correct because the optimistic apply was a
  no-op for shipped (target item did not yet exist).

So the §3.3 fix is correct *for what it claims to fix* (manualEntityId
back-fill), but the underlying retype_item reducer is not idempotent
under double-dispatch in general — `qty` accumulates. Since the double
dispatch does not actually happen in production, this is not a blocker.
Worth noting because the new test asserts only on `shipped` and
`manualEntityId`; an `order.items` assertion would fail.

If a future change widens the dispatch path so retype_item *can* run
twice (e.g. cache invalidation that re-dispatches confirmed actions),
this latent non-idempotency would surface.

### 1.4 Test for "stored fact follows a later replayed rename" (§3.5)

No code change — the new test
`updates stored line facts when an item is renamed (§3.5)` only verifies
that `rewriteOrderItemKeyReferences` already does what the design wants:
after `rename_subtype`, `shopifyFacts.lines[*].itemKey` reflects the new
key. Useful regression coverage.

## 2. Status of the original concerns

| Concern | Pass 1 | Pass 2 | Pass 3 |
| --- | --- | --- | --- |
| §2.1 Pending writes corrupt intervals | open | fixed (atMs guard) | — |
| §2.2 Resolver outcome | open | fixed (`outcome` field) | — |
| §2.3 Manual retype durability | open | fixed (`manualEntityId`) | — |
| §3.1 Reconciliation mutates on missing binding | — | open | fixed |
| §3.2 Phantom entity for orphaned key | — | open | guarded |
| §3.3 Pending → confirmed retype lifecycle | — | open | fixed (under double-dispatch) |
| §3.4 Explicit merge action | — | deferred | still deferred |
| §3.5 Stored fact follows later rename | — | open (test) | covered |
| §3.6 Type-safety casts | — | deferred | still deferred |

## 3. Concerns remaining after pass 3

### 3.1 §3.1 carry-forward uses `li.quantity`, not the prior impact

If the missing-binding line's quantity in the new payload differs from
what the prior fact established, the diff loop will still adjust shipped
by the difference. For the realistic "same payload re-resolves
differently" case this never triggers, but the design's literal "does not
mutate shipped counts" is conditional. Cheap follow-up: derive the
carried quantity from `currentInventoryImpact[canonicalKey]` instead of
`li.quantity`.

### 3.2 retype_item is not idempotent on order.items

Double-dispatching `retype_item` with the same id increments
`order.items[*].qty` twice. In production this cannot happen because of
the `executedActions` guard, so it does not affect users today; flagged
for future awareness if action de-dupe ever changes.

### 3.3 Merge case still under-modelled (§3.4)

Pass 1's §2.5 stands and Gemini explicitly defers it again. Forward
lookups remain correct, but `entityIdByCurrentKey` only points at the
surviving target entity after a merge, so a reverse lookup cannot find
the absorbed entity. Recommend filing a follow-up to introduce an
explicit `merge_inventory_items` action with surviving-entity intent.

### 3.4 Manual retype during pending dispatch (production gap, not a regression)

The §3.3 fix solves the case where `retype_item` gets re-dispatched with
a real timestamp. In production, that re-dispatch does not happen — the
dispatcher's session sees only the optimistic apply (`atMs = 0`,
`bindNewInventoryEntity` returns `undefined`, so `manualEntityId` is
never set). For the rest of that session, a reconciliation has to fall
back to the legacy `fact.itemKey !== resolvedKey && fact.rawSku === rawSku`
heuristic, which works only because `fact.rawSku` is now populated for
new facts.

This is a narrower window than pass 1 worried about, and cold reload
restores correctness, but the fix as written doesn't actually close it
for the live session. A real fix would either re-dispatch the action on
the modified snapshot when the timestamp upgrades from `null` to a real
value, or deferred-bind on the next reducer entry that sees a real
timestamp.

### 3.5 Type-safety polish (still deferred)

`(action as any).id` and `(action as any).timestamp` casts remain in the
reducers. Acknowledged; defer.

## 4. Design adherence at a glance (post pass 3)

| Design item | Status |
| --- | --- |
| `KeyBindingInterval` shape, three-map index | Implemented |
| `entityId = "${docId}:${originalKey}"` | Implemented |
| Bind / rename / close helpers with pending-write guards | Implemented |
| Resolver returning `outcome` | Implemented |
| `effectiveAtMs` from order business time | Implemented |
| Binding updates on listed key-changing actions | Implemented |
| `OrderLineFact` carries raw, resolved, manual override | Implemented |
| Rename rewrites order facts and inventory references | Implemented |
| Missing-binding exceptions on Shopify lines | Implemented |
| Reconciliation preserves shipped on missing binding | Implemented (with quantity caveat §3.1) |
| Manual retype durable across reconciliation | Implemented (within window §3.4) |
| Pending-write / replay determinism | Guarded |
| Explicit merge actions, surviving entity recorded | Still deferred (§3.3) |

## 5. Tests after pass 3

Persisted from pass 2:

- Retype regression for `4901681382316` → `4901681382316Standard`
- Chained rename `A→B→C` with key reuse for `A`
- Manual `retype_item` preserved across `shopify_order_reconciled`
- Refund applied to renamed current key
- `records an exception and does not mutate shipped counts if no historical
  binding interval exists`
- `guards against pending writes with atMs=0`

Added in pass 3:

- `does not mutate shipped count for previously resolved lines if they
  later fail resolution (§3.1)`
- `handles retype_item pending -> confirmed lifecycle (§3.3)`
- `updates stored line facts when an item is renamed (§3.5)`

Still missing (smaller):

- A reconciliation test where the unresolved line's quantity changed
  between dispatches — would catch §3.1's `li.quantity` vs prior-impact
  edge.
- An assertion on `order.items[*].qty` in the §3.3 test would document
  the double-dispatch non-idempotency.

## 6. Recommendation

After three rounds, the temporal-key-bindings work covers the design's
core semantics, all 268 unit tests pass, and the major correctness
concerns from the first two reviews are addressed. The remaining items
are cosmetic, defensive, or genuinely deferred (merge auditing, type
casts, the pending-only manualEntityId window).

This is a good state to merge as the foundational layer. Suggested
follow-ups, in priority order:

1. **§3.4** — pending-window manualEntityId. Either re-dispatch on the
   modified snapshot or deferred-bind on the next reducer entry. This is
   the one place where the dispatcher's live session does not match the
   eventual replayed state.
2. **§3.3** — explicit `merge_inventory_items` action so post-merge
   reverse lookups can find absorbed entities.
3. **§3.1** — switch the carry-forward to `currentInventoryImpact[key]`
   to make "do not mutate" hold unconditionally.
4. **§3.2** — flag retype_item's `order.items` non-idempotency, either
   with code (subtract first, then add) or a comment, in case action
   dedupe ever loosens.
5. **§3.5** — drop the `(action as any)` casts by threading
   `TimestampedPayloadAction` through the relevant reducers.
