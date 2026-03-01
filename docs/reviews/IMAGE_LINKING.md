# Image Linking Design

## Problem

Today, most image references are URL-based (`ListingImage.url`, `item.image`, etc.).  
Image history exists (`photos.urlHistory[photoId]`), but references outside the photos slice do not point to that history; they point to a specific URL snapshot.

Result: replacing/editing an image updates history, but existing consumers (listings, inventory, exports) can keep showing the old URL.

## Goal

Make every image reference point to a stable image identity, not a concrete URL, so all consumers resolve to the latest version automatically.

## Non-goals

- Rewriting all historical events immediately.
- Supporting per-consumer pinned versions in v1 (we can add later).

## Core Scheme

### 1) Canonical image identity

Introduce a stable `imageId` as the only durable reference key.

- For Google Photos-backed images: `imageId = mediaItem.id` (already stable).
- For listing-only uploads: generate UUID once and keep it forever.

### 2) Versioned history per image

Store versions separately from references:

```ts
type ImageId = string;
type ImageVersionId = string;

interface ImageVersion {
  versionId: ImageVersionId; // unique
  imageId: ImageId;
  url: string; // concrete URL for this version
  createdAt: number;
  source: "photos-picker" | "drive-upload" | "manual-edit" | "import";
}

interface ImageAsset {
  imageId: ImageId;
  currentVersionId: ImageVersionId;
  versionIds: ImageVersionId[]; // newest first
}
```

All replace/edit operations append a new `ImageVersion` and atomically move `currentVersionId`.

### 3) References store `imageId`, never URL

Replace URL references with `ImageRef`:

```ts
interface ImageRef {
  imageId: string;
}
```

Examples:

- `ListingImage` stores `imageRef` (+ alt/position metadata), not `url`.
- Inventory variant image field stores `imageRef` (or `imageId`) instead of URL.
- Any cross-entity linkage uses `imageId`.

### 4) Resolve URL at read time

Add a selector/service:

`resolveImageUrl(imageId) -> currentVersion.url`

UI and export code resolve through this function. No component reads raw URL fields from listings/inventory.

## Data Model Changes

### New slice/state

Add a normalized image registry (can live in `photos` first, later split to `images` slice):

- `assetsById: Record<imageId, ImageAsset>`
- `versionsById: Record<versionId, ImageVersion>`

### Existing structures

- `photos.selected[].baseUrl` becomes derived/display-only.
- `photos.urlHistory` becomes compatibility-only, then removed.
- `listings[].images[].url` replaced by `listings[].images[].imageRef`.

## Write Path Rules

1. **Ingest/import image**
   - Ensure `ImageAsset(imageId)` exists.
   - Append initial version.
   - Set `currentVersionId`.

2. **Replace/edit image**
   - Append new version under same `imageId`.
   - Move `currentVersionId`.
   - Do not mutate downstream references.

3. **Reference image from listing/inventory**
   - Persist only `imageId` in reference fields.
   - Never persist resolved URL as source of truth.

## Read Path Rules

1. For any displayed image: resolve `imageId -> current URL`.
2. For history screen: read `versionIds` timeline for that `imageId`.
3. For export (Shopify/CSV): resolve just before export to get latest URL.

## Event-Sourcing / Broadcast Actions

Introduce explicit actions:

- `images/upsert_asset({ imageId })`
- `images/add_version({ imageId, versionId, url, source, createdAt })`
- `images/set_current_version({ imageId, versionId })` (or merged into `add_version`)
- `listings/add_image_ref({ handle, imageRef, ... })`
- `inventory/update_image_ref({ itemId, imageRef })`

This keeps replay deterministic and makes history auditable.

## Migration Plan

### Phase 1: Dual read/write (safe rollout)

- New writes: store `imageId` + version data and continue writing URL fields for compatibility.
- Reads: if `imageRef` exists, resolve from registry; else fallback to legacy URL.

### Phase 2: Backfill

- Script over state/snapshots:
  - For each legacy URL field, create synthetic asset:
    - `imageId = "legacy:" + stableHash(url)` if no known photo id.
    - one initial version using existing URL.
  - Replace URL refs with `imageRef`.

### Phase 3: Remove legacy URL source-of-truth fields

- Delete fallback reads.
- Keep optional denormalized URL cache only for performance, never authority.

## Invariants

- Every referenceable image has exactly one `imageId`.
- `currentVersionId` must exist in `versionsById`.
- All consumers render/export via resolver.
- Replacing an image must update all references without touching those references directly.

## Test Plan

1. Replacing image in `photo-history` updates listing-detail render without editing listing records.
2. Replacing image updates inventory-linked previews similarly.
3. Export after replacement uses newest URL.
4. Replay from broadcast reconstructs same current versions and history order.
5. Legacy-only data still renders during Phase 1 fallback.

## Why this fixes the issue

The current bug exists because references bind to URLs.  
This scheme makes references bind to `imageId`, and URL becomes a resolved property of the image’s latest version.  
Therefore, all existing references automatically follow the newest version in the image history.
