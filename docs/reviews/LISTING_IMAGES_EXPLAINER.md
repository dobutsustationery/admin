# Listing Images: Ordering & Variant ImagePosition

## Goal
Shopify treats variant images as separate from the gallery. In this app, variant images are **not** shown in the gallery, but each variant still has an `imagePosition` value. We want a deterministic ordering that:

1) Orders **variant images first**, in **SKU (item id) order**.
2) Places **gallery images after** the variant images, preserving the gallery order the user sets in the UI.

This makes `imagePosition` stable, deterministic, and independent of gallery visibility.

## Approach
We split ordering into two logical segments:

- **Segment A (Variants):** `associatedItems` sorted by `id` (SKU). Each item gets `imagePosition = index + 1`.
- **Segment B (Gallery):** The reordered gallery list gets positions starting at `variantCount + 1`.

This keeps the gallery order stable from the user’s perspective while ensuring variant positions are always predictable and not dependent on gallery membership.

## Implementation (code)
The ordering logic is applied in the listing detail page **for both create and live modes** when a gallery reorder happens:

`src/routes/listing-detail/+page.svelte`

```ts
const subtypeImageUrls = new Set(associatedItems.map(i => i?.image).filter(Boolean));
const galleryImages = listingImages.filter(img => !subtypeImageUrls.has(img.url));
const variantImages = listingImages.filter(img => subtypeImageUrls.has(img.url));

const currentGallery = galleryImages.slice();
// move sourceId -> targetId within gallery only

const variantOrder = associatedItems
  .filter(item => item?.id)
  .map(item => item.id as string)
  .sort((a, b) => a.localeCompare(b));
const galleryOffset = variantOrder.length;

const reorderedGallery = currentGallery.map((img, idx) => ({
  ...img,
  position: galleryOffset + idx + 1
}));

const variantImagesOrdered = variantOrder
  .map(id => {
    const item = associatedItems.find(i => i?.id === id);
    if (!item?.image) return null;
    const match = variantImages.find(img => img.url === item.image);
    return match ? { ...match } : null;
  })
  .filter(Boolean);

const updatedVariantImages = variantImagesOrdered.map((img, idx) => ({
  ...img,
  position: idx + 1
}));

const updatedImages = [...updatedVariantImages, ...reorderedGallery];

// Create mode: update proposal listing-only positions and order
// Live mode: broadcast update_listing({ images: updatedImages })

variantOrder.forEach((id, idx) => {
  const item = associatedItems.find(i => i?.id === id);
  if (!item) return;
  const position = idx + 1;
  dispatchBroadcast(update_field({ id, field: 'imagePosition', from: item.imagePosition || 0, to: position }));
});
```

## Notes
- **Gallery images stay visible-only.** Variant images remain hidden in the gallery UI, consistent with Shopify behavior.
- **`imagePosition` is now stable.** Variant positions no longer depend on gallery images or URL matches.
- **Listing-only images** still follow the gallery order and are offset by the variant count.

If we later want to reflect this ordering in exports or other views, we can treat `imagePosition` as the authoritative cross-variant ordering and gallery positions as `variantCount + index`.
