# Temporal Key Bindings Design

## Status

Proposed.

## Problem

Inventory item keys are not stable identities. They are operational names derived
from JAN code plus subtype. For example, a product can begin life as:

```text
4901681382316
```

and later become:

```text
4901681382316Standard
```

when a subtype is discovered during listing creation.

Order reconciliation is different from normal order ingestion because it can
discover an arbitrarily old external order at the current wall-clock time. The
payload from that old order contains SKUs from the time the order was placed.
If the reducer resolves those SKUs against only the current inventory keys, it
can miss the correct item or apply inventory impact to the wrong item.

The concrete failure mode:

1. JAN `4901681382316` existed with no subtype.
2. An order was placed using SKU `4901681382316`.
3. Listing creation later retyped the inventory item to
   `4901681382316Standard`.
4. A later reconciliation action arrived for the old order, still containing
   SKU `4901681382316`.
5. Current inventory no longer had key `4901681382316`, so reconciliation could
   not safely apply the old order to the current item.

## Constraints

- The system is event sourced. State is derived by replaying broadcast actions
  from the beginning.
- We do not need a one-time migration step for old persisted state; replay can
  rebuild derived structures.
- We should not insert late reconciliation facts into the historical timeline.
  Conceptually this is clean, but it can rebase all later actions and may not be
  safe for the current system.
- The ingestion layer should continue to store raw external facts. Mapping
  external SKUs to local inventory keys belongs in reducer logic.
- `keyAudit.ghostMap` is audit and observability data. It should not become the
  source of truth for inventory reconciliation.
- Key reuse must be handled. A key that used to name one item can later name a
  different item.

## Core Idea

Track item identity separately from item key.

Then order reconciliation can answer this question:

```text
Given raw SKU K and historical order time T,
which item identity did K name at T,
and what is that identity's current key now?
```

This is a temporal binding lookup:

```text
(historical key, historical time) -> entity id -> current key
```

The event log remains the source of truth. The binding index is derived during
replay from the same actions that create, rename, split, and merge inventory
items.

## Proposed State

Add a derived key identity structure to inventory state, or to a small adjacent
slice consumed by the inventory reducer:

```ts
type InventoryEntityId = string;

interface KeyBindingInterval {
  key: InventoryItemKey;
  entityId: InventoryEntityId;
  validFromMs: number;
  validToMs?: number;
  openedByActionType: string;
  closedByActionType?: string;
}

interface InventoryKeyIdentityState {
  intervalsByKey: Record<InventoryItemKey, KeyBindingInterval[]>;
  currentKeyByEntityId: Record<InventoryEntityId, InventoryItemKey>;
  entityIdByCurrentKey: Record<InventoryItemKey, InventoryEntityId>;
}
```

The same structure may be stored normalized in another shape if easier, but it
must preserve these semantics:

- `intervalsByKey[key]` records when a key was bound to each entity.
- `currentKeyByEntityId[entityId]` records the latest active key for an entity.
- `entityIdByCurrentKey[key]` records which entity currently owns an active key.

Intervals are half-open:

```text
validFromMs <= T < validToMs
```

If `validToMs` is absent, the binding is active until further notice.

## Entity IDs

An entity ID is a stable identity for "the same inventory item across key
renames." It should be deterministic under replay.

Broadcast actions already have unique, stable document IDs. Use the document ID
of the action that first creates the independent inventory entity, plus the
entity's original inventory key, as the entity ID:

```ts
entityId = `${creatingActionDocId}:${originalInventoryKey}`;
```

`originalInventoryKey` is the key at creation time, meaning JAN code plus subtype
when subtype exists, or just the JAN code when it does not.

The action document ID makes the entity unique and replay-stable. Appending the
original inventory key makes the ID human readable and also distinguishes
multiple entities created by the same broadcast action, such as a bulk import.

Requirements:

- It must be stable for the same replayed action log.
- It must not change when the item key changes.
- It must be created when the system first sees a new independent inventory
  item.
- It should be treated as an opaque ID after creation. Reducer logic should not
  parse meaning back out of the string.

## Binding Operations

The reducer should maintain the index through small helper operations.

### Bind New Entity

Used when a key first appears as a new independent item:

```ts
bindNewEntity(key, atMs, actionType, creatingActionDocId);
```

Effects:

- Create `entityId` from the creating broadcast action document ID and `key`.
- Open interval `key -> entityId` at `atMs`.
- Set `currentKeyByEntityId[entityId] = key`.
- Set `entityIdByCurrentKey[key] = entityId`.

### Rename Entity

Used when a key changes but the underlying item identity remains the same:

```ts
renameEntity(oldKey, newKey, atMs, actionType);
```

Effects:

- Find `entityId = entityIdByCurrentKey[oldKey]`.
- Close the active interval for `oldKey` at `atMs`.
- Open interval `newKey -> entityId` at `atMs`.
- Set `currentKeyByEntityId[entityId] = newKey`.
- Remove `entityIdByCurrentKey[oldKey]`.
- Set `entityIdByCurrentKey[newKey] = entityId`.

### Reuse Key

Used when a key that previously appeared in history becomes a new independent
item again:

```ts
bindNewEntity(reusedKey, atMs, actionType, creatingActionDocId);
```

This is not special if intervals are modeled explicitly. The old interval for
the same key was already closed when the previous entity was renamed away. A new
interval for the reused key opens with a new entity id.

### Split Item

Splitting one inventory item into multiple inventory items creates new
independent identities unless the action explicitly says one split is a rename
of the original entity.

Default rule:

- Close the source key interval if the source item is removed.
- Create a new entity for each split output key.

If a future split UI needs "source item becomes this one output, plus new
outputs," the action should carry that intent explicitly.

### Merge Items

Merging two keys into one entity is harder because historical references to
both keys may need to resolve to the surviving current key.

Default rule:

- Prefer explicit merge actions that identify the surviving entity.
- Close the losing key's active interval at merge time.
- Add an alias interval from the losing key to the surviving entity only if the
  key remains semantically valid for historical lookup at that time.

If the reducer cannot determine merge intent safely, it should record an
exception rather than guess.

## Actions That Must Update Bindings

The binding index should be updated by reducer handling for these inventory key
events:

- `update_item`
- `bulk_import_items`
- `update_field` where `field === "subtype"`
- `rename_subtype`
- `retype_item`
- `fix_jancode`
- `split_inventory_item`
- future merge actions, if introduced

The first two are important because they introduce or refresh items. They should
not create a new entity if the key is already active. They create a new entity
only when an independent key appears with no active entity.

## Historical Resolution

Add a resolver used by Shopify and Etsy order reducers:

```ts
interface HistoricalSkuResolution {
  rawSku: string;
  effectiveAtMs: number;
  entityId?: InventoryEntityId;
  currentItemKey?: InventoryItemKey;
  outcome:
    | "resolved"
    | "missing_historical_binding"
    | "ambiguous_historical_binding"
    | "missing_current_key";
}

function resolveHistoricalInventoryKey(
  identityState: InventoryKeyIdentityState,
  rawSku: string,
  effectiveAtMs: number,
): HistoricalSkuResolution;
```

Algorithm:

1. Canonicalize the raw SKU into the local inventory key format.
2. Find intervals for that key.
3. Binary search for the interval active at `effectiveAtMs`.
4. Read the interval's `entityId`.
5. Resolve `currentKeyByEntityId[entityId]`.
6. Verify that current key still exists in `idToItem`.
7. Return the current key for inventory impact.

If there is no interval for the key, the reducer may fall back to exact current
key lookup only when that key currently exists and has no rename history. This
supports simple items without forcing every old action to be represented in the
index before the first implementation lands.

## Reconciliation Effective Time

Order reconciliation actions are discovered now but represent historical
external facts.

Resolution should use the external order's business time, not the broadcast
action timestamp.

For Shopify line placement:

```ts
effectiveAtMs = Date.parse(rawOrder.processed_at || rawOrder.created_at);
```

For later order-state facts:

- Cancellation impact should use `rawOrder.cancelled_at` when available.
- Refund impact should use the refund timestamp.
- A reconciliation snapshot should establish line identity using the original
  line/order time, then apply current quantity semantics idempotently.

This distinction is important:

- `receivedAtMs`: when we learned about the fact.
- `effectiveAtMs`: when the external business fact happened.

The action stays at its received position in the broadcast log. Only SKU
resolution uses `effectiveAtMs`.

## Order Fact Storage

After resolution, order facts should preserve both the raw historical SKU and
the resolved current item key.

Suggested line fact shape:

```ts
interface OrderLineFact {
  rawSku: string;
  effectiveAtMs: number;
  entityId?: InventoryEntityId;
  itemKey: InventoryItemKey;
  placed: number;
  cancelled: number;
  refunded: number;
}
```

`itemKey` should be the current key at replay time. If a later rename action is
processed after the order fact in replay, the rename reducer should update
stored order facts for the same entity to the new current key.

This keeps future refunds and cancellations from re-resolving stale raw SKUs
against the wrong time or wrong current state.

## Interaction With Retypes

When a retype happens, the reducer must move all existing references for the
same entity:

- `inventory.idToItem`
- `inventory.idToHistory`
- `orderIdToOrder[*].items`
- `shopifyFacts.lines[*].itemKey`
- `etsyFacts.lines[*].itemKey`
- listing/id maps that use inventory keys, if they represent the same entity

The binding index provides the entity id needed to identify these references
without relying on old key string equality alone.

## Example

Timeline:

```text
t0: A exists
t10: A -> B
t20: B -> C
t30: A is reused for a different item
```

Intervals:

```text
A: [t0,  t10) -> entity1
B: [t10, t20) -> entity1
C: [t20, inf) -> entity1
A: [t30, inf) -> entity2
```

Current names:

```text
entity1 -> C
entity2 -> A
```

Lookups:

```text
resolve(A, t5)  -> entity1 -> C
resolve(B, t15) -> entity1 -> C
resolve(A, t15) -> missing
resolve(A, t35) -> entity2 -> A
```

This handles key reuse without needing to insert late reconciliation events into
the old timeline.

## Why Not Use `keyAudit.ghostMap`

`keyAudit.ghostMap` has the wrong shape for business logic:

- It maps `oldKey -> canonicalId`, but does not model time intervals.
- It cannot safely distinguish key reuse.
- It is designed as observability and should not alter reducer behavior.
- It does not identify the stable item entity behind a key.

The binding index can feed audit views later, but audit data should not feed
inventory reconciliation.

## Testing Strategy

Add focused reducer tests for:

1. Basic rename:
   - `A` exists.
   - `A -> B`.
   - Late reconciliation for order time before rename with raw SKU `A`.
   - Inventory impact applies to `B`.

2. Multi-hop rename:
   - `A -> B -> C`.
   - Late reconciliation for raw SKU `A` before first rename.
   - Inventory impact applies to `C`.

3. Key reuse:
   - `A -> B`.
   - New independent item later uses `A`.
   - Raw SKU `A` before rename resolves to `B`.
   - Raw SKU `A` after reuse resolves to the new `A`.

4. Missing historical binding:
   - Raw SKU has no interval at the order effective time.
   - Reconciliation records an exception and does not mutate shipped counts.

5. Existing order facts follow later rename:
   - Order fact resolves to `A`.
   - Later replayed action renames `A -> B`.
   - Stored order line fact and order item point at `B`.

6. Refund/cancellation after rename:
   - Original line identity was established from the order time.
   - Refund action adjusts the current key for the same entity.

7. Real regression fixture:
   - JAN `4901681382316` starts as bare key.
   - It is later retyped to `4901681382316Standard`.
   - A late Shopify reconciliation payload contains raw SKU `4901681382316`.
   - The final order facts reference `4901681382316Standard`.
   - Shipped count is correct and no base-key ghost remains in order facts.

## Implementation Plan

1. Add the identity state shape and pure helper functions.
2. Update item creation/import/update reducers to create bindings for new
   independent keys.
3. Update key-changing reducers to rename entities and update existing
   references.
4. Add `resolveHistoricalInventoryKey`.
5. Use the resolver in Shopify order created/updated/reconciled and refund
   paths.
6. Add the regression and edge-case tests above.
7. Add debug/audit UI only after reducer semantics are covered by tests.

## Open Questions

- What is the cleanest reducer API for passing the creating broadcast action
  document ID into every binding update helper?
- Should listing creation express "this variant is a rename of the base item"
  explicitly instead of inferring it?
- How should ambiguous historical bindings be displayed to the user?
- Should binding intervals live inside `inventory` or in a separate slice owned
  by the root reducer?
- Do we need a compact snapshot representation for performance, or are interval
  arrays small enough for now?

## Recommended Direction

Start with the explicit identity binding model, even though it is slightly more
data than a sparse rename map. It is less bug-prone because it gives each
historical key lookup a precise entity answer and handles key reuse naturally.

Do not continue with a flat ghost map as the core fix. The correct abstraction is
temporal key binding:

```text
key at time -> entity -> current key
```
