import type { ListingProposal, ListingVariant } from "./listing-creation-slice";
import type { PhotosState } from "./photos-slice";
import type { InventoryState } from "./inventory";
import type { ListingImage } from "./listings-slice";

export function buildDraftListingImages(
    proposal: ListingProposal,
    photosState: PhotosState,
    inventoryState?: InventoryState // Optional if needed for fallback
): ListingImage[] {
    
    // 1. Identify Photo Sources
    const groupIds = new Set<string>(proposal.photoGroupIds || []);
    
    if (proposal.variants) {
        proposal.variants.forEach((v: ListingVariant) => {
            if (v.photoGroupKey) {
                groupIds.add(v.photoGroupKey);
            }
            // CODEX Analysis doesn't explicitly demand fallback, but Draft View logic 
            // relies on photoGroupKey + photoGroupIds.
            // If we want to support implicit photos from imported items (which lack photoGroupKey),
            // we would need to add item.janCode here.
            // But CODEX says: "Draft composition: source groups from photoGroupIds + variant.photoGroupKey".
            // So we stick to that for now to match Draft View exactly.
        });
    }

    // 2. Aggregate Photos
    const allPhotos: any[] = [];
    const seenPhotoIds = new Set<string>();
    const excludedIds = new Set<string>(proposal.excludedPhotoIds || []);
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

    // 3. Convert to ListingImage format
    const photoImages = allPhotos.map((f: any, i: number) => ({
        url: f.baseUrl || f.productUrl || f.url, 
        id: f.id || `img-${i}`,
        altText: f.filename || f.name,
        position: i + 1
    }));

    // 4. Add Listing-Only Images
    const listingOnly = (proposal.listingOnlyImages || []).map((img: any) => ({ 
        ...img,
        isListingOnly: true,
        sourceJan: proposal.janCode 
    }));

    let mergedImages = [...photoImages, ...listingOnly];

    // 5. Apply Order
    const order = proposal.listingImageOrder || [];
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
        // If we want strict, we would drop them. But CODEX suggests matching behavior.
        // "either always strict, or always append leftovers — but identical in draft and approve."
        // Draft view appends. So we append.
        mergedImages = [...ordered, ...Array.from(byId.values())];
    }

    // 6. Final Re-index
    return mergedImages.map((img, i) => ({ ...img, position: i + 1 }));
}
