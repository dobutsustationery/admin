# Ghost IDs and Canonicalization Collisions

## Purpose

Add observability for two key-integrity risks without changing existing reducer behavior:

1. Ghost ID access after subtype renames.
2. Canonicalization collisions where multiple incoming IDs map to one canonical ID.

All detection is audit-only and must not block or alter action processing.

## Requirements

- Maintain a list of IDs that become ghosts after re-key operations.
- Log every access attempt against ghost IDs.
- Detect collisions globally (not per-page/per-range), aggregating all incoming IDs seen for each canonical ID.
- Show key-audit results in the UI, for example at the bottom of `/audit`.

## Design

### State: `keyAudit` slice

```ts
interface KeyAuditState {
  ghostMap: Record<string, GhostSourceRecord>;
  ghostAccessEvents: GhostAccessEvent[];
  canonicalIncomingIndex: Record<string, Record<string, true>>;
  canonicalCollisions: Record<string, CanonicalCollisionReport>;
}
```

`ghostMap`

- `ghostId -> { canonicalId, janCode, oldSubtype, newSubtype, renamedAtMs, renamedByActionType }`
- Represents IDs that would be ghosts in the pre-canonical flow.

`ghostAccessEvents`

- Append-only audit events for attempted access of stale/missing IDs.
- Records timestamp, action type, payload path, requested ID, canonical candidate, and outcome.

`canonicalIncomingIndex`

- Global map of all incoming IDs ever observed for each canonical ID in memory.

`canonicalCollisions`

- One report per canonical ID when >1 distinct incoming ID has been seen.
- Stores full incoming ID set and occurrence metadata.

## Detection Points

### Ghost registration

When a subtype rename re-keys an item and the old key is removed:

- `rename_subtype`
- `update_field` where `field === "subtype"`

Register old key as ghost with provenance.

### Ghost access detection

Scan incoming ID fields on key-bearing actions (e.g. `payload.id`, `payload.itemKey`, `payload.sourceId`).
If the requested ID is in `ghostMap`, or missing while canonical form resolves differently, log access event.

### Global collision detection

For every incoming ID observation:

1. Canonicalize incoming ID.
2. Insert into `canonicalIncomingIndex[canonicalId]`.
3. If distinct IDs for canonical ID > 1, update `canonicalCollisions[canonicalId]` with full incoming set.

This is global for the in-memory replay horizon.

## Behavior Contract

- No reducer semantics change.
- No action rejection.
- No merge logic changes.
- Audit signals only.

## UI

Render key-audit tables at the bottom of `/audit`:

- Ghost ID map
- Ghost access events
- Canonical collision reports (global)

## Initial Implementation Status

Implemented:

- `src/lib/key-audit-slice.ts`
- Root reducer instrumentation in `src/lib/root-reducer.ts`
- `/audit` rendering of key-audit data in `src/routes/audit/+page.svelte`

Not implemented yet:

- Persisting key-audit data to Firestore/broadcast
- Cross-session global accumulation

## Notes

No ring buffers are used in this first version because expected event volume is small.
