# Image Handling Design

## Purpose

This document defines how image data is fetched, rendered, stored, and promoted across the application.

Goals:
- reduce bandwidth and memory pressure
- eliminate image-related UI flake and browser OOM behavior
- keep Redux/broadcast state durable and small
- support reliable Google Photos -> Google Drive promotion

## Scope

In scope:
- dynamic user/content images rendered in the app
- Google Photos and Google Drive image URLs
- client image rendering policy (`SecureImage`)
- persistence rules for image references
- background transfer architecture for cloud-to-cloud promotion

Out of scope:
- static app assets (icons, logos, bundled illustrations)
- image editing UX details (crop UI, filters UI)
- CDN strategy for non-Google image hosts

## Architectural Rules

### 1. Single Rendering Path for Dynamic Images

All dynamic content images must render through `SecureImage` (directly or via wrappers such as `ImageThumbnail`).

Allowed exception:
- static bundled assets used by the app shell may use normal `<img>`

This keeps auth handling, retry behavior, URL normalization, and sizing policy centralized.

### 2. Persistent State Stores References Only

Persistent stores must contain only image references, never image bytes.

Disallowed in Redux state, broadcast actions, Firestore sync/broadcast docs:
- `Blob`
- `File`
- `ArrayBuffer`
- Base64 image payloads
- `data:` URIs
- transient object URLs (`blob:`)

Allowed:
- stable URLs (prefer durable Drive URLs)
- source IDs (Google Photos media item id, Drive file id)
- metadata (dimensions, mime type, filename)

Ephemeral component-local state may temporarily hold a `Blob` during editing, but it must be uploaded before persistence.

### 3. Durable URLs Only in Business State

Expiring or session-bound URLs must not be persisted as canonical image references.

Examples of URLs that are often transient and should not be treated as durable:
- some Google Photos / `googleusercontent.com` picker URLs
- signed thumbnail URLs
- session-specific redirects

Canonical stored references should be:
- durable Google Drive URLs (or Drive file IDs that can be resolved deterministically)
- stable non-Google external URLs when ownership/longevity is acceptable

### 4. Client Is Not the Long-Term Transfer Engine

Client-side Photos -> Drive transfer is acceptable only as a temporary compatibility path.

Target state:
- cloud-to-cloud transfer handled by backend workers
- client submits intent and tracks status
- client updates business state only after completion event

## Rendering Policy (`SecureImage`)

`SecureImage` is the policy enforcement point for dynamic images.

### Responsibilities

- normalize source URL shape
- choose an appropriate display size
- fetch with auth where required
- apply retry logic for flaky sources
- avoid persisting transient fetch artifacts (`blob:` URLs are view-only)
- expose consistent loading/error states

### URL Normalization

For Google-hosted images, `SecureImage` should normalize sizing parameters instead of trusting whatever size is currently embedded in state.

Policy:
- strip existing size suffixes where safe
- apply context-driven size suffixes
- preserve original ID/path

This prevents state from hardcoding `=s0` everywhere.

### Size Presets

`SecureImage` should support a small set of semantic sizes:
- `thumbnail`: grids, tables, chips, queues
- `preview`: detail panes, standard modals
- `full`: explicit zoom/fullscreen/high-detail views

Implementation detail:
- actual suffixes (`=s200`, `=s800`, `=s0`, etc.) are configuration, not business logic
- callers specify intent (`thumbnail`/`preview`/`full`), not transport parameters

### Progressive Loading for High-Detail Views

When `full` is requested:
1. render `thumbnail` or `preview` first
2. request `full` in background
3. swap only after decode completes

Requirements:
- no visible broken-image flash
- no layout shift during swap
- keep previous image visible until replacement is paint-ready

## Persistence and Validation Rules

### Broadcast / Sync Event Constraints

Image bytes in events are prohibited because they:
- bloat Firestore documents
- slow replay and synchronization
- break event-log durability expectations

Enforcement should exist in code, not only in convention.

Recommended safeguards:
- action validators in reducers/middleware rejecting `data:` and `blob:` URLs
- schema validation on backend write paths for sync events
- tests covering rejection of invalid payloads

### Editable Client Flows (Crop / Manual Edits)

For local edits that produce a `Blob`:
1. keep blob in component-local state only
2. upload to durable storage
3. receive durable reference (URL or ID)
4. dispatch broadcast action with durable reference only

If upload fails:
- keep unsaved local preview ephemeral
- do not emit a persistent action

## Photos -> Drive Promotion Architecture

### Summary

Promotion should be event-driven via the existing background sync queue pattern, not a synchronous client-mediated blob transfer.

The client records intent; backend performs transfer; client consumes completion/failure events.

### Why

This avoids:
- client bandwidth waste (download then re-upload)
- browser memory spikes on large images
- fragile long-running requests in the UI
- duplicate transfers after reload

### Event-Driven Flow

0. Sync collection unification (platform prerequisite)
- migrate from `shopify_sync` to a general-purpose `sync` collection
- use namespaced event types (for example `shopify/...`, `photos/...`)
- keep a single Cloud Function trigger on `sync/{docId}`
- route to domain-specific handlers based on the event type prefix

1. Client writes transfer intent to `sync`
- event type: `photos/image_transfer_requested`
- payload includes source reference, target context, and `requestId`

2. Client tracks in-flight status from `sync`
- status survives reloads
- duplicate requests can be deduplicated by `requestId` or source+target key

3. Backend worker handles transfer
- triggered from `sync/{docId}`
- routes by namespaced `eventType`
- streams source bytes to Drive without involving browser memory

4. Backend emits status events
- `photos/image_transfer_started` (optional)
- `photos/image_transfer_completed`
- `photos/image_transfer_failed`

5. Client resolves state
- on completion, dispatch canonical broadcast action with durable Drive reference
- clear local loading state
- on failure, show retryable UI

### Event Payload Requirements

Request event should include:
- `requestId`
- `sourceType` (`google_photos`, `url`, etc.)
- `sourceRef` (media item ID and/or URL)
- target entity reference (listing/photo queue item/etc.)
- requesting user identity
- idempotency key
- created timestamp

Completion event should include:
- `requestId`
- resulting durable reference (Drive file ID and canonical URL)
- optional metadata (width, height, mime type)
- completed timestamp

Failure event should include:
- `requestId`
- error code (machine-readable)
- error message (user-safe)
- retryable flag
- failed timestamp

### Sync Collection Unification (`shopify_sync` -> `sync`)

The application should converge on one sync/event-work queue collection for backend jobs.

Target collection:
- `sync`

Migration intent:
- replace `shopify_sync` with `sync`
- preserve Shopify workflows by renaming their event types to namespaced forms
- add Photos transfer events into the same queue model

Event type naming convention:
- `shopify/<event>`
- `photos/<event>`
- future domains follow the same pattern (`<domain>/<event>`)

Cloud Function design:
- one trigger on `sync/{docId}`
- lightweight dispatcher parses `eventType`
- domain handlers live in separate modules (Shopify, Photos, etc.)
- shared concerns (logging, retries, idempotency, status writes) stay in common sync infrastructure

Benefits:
- one operational queue to monitor
- consistent retry/idempotency semantics across domains
- simpler client-side subscription model for in-flight status
- cleaner backend implementation than parallel ad hoc triggers per feature

Migration requirements:
- dual-read or migration path for any UI/state currently reading `shopify_sync`
- compatibility mapping for legacy Shopify event names during transition
- backfill/archival decision for historical `shopify_sync` documents documented before cutover

## Backend Prerequisites and Constraints

Cloud-to-cloud transfer is the target design, but implementation depends on auth and source URL semantics.

Requirements before rollout:
- backend can authenticate to Google Photos source on behalf of user (or receives a valid scoped token safely)
- backend can upload to target Drive location with correct permissions
- token handling avoids storing long-lived sensitive tokens in broadcast/sync logs

Important constraint:
- not every Google-hosted URL is fetchable server-side without the right token and scopes
- URL shape alone is not sufficient; source identity and auth context matter

Recommended approach:
- prefer transferring by source media item ID when available
- resolve/fetch in backend with explicit OAuth credentials
- treat direct URL fallback as compatibility behavior, not the canonical path

## Rollout Plan

### Phase 1: Policy Enforcement (Client)

- route dynamic image rendering through `SecureImage`
- add semantic size presets
- stop persisting transient/expiring image URLs as canonical references
- add tests for state/action payload validation

### Phase 2: Rendering Efficiency

- normalize Google sizing params in `SecureImage`
- enable progressive loading for `full` views
- measure image payload reduction in common screens

### Phase 3: Sync-Queue Transfers (Backend)

- unify backend queue on `sync` (migrate/compat-wrap `shopify_sync`)
- implement namespaced event dispatcher in Cloud Function trigger
- implement `photos/image_transfer_requested` worker
- emit started/completed/failed events
- update client flow to consume status events and finalize broadcast updates

### Phase 4: Remove Client Blob Promotion Path

- gate old client-mediated transfer behind fallback flag
- monitor failures and retry rates
- remove fallback after backend path is proven reliable

## Acceptance Criteria

The design is considered implemented when all of the following are true:

- dynamic images render via `SecureImage` (or a wrapper that uses it)
- no broadcast/sync event persists image bytes or `data:`/`blob:` URLs
- thumbnail/list views do not request original-size (`=s0`) images by default
- full-detail views progressively upgrade image quality without broken-image flash
- Photos -> Drive promotion survives page reload and resumes from sync status
- business state stores durable image references only

## Testing Strategy

### Unit Tests

- URL normalization for Google size suffixes
- payload validators reject image bytes / `data:` / `blob:`
- reducers preserve durable references and reject transient ones

### Integration / E2E Tests

- thumbnails render successfully after image promotion
- no upload-failure overlays in stable mocked flows
- screenshot captures wait for image decode/render-ready state
- transfer completion updates canonical state with durable URL/ID

### Operational Monitoring

- transfer success/failure rates by event type
- median transfer duration
- retry rate and duplicate request rate
- client memory usage regressions on image-heavy flows
