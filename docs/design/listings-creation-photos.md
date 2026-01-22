# Listings Creation – Photo Management Design

## 0) Goal and constraints
This design defines a complete photo workflow for listing creation using broadcast-only state. It covers batch edit and proposal (detail) screens. It supports:
- photo ordering
- associating photos to variants (inventory items)
- listing-only photos not tied to a JAN (or any inventory item)
- add/replace/remove operations

Constraints:
- All persistence is via broadcast actions only.
- Reuse existing data structures/actions wherever possible.
- Keep the proposal flow resumable from broadcast events.

## 1) Canonical data sources
We already have two image sources in the app:
- `photos.janCodeToPhotos[janCode]` → group of images uploaded to Drive and categorized to a JAN.
- `listings.handleToListing[handle].images` → listing-level images (ordering, alt text).

In creation mode we don’t have a live listing yet. We need a **draft listing image plan** that is broadcast and replays deterministically. This plan must:
- reference JAN-grouped photos
- optionally reference variant-specific images
- include listing-only images not tied to a JAN
- provide ordering and alt text

## 2) Draft data model (reusing existing structures)
### 2.1 Draft image references
Reuse `ListingImage` structure for all draft images:
```ts
interface ListingImage {
  id: string;
  url: string;
  position: number;
  altText: string;
}
```

The draft needs to distinguish **where** the image comes from. We keep `ListingImage` but add a lightweight mapping for source/association:
```ts
type DraftImageSource =
  | { type: 'jan'; janCode: string; photoId: string }   // categorized photo
  | { type: 'variant'; itemId: string; photoId: string } // inventory item image
  | { type: 'listing'; photoId: string };                // listing-only (uploaded for listing)

interface DraftImageAssociation {
  imageId: string;         // ListingImage.id
  source: DraftImageSource;
  variantItemId?: string;  // if associated to a variant
}
```

**Inventory field used for ordering in bulk view**

The bulk editor exposes `imagePosition` per variant row. This is persisted on the inventory item and must stay in sync with the draft image order used in the proposal view.
```ts
interface Item {
  // existing fields ...
  image?: string;
  imagePosition?: number; // ordering for variant image in bulk view
}
```

### 2.2 Draft image plan per proposal handle
Add to `ListingProposal`:
```ts
interface ListingProposal {
  // existing fields ...
  handle?: string;
  // image plan
  draftImages: ListingImage[];               // ordered list
  draftImageAssociations: DraftImageAssociation[]; // source + variant association
}
```

Notes:
- `draftImages` is the canonical ordered list used by UI.
- `draftImageAssociations` tells us if an image is tied to a JAN photo, a variant, or listing-only.
- We keep `draftImages` even if the image source is `jan` so order can be changed independently of `photos.janCodeToPhotos` ordering.

## 3) Draft image generation rules
When proposals are generated:
1. For each proposal (JAN), select initial photos from `photos.janCodeToPhotos[janCode]`.
2. Populate `draftImages` with those photos in a deterministic order (e.g., Drive modified time or original ordering).
3. Create matching `draftImageAssociations` with `{ type: 'jan', janCode, photoId }`.
4. If an inventory item has `image` set, include it as a `variant` source and associate it with that item ID (optional, only if available).

This keeps the proposal fully editable without losing provenance.

## 4) Actions (reusing and extending)
### 4.1 Reused actions
- `photos/complete_upload`: add a new Drive photo to state.
- `photos/categorize_photo`: attach a photo to a JAN (adds to `janCodeToPhotos`).
- `inventory/update_field` (existing) for variant image changes when needed.

### 4.2 New listing-creation actions
These actions are required for draft image planning:
- `listingCreation/add_draft_image({ janCode, image, association })`
  - Adds a `ListingImage` at end (or explicit position) and adds association.
- `listingCreation/remove_draft_image({ janCode, imageId })`
  - Removes from `draftImages` and association list.
- `listingCreation/reorder_draft_images({ janCode, orderedImageIds })`
  - Rewrites `draftImages.position` based on the given order.
- **Order sync rule:** whenever draft images are reordered in the proposal screen, update each associated inventory item's `imagePosition` to match its assigned image's new `position`. This keeps bulk-view ordering aligned.
- `listingCreation/update_draft_image({ janCode, imageId, changes })`
  - Updates `altText` or other image metadata.
- `listingCreation/associate_draft_image_variant({ janCode, imageId, itemId })`
  - Sets or clears `variantItemId` in association.

All actions must be broadcast so the draft image plan is fully reconstructible.

## 5) UI design
### 5.1 Batch editor (grid view)
Goal: map a specific variant row to a specific JAN photo with minimal UI.

**Layout**
- The “Image” column shows the current variant image thumbnail (one per row).
- Clicking the thumbnail opens a modal picker.

**Modal picker**
- Title: “Select image for this variant”.
- Shows all images in `photos.janCodeToPhotos[janCode]` as selectable thumbnails.
- Selecting a thumbnail updates the variant image for that row only.
- No reordering, removal, or listing-only image actions are available in batch view.

**Operations**
- Assign variant image: dispatch `inventory/update_field({ id, field: 'image', to: selectedUrl })`
  - This keeps the variant image association on the inventory item, and the draft image plan can still be refined in the proposal screen.

### 5.2 Proposal detail screen
Goal: deep editing and correctness.

**Gallery**
- Main image + thumbnail strip (ordered).
- Drag-and-drop to reorder.
  - On reorder, update both:
    1) `listingCreation/reorder_draft_images`
    2) `inventory/update_field` for each variant item whose assigned image moved (`field: 'imagePosition'`).

**Variant association**
- Each thumbnail has a “Variant” selector:
  - default: none (listing-only)
  - options: each inventory item in the proposal group
- Selecting a variant updates `associate_draft_image_variant`.
  - When an image is assigned to a variant, set that item's `imagePosition` to the image's current `position`.

**Add photo**
- “Add Listing Photo” button:
  - uploads to Drive
  - creates `ListingImage`
  - `add_draft_image` with `type: 'listing'`

**Use JAN photos**
- “Add From JAN Photos” button:
  - opens chooser with available `photos.janCodeToPhotos[janCode]`
  - picking adds existing photo into `draftImages` without duplicating in Photos

**Remove**
- Remove button removes from draft only. The underlying Drive photo is untouched.

## 6) Approval behavior
On approve:
1. Build final `listing.images` from `draftImages` in order.
2. Ensure each image has `position` reflecting its order.
3. Persist listing via `create_listing`.
4. Variant associations (if needed) remain in inventory item image fields.

## 6.1 Detail view ordering source of truth
- The proposal detail screen must always render images in `draftImages.position` order.
- When opening a proposal, the draft ordering supersedes any local UI ordering.
- Bulk view shows the inventory `imagePosition` which is kept in sync by the reorder rule above.

## 7) Edge cases
- If a JAN photo is removed from Photos, any draft image referencing it should remain but be marked “missing” (broken icon) until replaced.
- If a variant image is removed from inventory, the association remains but thumbnail shows missing.
- If proposal handle group changes, draft images merge by handle (union, de-dupe by `imageId`).

## 8) Summary
This design creates a deterministic, broadcast-only draft image plan with:
- explicit ordering
- explicit variant association
- listing-only image support
- batch + detail UI operations

It reuses existing image storage and adds a small set of draft actions in `listing-creation` to keep all changes event-sourced.
