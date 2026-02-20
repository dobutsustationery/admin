import type { ListingProposal, ListingVariant } from "./listing-creation-slice";
import type { PhotosState } from "./photos-slice";
import type { InventoryState } from "./inventory";
import type { ListingImage } from "./listings-slice";

export function canonicalizeListingImages(images: ListingImage[]): ListingImage[] {
    const keyed = new Map<string, { img: ListingImage; idx: number }>();
    const unkeyed: Array<{ img: ListingImage; idx: number }> = [];

    images.forEach((img, idx) => {
        const key = (img.url || "").trim();
        if (!key) {
            unkeyed.push({ img, idx });
            return;
        }
        const existing = keyed.get(key);
        if (!existing) {
            keyed.set(key, { img, idx });
            return;
        }

        const currentIsListingOnly = !!img.isListingOnly;
        const existingIsListingOnly = !!existing.img.isListingOnly;

        // Prefer listing-only instances when URL duplicates exist; this mirrors user intent
        // when they curated/reordered listing-only images in draft.
        if (currentIsListingOnly && !existingIsListingOnly) {
            keyed.set(key, { img, idx });
        }
    });

    const deduped = [
        ...Array.from(keyed.values()),
        ...unkeyed,
    ]
        .sort((a, b) => a.idx - b.idx)
        .map((entry) => entry.img);

    return deduped.map((img, i) => ({ ...img, position: i + 1 }));
}

export function buildDraftListingImages(
    proposals: ListingProposal[],
    photosState: PhotosState,
    inventoryState?: InventoryState 
): ListingImage[] {
    if (proposals.length === 0) return [];
    
    // Primary is the one driving the order/view (usually first or active)
    const primary = proposals[0];
    
    // 1. Identify Photo Sources
    const groupIds = new Set<string>();
    const excludedIds = new Set<string>();
    
    proposals.forEach(p => {
        if (p.photoGroupIds) {
            p.photoGroupIds.forEach(gid => groupIds.add(gid));
        }
        if (p.variants) {
            p.variants.forEach((v: ListingVariant) => {
                if (v.photoGroupKey) {
                    groupIds.add(v.photoGroupKey);
                }
            });
        }
        if (p.excludedPhotoIds) {
            p.excludedPhotoIds.forEach(id => excludedIds.add(id));
        }
    });

    // 2. Aggregate Photos
    const allPhotos: any[] = [];
    const seenPhotoIds = new Set<string>();
    const janToPhotos = photosState.janCodeToPhotos || {};

    groupIds.forEach(gid => {
        const pPhotos = janToPhotos[gid] || [];
        pPhotos.forEach((ph: any) => {
            if (!seenPhotoIds.has(ph.id) && !excludedIds.has(ph.id)) {
                seenPhotoIds.add(ph.id);
                allPhotos.push({ ...ph, sourceGroup: gid }); 
            }
        });
    });

    // 3. Convert to ListingImage format (Preserve metadata)
    const photoImages = allPhotos.map((f: any, i: number) => ({
        url: f.baseUrl || f.productUrl || f.url, 
        id: f.id || `img-${i}`,
        altText: f.filename || f.name,
        position: i + 1,
        sourceGroup: f.sourceGroup // Preserve for replacement logic
    }));

    // 4. Add Listing-Only Images (Aggregate from all)
    const listingOnly = proposals.flatMap(p => 
        (p.listingOnlyImages || []).map((img: any) => ({ 
            ...img,
            isListingOnly: true,
            sourceJan: p.janCode 
        }))
    );

    let mergedImages = [...photoImages, ...listingOnly];

    // 5. Apply Order (Use Primary's order)
    const order = primary.listingImageOrder || [];
    if (order.length > 0) {
        const byId = new Map(mergedImages.map(img => [img.id, img]));
        const ordered: any[] = [];
        
        order.forEach((id: string) => {
            const match = byId.get(id);
            if (match) {
                ordered.push(match);
                byId.delete(id);
            }
        });
        
        // Append Remainders (Match Draft View behavior)
        mergedImages = [...ordered, ...Array.from(byId.values())];
    }

    // 6. Final canonicalization (dedupe by URL + reindex)
    return canonicalizeListingImages(mergedImages as ListingImage[]);
}
