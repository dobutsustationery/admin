# Multi Entry Point Design

## Goal
Split server-side work by request type so each workload has independent scaling controls, while keeping a unified `sync` event timeline for UI visibility.

Current issue:
- One trigger (`/sync/{id}`) handles both Shopify and Photos work.
- Runtime settings (`maxInstances`, `concurrency`, `memory`) are shared, so tuning for one domain can hurt another.

Target:
- Client writes to `request_*` collections.
- Each function listens only to its own `request_*` collection.
- Function claims request idempotently.
- Function writes lifecycle events directly to `/sync` (claim, api calls, completed/failed).
- UI watches `/sync` only for progress; it does not expect its raw request doc to appear in `/sync`.

## Request Collections
Use one top-level collection per operation:

| Operation | Request Collection | Trigger Function | Sync Namespace |
|---|---|---|---|
| Shopify listing sync | `request_shopify_sync` | `shopifySyncRequest` | `shopify/*` |
| Photo transfer to Drive | `request_photos_transfer` | `photosTransferRequest` | `photos/*` |
| Photo transform (remove_bg, color_correct) | `request_photos_transform` | `photosTransformRequest` | `photos/*` |

Notes:
- Keep payload schema close to current request payloads to minimize migration risk.
- `requestId` remains client-supplied and globally unique.
- Handshake events that the client responds to (for example `photos/image_transfer_secret_provided`) stay in `/sync`, not `request_*`.

## Event Flow
1. UI writes request doc to `request_*`.
2. Trigger fires on create.
3. Function performs idempotent claim using deterministic claim doc id in `sync`:
   - `claim_${requestDocId}`
4. If claim fails (already exists), function exits.
5. If claim succeeds, function writes claimed event to `/sync`.
6. Function executes operation and writes progress/api/final events to `/sync`.
7. UI consumes `/sync` events and updates status.

Important UI behavior change:
- Initiation starts when `*/sync_claimed` appears in `/sync`.
- UI should not rely on seeing its own request create in `/sync`.
- Pending state = request written but no claim event yet (short-lived).

## Common Server Helpers
Introduce shared helpers and use them in all entry-point functions.

1. `shared/request-claim.cjs`
- `claimRequest(db, syncCollection, requestDocId, claimEvent): { claimed, reason }`
- Uses Firestore `.create()` with deterministic id.
- Returns `already_claimed` without throwing on duplicate.

2. `shared/sync-events.cjs`
- `writeClaim(...)`
- `writeApiCall(...)`
- `writeFinal(...)`
- Normalizes event envelope: `eventType`, `requestId`, `requestEventId`, `creator`, `processor`, `payload`, `timestamp`.

3. `shared/request-validation.cjs`
- Domain-specific payload validation.
- Rejects binary payloads and oversized strings, then emits `*/rejected` final sync event.

## Recommended Runtime Settings
Based on observed failures:
- Photos had OOM + no available instance pressure.
- Shopify should remain tightly throttled to reduce API rate-limit risk.

| Function | Memory | Timeout | Concurrency | Max Instances | Rationale |
|---|---|---|---|---|---|
| `shopifySyncRequest` | `1GiB` | `300s` | `1` | `3` | Strong cap for Shopify API protection; mostly network I/O and sequential calls. |
| `photosTransferRequest` | `2GiB` | `300s` | `2` | `15` | Medium workload, less CPU-heavy than transform. |
| `photosTransformRequest` | `4GiB` | `300s` | `1` | `25` | Heavy image processing path, avoids per-instance memory contention. |

Follow-up tuning rules:
- If Shopify 429 appears, reduce `maxInstances` before changing memory.
- If Photos OOM appears, reduce `concurrency` first, then increase memory.
- If backlog grows with no OOM, increase `maxInstances` gradually.

## Firestore Rules Design
New principle:
- Clients create docs in `request_*`.
- Clients read `sync`.
- Clients can write only explicitly whitelisted response events to `sync` (for request/response handshakes).
- Admin SDK writes bypass rules as today.

### Required rule changes
1. Add create/read rules for each `request_*` collection:
- `create` allowed when authenticated and `request.resource.data.creator == request.auth.uid`.
- `read` allowed when authenticated and `resource.data.creator == request.auth.uid` (or broader if team wants shared visibility).
- `update/delete` denied to keep requests immutable.

2. Change `/sync/{action}`:
- `allow read: if request.auth != null`
- `allow create` only for whitelisted client-response events (for example `photos/image_transfer_secret_provided`) and `creator == request.auth.uid`
- `allow update, delete: if false`

3. Keep `/sync_secrets/{docId}` creator-based ownership as-is.

### Example rules snippet
```firestore
match /request_shopify_sync/{id} {
  allow create: if request.auth != null
    && request.resource.data.creator == request.auth.uid;
  allow read: if request.auth != null
    && resource.data.creator == request.auth.uid;
  allow update, delete: if false;
}

match /request_photos_transfer/{id} {
  allow create: if request.auth != null
    && request.resource.data.creator == request.auth.uid;
  allow read: if request.auth != null
    && resource.data.creator == request.auth.uid;
  allow update, delete: if false;
}

match /request_photos_transform/{id} {
  allow create: if request.auth != null
    && request.resource.data.creator == request.auth.uid;
  allow read: if request.auth != null
    && resource.data.creator == request.auth.uid;
  allow update, delete: if false;
}

match /sync/{action} {
  allow read: if request.auth != null;
  allow create: if request.auth != null
    && request.resource.data.creator == request.auth.uid
    && request.resource.data.eventType in [
      "photos/image_transfer_secret_provided"
    ];
  allow update, delete: if false;
}
```

## Function Deployment Design
Replace monolithic trigger with dedicated functions in `functions/index.js`:

- `exports.shopifySyncRequest = onDocumentCreated({ document: "request_shopify_sync/{requestId}", ... }, handler)`
- `exports.photosTransferRequest = onDocumentCreated({ document: "request_photos_transfer/{requestId}", ... }, handler)`
- `exports.photosTransformRequest = onDocumentCreated({ document: "request_photos_transform/{requestId}", ... }, handler)`

Each handler:
- Loads request doc.
- Validates payload.
- Claims via shared helper.
- Routes to domain worker.
- Writes canonical sync events directly to `/sync`.

Each function gets per-function runtime options (do not rely on one global `setGlobalOptions` for all).

## UI Design Changes
1. Request writes:
- Replace direct `/sync` request creation with writes to appropriate `request_*` collection.
- Keep client-response handshake events (for example secret handoff responses) written directly to `/sync`.

2. Progress tracking:
- Keep existing `/sync` subscription.
- Treat claim event as operation start.
- Keep existing final-state detection on `*/sync_completed`, `*/sync_partial_failed`, `*/sync_failed`.

3. Transient pending state:
- After request creation, show `queued` until claim event appears in `/sync`.
- If no claim event within timeout window, show `stuck` with retry affordance.

## Migration Plan
1. Deploy new functions and rules that allow both paths temporarily:
- Keep old `/sync` client create allowed during migration.
- New code writes to `request_*`.

2. Move UI writes to `request_*`.

3. Verify parity in staging:
- claim/final event coverage
- no duplicate processing
- no UI regressions in sync status route

4. Lock down `/sync` client writes in rules.

5. Remove old `syncRequest` dispatcher trigger.

## Risks and Mitigations
- Risk: Duplicate processing during migration if both old and new paths active.
  - Mitigation: deterministic claim ids in `/sync` across both pipelines.
- Risk: UI appears idle if claim events are delayed.
  - Mitigation: explicit `queued` state and timeout messaging.
- Risk: Rule rollout blocks clients.
  - Mitigation: two-phase rollout with temporary compatibility window.

## Success Criteria
- Photos and Shopify can be tuned independently.
- Shopify throughput remains bounded even when photo load spikes.
- `/sync` remains the single UI timeline source.
- No client writes to `/sync`.
- No increase in duplicate processing or orphaned requests.
