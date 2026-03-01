# Listings Creation – Broadcast-Only Completion Plan

## Scope and assumption

All persistence is via broadcast events. There is no secondary storage (IDB snapshots are just caches). The listings-creation flow must be fully reconstructible from broadcasted actions alone.

## Missing broadcast actions (by requirement)

These are the actions that must exist in the broadcast stream to fully enable listings creation, but are currently missing (either not dispatched or not defined):

### 1) Proposal lifecycle (create/queue/retire) — **Complete**

- `listingCreation/add_proposals` replaces `set_proposals` for additive proposal discovery.
- `listingCreation/remove_proposal` removes proposals and prunes batch state for drop/skip.

### 2) Batch lifecycle (single-worker handoff) — **Complete**

- `listingCreation/start_batch` now includes a stable `batchId` (and `createdAt`) for deterministic resume.

### 3) Draft image changes — **Complete**

- Draft remove uses `photos/uncategorize_photo`.
- Draft add uses `photos/complete_upload` + `photos/categorize_photo`.

### 4) Inventory ↔ listing linkage for future updates — **Complete**

- `inventory/update_field` for `handle` now routes through shared listings handle update logic, so `listings.idToHandle` is updated consistently during replay.

### 5) Drop/approve flow and completion — **Complete**

- `listingCreation/remove_proposal` is dispatched on both “Drop Proposal” and “Approve & Publish”.
- `listingCreation/complete_batch` is broadcast when the last item is resolved.

## Approach to completion (broadcast-only)

### A) Proposal generation and queueing — **Complete**

1. Replace proposal discovery with `add_proposals` (additive, non-destructive).
2. Ensure each generated proposal is broadcast individually (or as a batch payload) and never overwrites unrelated proposals.
3. Introduce `remove_proposal` to drop proposals after approval/skip.

### B) Batch lifecycle and handoff — **Complete**

1. Extend `start_batch` to include `batchId` and `createdAt`.
2. Ensure `complete_batch` is always broadcast on resolution.
3. When batch completes, also broadcast `remove_proposal` for each JAN.

### C) Draft image modifications — **Complete**

1. Draft add uses `photos/complete_upload` + `photos/categorize_photo`.
2. Draft delete uses `photos/uncategorize_photo` to drop from a JAN group.
3. ListingEditor updates from `photos.janCodeToPhotos` only.

### D) Ensure listing ↔ inventory linkage is broadcasted — **Complete**

1. Handle updates to `inventory.handle` inside listings reducer to update `idToHandle`.
2. This guarantees future inventory updates can hydrate listing updates via broadcast replay.

### E) UI wiring for drop/approve/complete — **Complete**

1. “Drop Proposal” dispatches `remove_proposal`.
2. “Approve & Publish” dispatches `remove_proposal` for the approved handle group.
3. `complete_batch` is broadcast when the last item is resolved.

## Minimal action set to add/emit (remaining)

- None.

## Expected outcome

With the above actions emitted through the broadcast store, the listing-creation workflow becomes fully event-sourced: proposals and batches are reconstructible, draft edits persist, images can be updated, and approved listings maintain an inventory linkage for subsequent edits.
