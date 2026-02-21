import { describe, it, expect } from 'vitest';
import { computeShopifyImportBatch, parseShopifyChunk } from '../../src/lib/shopify-import-slice';

// Extract of conflict logic from +page.svelte
function detectConflicts(
    existingItem: any, 
    newItem: any, 
    options: { useShopifyImages: boolean, shopifyToDriveMap: Record<string, string> }
) {
    const conflicts: string[] = [];
    const { useShopifyImages, shopifyToDriveMap } = options;

    if (!useShopifyImages) {
        const existImage = existingItem.image;
        const newImage = newItem.image;
        
        // Conflict if both exist and are different
        if (existImage && newImage && existImage !== newImage) {
            // Check if newImage (Shopify) maps to existImage (Drive)
            const mappedDriveUrl = shopifyToDriveMap[newImage];
            if (mappedDriveUrl !== existImage) {
                conflicts.push("Image");
            }
        }
    }
    return conflicts;
}

describe('Shopify Import Logic', () => {
    const existingImage = "https://cdn.getshifter.co/d299a556d96edb77676c949380ed2e36fe885e0a/uploads/2021/07/4542804081374.jpg";
    const shopifyImage = "https://cdn.shopify.com/s/files/1/0582/2559/0461/products/4542804081374.jpg?v=1626759000";
    
    const JAN = "4542804081374";

    const existingItem = {
        janCode: JAN,
        image: existingImage,
        description: "Old Description",
        qty: 10,
        handle: "old-handle"
    };

    const newItem = {
        janCode: JAN,
        image: shopifyImage,
        description: "New Description",
        qty: 5,
        handle: "new-handle"
    };

    it('should detect image conflict when images differ and no mapping exists', () => {
        const conflicts = detectConflicts(existingItem, newItem, {
            useShopifyImages: false,
            shopifyToDriveMap: {}
        });

        expect(conflicts).toContain("Image");
    });

    it('should NOT detect conflict if images are identical strings', () => {
        const conflicts = detectConflicts(
            { ...existingItem, image: shopifyImage },
            newItem,
            { useShopifyImages: false, shopifyToDriveMap: {} }
        );
        expect(conflicts).not.toContain("Image");
    });

    it('should NOT detect conflict if mapping handles it', () => {
        const conflicts = detectConflicts(existingItem, newItem, {
            useShopifyImages: false,
            shopifyToDriveMap: {
                [shopifyImage]: existingImage
            }
        });
        expect(conflicts).not.toContain("Image");
    });

    it('should NOT detect conflict if existing image is missing', () => {
        const conflicts = detectConflicts(
            { ...existingItem, image: undefined },
            newItem,
            { useShopifyImages: false, shopifyToDriveMap: {} }
        );
        expect(conflicts).not.toContain("Image");
    });

    // In MATCH mode, differing images are treated as a conflict when useShopifyImages is false.
    it('should skip MATCH update when image differs and useShopifyImages is false', () => {
        const state = {
            rows: [{
                processed: false,
                parsed: newItem
            }],
            resolutions: {},
            activeFile: null,
            step: "review",
            headerRow: null,
            lastSeenProduct: null
        } as any;

        const inventoryIdToItem = {
            [JAN]: existingItem
        };
        const handleToListing = {};

        const result = computeShopifyImportBatch(
            state,
            inventoryIdToItem,
            handleToListing,
            "MATCH",
            { useShopifyImages: false }
        );

        expect(result.updates.length).toBe(0);
    });
});

describe('Shopify Parsing Logic', () => {
    const headerStr = "Handle,Title,Body (HTML),Vendor,Standard Product Type,Custom Product Type,Tags,Published,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Option3 Name,Option3 Value,Variant SKU,Variant Grams,Variant Inventory Tracker,Variant Inventory Qty,Variant Inventory Policy,Variant Fulfillment Service,Variant Price,Variant Compare At Price,Variant Requires Shipping,Variant Taxable,Image Src,Image Position,Image Alt Text,Gift Card,SEO Title,SEO Description,Google Shopping / Google Product Category,Google Shopping / Gender,Google Shopping / Age Group,Google Shopping / MPN,Google Shopping / AdWords Grouping,Google Shopping / AdWords Labels,Google Shopping / Condition,Google Shopping / Custom Product,Google Shopping / Custom Label 0,Google Shopping / Custom Label 1,Google Shopping / Custom Label 2,Google Shopping / Custom Label 3,Google Shopping / Custom Label 4,Variant Image,Variant Weight Unit,Variant Tax Code,Cost per item,Price / International,Compare At Price / International,Status";
    const headers = headerStr.split(",");

    function createRow(data: Record<string, string>) {
        return headers.map(h => data[h] || "").join(",");
    }
    
    it('should parse variant image if present', () => {
        const rowData: Record<string, string> = {
            "Handle": "handle",
            "Variant SKU": "4542804081374",
            "Image Src": "https://shopify.com/main.jpg",
            "Variant Image": "https://shopify.com/variant.jpg"
        };
        const row = createRow(rowData);
        
        const { items } = parseShopifyChunk(headerStr, [row], null);
        const item = items[0].item;
        
        expect(item).not.toBeNull();
        expect(item?.janCode).toBe("4542804081374");
        expect(item?.image).toBe("https://shopify.com/variant.jpg");
    });

    it('should fallback to Image Src if Variant Image is empty', () => {
        const rowData: Record<string, string> = {
            "Handle": "handle",
            "Variant SKU": "4542804081374",
            "Image Src": "https://shopify.com/main.jpg",
            "Variant Image": " " // Space to simulate empty but present column? Or empty string.
                                 // CSV usually has empty string between commas.
                                 // If I want to verify whitespace trimming:
        };
        const row = createRow(rowData); // Variant Image will be "" by default
        
        // Let's explicitly test " " if needed, but default "" is good test too.
        
        const { items } = parseShopifyChunk(headerStr, [row], null);
        const item = items[0].item;
        
        expect(item).not.toBeNull();
        expect(item?.janCode).toBe("4542804081374");
        // EXPECTATION: It should use main.jpg because variant.jpg is missing
        expect(item?.image).toBe("https://shopify.com/main.jpg");
    });

    it('should handle whitespace in Variant Image', () => {
         const rowData: Record<string, string> = {
            "Handle": "handle",
            "Variant SKU": "4542804081374",
            "Image Src": "https://shopify.com/main.jpg",
            "Variant Image": "   " // Whitespace
        };
        const row = createRow(rowData);
        
        const { items } = parseShopifyChunk(headerStr, [row], null);
        const item = items[0].item;
        
        expect(item?.image).toBe("https://shopify.com/main.jpg");
    });
});
