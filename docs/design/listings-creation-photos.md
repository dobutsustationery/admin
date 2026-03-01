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
- `listings.handleToListing[handle].images` → listing-level images (ordering, alt text) for live listings.

In creation mode we don’t have a live listing yet. We compose the draft listing images from:

- JAN photos (`photos.janCodeToPhotos`)
- listing-only images stored on the proposal (see below)

## 2) Draft data model (reusing existing structures)

### 2.1 Listing-only images on proposals

Reuse `ListingImage` for listing-only draft images:

```ts
interface ListingImage {
  id: string;
  url: string;
  position: number;
  altText: string;
}
```

Listing-only images are stored directly on the proposal:

```ts
interface ListingProposal {
  // existing fields ...
  listingOnlyImages?: ListingImage[];
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

**Draft listing images (creation mode)**

- The proposal screen renders a merged list of images:
  1. JAN photos from `photos.janCodeToPhotos[janCode]`
  2. `listingOnlyImages` appended after JAN photos
- Ordering is enforced via `ListingImage.position` when building the merged list.

## 3) Draft image generation rules

When proposals are generated:

1. For each proposal (JAN), pull JAN photos from `photos.janCodeToPhotos[janCode]`.
2. Initialize `listingOnlyImages` as empty.
3. Variant images come from inventory (`inventory.idToItem[itemId].image`) and are managed in batch view.

## 4) Actions (reusing and extending)

### 4.1 Reused actions

- `photos/complete_upload`: add a new Drive photo to state.
- `photos/categorize_photo`: attach a photo to a JAN (adds to `janCodeToPhotos`).
- `inventory/update_field` (existing) for variant image changes when needed.

### 4.2 Listing-only image actions

- `listingCreation/add_listing_only_image({ janCode, image })`
  - Appends a `ListingImage` to `listingOnlyImages`.
- `listingCreation/remove_listing_only_image({ janCode, imageId })`
  - Removes a listing-only image from the proposal.

### 4.3 Order sync rule

- When images are reordered in detail view, update `ListingImage.position` for listing-only images.
- If a reordered image is also assigned to a variant, update that inventory item’s `imagePosition` to match the new position.

## 5) UI design

### 5.1 Batch editor (grid view)

Goal: map a specific variant row to a specific JAN photo with minimal UI.

**Layout**

- The “Image” column shows the current variant image thumbnail (one per row).
- Clicking the thumbnail opens a modal picker.

**Modal picker**

- Title: “Select image for this variant”.
- Shows all images in `photos.janCodeToPhotos[janCode]` as selectable thumbnails.
- Also includes images associated with any variant that shares the same listing handle (sibling variants).
- Selecting a thumbnail updates the variant image for that row only.
- No reordering, removal, or listing-only image actions are available in batch view.

**Operations**

- Assign variant image: dispatch `inventory/update_field({ id, field: 'image', to: selectedUrl })`
  - This keeps the variant image association on the inventory item, and the draft image plan can still be refined in the proposal screen.

### 5.2 Proposal detail screen

Goal: deep editing and correctness.

**Gallery**

- Main image + thumbnail strip (ordered by `position`).
- Drag-and-drop to reorder.
  - On reorder, update listing-only `position` values.
  - If the moved image is assigned to a variant, update that item’s `imagePosition`.

**Variant association**

- Variant image selection is handled in batch view only.
- Detail view shows the current variant image but does not change it.

**Add listing photo**

- “Add Listing Photo” button:
  - opens the same modal picker used in batch view
  - selecting a thumbnail appends it to `draftImages` (listing-only)
  - no upload occurs here; new photos must be added in Photos by associating them to the JAN

**Picker source**

- The picker is the single entry point for adding listing photos in detail view.
- It includes:
  - `photos.janCodeToPhotos[janCode]`
  - sibling-variant images for the same handle

**Remove**

- Remove button in detail view:
  - Listing-only image → `listingCreation/remove_listing_only_image`
  - JAN photo → `photos/uncategorize_photo`
  - The underlying Drive photo is untouched.

## 6) Approval behavior

On approve:

1. Build final `listing.images` from JAN photos + `listingOnlyImages`.
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
- If proposal handle group changes, listing-only images are merged by handle (union, allow duplicates if user explicitly added).

## 8) Summary

This design creates a deterministic, broadcast-only draft image plan with:

- explicit ordering
- explicit variant association
- listing-only image support
- batch + detail UI operations

It reuses existing image storage and adds a small set of draft actions in `listing-creation` to keep all changes event-sourced.

## 9) Implementation status — **Complete**

- Implemented:
  - Batch picker for variant images (`inventory.update_field` on `image`)
  - Detail picker for listing-only images (`listingCreation.add_listing_only_image`)
  - Listing-only images are rendered even if they duplicate a variant image URL
  - Drag-and-drop reorder in detail view with `imagePosition` sync
