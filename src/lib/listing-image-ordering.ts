export interface OrderingItem {
  id?: string;
  image?: string;
  imagePosition?: number;
}

export interface OrderingImage {
  id: string;
  url: string;
  position: number;
  altText: string;
}

export interface ListingOnlyImage {
  id: string;
  position?: number;
}

export interface ListingImageOrderingResult {
  updatedImages: OrderingImage[];
  reorderedGalleryIds: string[];
  updatedListingOnly: ListingOnlyImage[];
  variantPositions: Array<{ id: string; position: number }>;
}

export function reorderListingImages(params: {
  listingImages: OrderingImage[];
  associatedItems: OrderingItem[];
  sourceId: string;
  targetId: string;
  listingOnlyImages?: ListingOnlyImage[];
}): ListingImageOrderingResult | null {
  const {
    listingImages,
    associatedItems,
    sourceId,
    targetId,
    listingOnlyImages = [],
  } = params;

  // 1. Create a working copy of the full list
  // We assume listingImages is already sorted by position, but sorting here ensures consistency.
  const currentList = [...listingImages].sort((a, b) => a.position - b.position);

  const sourceIndex = currentList.findIndex((img) => img.id === sourceId);
  const targetIndex = currentList.findIndex((img) => img.id === targetId);

  if (sourceIndex === -1 || targetIndex === -1) return null;

  // 2. Perform the move
  const [moved] = currentList.splice(sourceIndex, 1);
  currentList.splice(targetIndex, 0, moved);

  // 3. Re-assign positions (1-based)
  const updatedImages = currentList.map((img, idx) => ({
    ...img,
    position: idx + 1,
  }));

  // 4. Update References
  
  // Update Variant Positions
  // We need to find where each variant's image ended up.
  // associatedItems links to images via URL (image property).
  // Some variants might share the same image URL.
  const variantPositions = associatedItems
    .map((item) => {
      if (!item.id || !item.image) return null;
      // Find the image in the new list
      const match = updatedImages.find((img) => img.url === item.image);
      if (match) {
        return { id: item.id, position: match.position };
      }
      return null;
    })
    .filter((p): p is { id: string; position: number } => p !== null);

  // Update Listing Only Images
  const updatedListingOnly = listingOnlyImages.map((img) => {
    const match = updatedImages.find((u) => u.id === img.id);
    if (match) {
      return { ...img, position: match.position };
    }
    return img;
  });

  return {
    updatedImages,
    reorderedGalleryIds: updatedImages.map((img) => img.id), // In new order
    updatedListingOnly,
    variantPositions,
  };
}
