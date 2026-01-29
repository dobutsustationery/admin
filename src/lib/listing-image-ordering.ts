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

  const subtypeImageUrls = new Set(
    associatedItems.map((i) => i?.image).filter(Boolean) as string[],
  );

  const galleryImages = listingImages.filter(
    (img) => !subtypeImageUrls.has(img.url),
  );
  const variantImages = listingImages.filter((img) =>
    subtypeImageUrls.has(img.url),
  );

  const sourceIndex = galleryImages.findIndex((img) => img.id === sourceId);
  const targetIndex = galleryImages.findIndex((img) => img.id === targetId);
  if (sourceIndex === -1 || targetIndex === -1) return null;

  const currentGallery = galleryImages.slice();
  const [moved] = currentGallery.splice(sourceIndex, 1);
  currentGallery.splice(targetIndex, 0, moved);

  const variantOrder = associatedItems
    .filter((item) => item?.id)
    .map((item) => item.id as string)
    .sort((a, b) => a.localeCompare(b));
  const galleryOffset = variantOrder.length;

  const reorderedGallery = currentGallery.map((img, idx) => ({
    ...img,
    altText: img.altText || "",
    position: galleryOffset + idx + 1,
  }));

  const variantImagesOrdered = variantOrder
    .map((id) => {
      const item = associatedItems.find((i) => i?.id === id);
      if (!item?.image) return null;
      const match = variantImages.find((img) => img.url === item.image);
      return match ? { ...match } : null;
    })
    .filter(Boolean) as OrderingImage[];

  const updatedVariantImages = variantImagesOrdered.map((img, idx) => ({
    ...img,
    altText: img.altText || "",
    position: idx + 1,
  }));

  const updatedImages = [...updatedVariantImages, ...reorderedGallery];

  const updatedListingOnly = listingOnlyImages.map((img) => {
    const newIndex = reorderedGallery.findIndex((r) => r.id === img.id);
    if (newIndex !== -1) {
      return { ...img, position: galleryOffset + newIndex + 1 };
    }
    return img;
  });

  const variantPositions = variantOrder.map((id, idx) => ({
    id,
    position: idx + 1,
  }));

  return {
    updatedImages,
    reorderedGalleryIds: reorderedGallery.map((img) => img.id),
    updatedListingOnly,
    variantPositions,
  };
}
