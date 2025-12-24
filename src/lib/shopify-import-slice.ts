import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import Papa from "papaparse";

export interface ShopifyImportItem {
  janCode: string;
  description: string;
  qty: number; // Variant Inventory Qty
  price?: number; // Variant Price
  weight?: number; // Variant Grams
  image?: string; // Inventory Item Image (Variant Image)
  listingImage?: string; // Gallery Image (Image Src) - to be added to listing
  handle?: string; // For grouping/reference
  processed?: boolean;
  
  // New Fields
  bodyHtml?: string;
  productCategory?: string;
  imagePosition?: number;
  imageAltText?: string;
}

export interface RawRow {
    raw: string;
    parsed: ShopifyImportItem | null;
    error?: string;
    processed?: boolean;
}

export interface ResolutionAction {
  type: string;
  payload: any;
}


export interface LastSeenProduct { 
    handle: string; 
    description: string;
    price?: number;
    weight?: number;
    image?: string;
    bodyHtml?: string;
    productCategory?: string;
    imagePosition?: number;
    imageAltText?: string;
}

export interface ShopifyImportState {
  activeFile: { id: string; name: string } | null;
  step: "idle" | "importing" | "review"; 
  headerRow: string | null;
  rows: RawRow[];
  resolutions: Record<number, ResolutionAction[]>;
  lastSeenProduct: LastSeenProduct | null;
}

const initialState: ShopifyImportState = {
  activeFile: null,
  step: "idle",
  headerRow: null,
  rows: [],
  resolutions: {},
  lastSeenProduct: null,
};

export const parseShopifyChunk = (
    headerRow: string, 
    rawRows: string[], 
    initialContext: LastSeenProduct | null
) => {
     const csvChunk = [headerRow, ...rawRows].join("\n");
     
     const result = Papa.parse(csvChunk, {
          header: true,
          skipEmptyLines: true,
          transformHeader: (h) => h.trim().toLowerCase(), 
     });
     
     const items: { item: ShopifyImportItem | null, error?: string }[] = [];
     let context = initialContext ? { ...initialContext } : null;

     result.data.forEach((parsedRow: any) => {
         const handle = (parsedRow['handle'] || "").trim();
         let title = (parsedRow['title'] || "").trim();
         let priceStr = parsedRow['variant price'];
         let weightStr = parsedRow['variant grams'];
         let imageStr = parsedRow['image src'];
         let bodyHtml = parsedRow['body (html)'];
         let productCategory = parsedRow['product category'];
         let imagePositionStr = parsedRow['image position'];
         let imageAltText = parsedRow['image alt text'];

         // Smart Inheritance Logic
         if (handle) {
             if (context && context.handle === handle) {
                 // Same product, inherit if missing
                 if (!title) title = context.description;
                 if (!priceStr && context.price !== undefined) priceStr = String(context.price);
                 if (!weightStr && context.weight !== undefined) weightStr = String(context.weight);
                 if (!productCategory) productCategory = context.productCategory;
             } else {
                 // New product, context will update at end of loop if valid
             }
         }

         const janCode = (parsedRow['variant sku'] || "").toString().trim();
         let item: ShopifyImportItem | null = null;
         let error: string | undefined = undefined;
         
         if (!janCode) {
             if (handle && imageStr) {
                 // Valid Image Row
             } else {
                 error = "Missing Variant SKU";
             }
         } 
         
         if (!error) {
             const qty = parseInt((parsedRow['variant inventory qty'] || "0").replace(/[^0-9-]/g, ""), 10) || 0;
             const price = priceStr ? parseFloat(priceStr.replace(/[^0-9.]/g, "")) : undefined;
             const weight = weightStr ? parseFloat(weightStr.replace(/[^0-9.]/g, "")) : undefined;
             let variantImageStr = parsedRow['variant image'];
             
             const image = janCode ? (variantImageStr || "") : (imageStr || ""); 
             const pos = imagePositionStr ? parseInt(imagePositionStr, 10) : undefined;
             
             item = {
                janCode,
                description: title,
                qty,
                price,
                weight,
                image,
                handle: handle,
                bodyHtml: bodyHtml || "",
                productCategory: productCategory || "",
                imagePosition: pos,
                imageAltText: imageAltText || "",
                listingImage: imageStr || undefined
             };
             
             if (handle) {
                if (!context || context.handle !== handle) {
                    context = {
                        handle,
                        description: title,
                        price,
                        weight,
                        image,
                        bodyHtml,
                        productCategory,
                        imagePosition: pos,
                        imageAltText
                    };
                }
             }
         }
         
         items.push({ item, error });
     });
     
     return { items, nextContext: context };
};
 
// Helper for Root Reducer
export type ShopifyImportBatchFilter = "MATCH" | "NEW" | "RESOLVED";

export interface ImportBatchOptions {
    useShopifyDescription?: boolean;
    useShopifyImages?: boolean;
    ignoreShopifyQty?: boolean;
    useShopifyHandles?: boolean;
}

export const computeShopifyImportBatch = (
    state: ShopifyImportState,
    inventoryIdToItem: Record<string, any>,
    handleToListing: Record<string, any>,
    filter: ShopifyImportBatchFilter,
    options?: ImportBatchOptions
): { updates: any[], listingUpdates: any[], indices: number[] } => {
    const updates: any[] = [];
    const listingUpdates: any[] = [];
    const indices: number[] = [];
    const createdHandles = new Set<string>();

    // Pre-scan to map CSV Handles and JANs
    const csvHandleToJan = new Map<string, string>();
    const janToRow = new Map<string, any>();

    state.rows.forEach(r => {
        if (r.parsed && r.parsed.janCode) {
            janToRow.set(r.parsed.janCode, r.parsed);
        }
        if (r.parsed && r.parsed.handle && r.parsed.janCode) {
            csvHandleToJan.set(r.parsed.handle, r.parsed.janCode);
        }
    });

    const getStoreHandle = (csvHandle: string): string => {
        // If we are strictly using CSV Handles (User Intent: Rename), trust the CSV handle!
        if (options?.useShopifyHandles) return csvHandle;

        const jan = csvHandleToJan.get(csvHandle);
        if (jan) {
            const inv = inventoryIdToItem[jan];
            if (inv && inv.handle) return inv.handle;
        }
        return csvHandle;
    };


    const useDesc = options?.useShopifyDescription ?? false;
    const useImg = options?.useShopifyImages ?? false;
    const useHandles = options?.useShopifyHandles ?? false;
    const ignoreQty = options?.ignoreShopifyQty ?? false;

    state.rows.forEach((row, index) => {
        if (row.processed) return;
        if (row.error) return; // Skip errors
        if (!row.parsed) return; // Should not happen if no error

        const item = row.parsed;
        const exists = inventoryIdToItem[item.janCode];
        
        // Resolve the handle we should strictly use for Listings
        const storeHandle = getStoreHandle(item.handle || "");

        // RESOLVED Handling
        if (filter === "RESOLVED") {
             const resolutions = state.resolutions[index];
             if (resolutions && resolutions.length > 0) {
                 resolutions.forEach(res => {
                     // Assume standard resolution payload
                     if (res.payload.itemKey) {
                         const invItem = inventoryIdToItem[res.payload.itemKey];
                         if (invItem) {
                             updates.push({
                                 type: 'update',
                                 id: res.payload.itemKey,
                                 item: { ...invItem, ...res.payload }
                             });
                         }
                     }
                 });
                 indices.push(index);
             }
             return;
        }

        const resolutions = state.resolutions[index];
        if (resolutions && resolutions.length > 0) return;

        // Identify Matching Keys (Strict)
        const matchingKeys: string[] = [];
        if (exists) {
            matchingKeys.push(item.janCode);
        }

        // Check for "Listing Match" using Resolved Store Handle
        const hasListingMatch = storeHandle && handleToListing[storeHandle];
        
        // Check for "Inventory Match by Handle" (e.g. Image row matching existing inventory item)
        const parentJan = csvHandleToJan.get(item.handle || "");
        const isInventoryHandleMatch = storeHandle && parentJan && !!inventoryIdToItem[parentJan];

        if (filter === "MATCH" && (matchingKeys.length > 0 || hasListingMatch || isInventoryHandleMatch)) {
            
            // Apply updates to ALL matching keys
            matchingKeys.forEach(key => {
                const currentItem = inventoryIdToItem[key];
                if (!currentItem) return;

                let delta = 0;
                if (!ignoreQty) {
                    const currentTotal = currentItem.qty || 0;
                    const shipped = currentItem.shipped || 0;
                    const targetTotal = (item.qty || 0) + shipped;
                    delta = targetTotal - currentTotal;
                }

                const newItem = {
                    ...currentItem,
                    price: item.price,
                    weight: item.weight,
                    ...(useHandles ? { handle: item.handle } : {}), 
                    ...(ignoreQty ? {} : { qty: delta }),
                    ...(useDesc ? { description: item.description } : {}), 
                    ...(useImg ? { image: item.image, listingImage: item.listingImage } : {}),
                    bodyHtml: item.bodyHtml,
                    productCategory: item.productCategory,
                };
                
                updates.push({
                    type: "update",
                    id: key,
                    item: newItem
                });
            });

            indices.push(index);

            // Add Image to Listing (Gallery) using Store Handle
            if (useImg && storeHandle) { 
                 const listingExists = handleToListing[storeHandle] || createdHandles.has(storeHandle);

                 // RECOVERY: If listing missing, try to find parent in this batch and create it
                 if (!listingExists) {
                      const parentItem = parentJan ? janToRow.get(parentJan) : null;
                      
                      if (parentItem) {
                          listingUpdates.push({
                              type: "create_listing",
                              listing: {
                                  handle: storeHandle,
                                  title: parentItem.description || "Untitled", 
                                  bodyHtml: parentItem.bodyHtml || "",
                                  productCategory: parentItem.productCategory || "",
                                  productType: "",
                                  vendor: "SPNSS Ltd.",
                                  tags: [],
                                  status: "active",
                                  option1Name: "Title",
                                  images: [],
                                  lastUpdated: Date.now()
                              }
                          });
                          createdHandles.add(storeHandle);
                      }
                 }

                 const targetImage = item.listingImage || item.image;
                 
                 if (targetImage) {
                     let alreadyHasImage = false;
                     // Listing might be in handleToListing OR just created (not in handleToListing yet)
                     // If created, images is empty.
                     const listing = handleToListing[storeHandle];
                     if (listing && listing.images) {
                         alreadyHasImage = listing.images.some((img: any) => img.url === targetImage);
                     }

                     if (!alreadyHasImage) {
                         listingUpdates.push({
                             type: "add_image",
                             handle: storeHandle,
                             image: { url: targetImage, altText: item.imageAltText || "" }
                         });
                     }
                 }
            }
        } else if (filter === "NEW" && !exists) {
             if (item.janCode) {
                 // Real New Item
                 updates.push({
                     type: "new",
                     id: item.janCode,
                     item: item
                 });
                 if (storeHandle) createdHandles.add(storeHandle);
                 indices.push(index);
             } else if (storeHandle) {
                 const listingExists = handleToListing[storeHandle] || createdHandles.has(storeHandle);
                 
                 // RECOVERY: If listing missing, try to find parent in this batch and create it
                 if (!listingExists) {
                      const parentJan = csvHandleToJan.get(item.handle || "");
                      const parentItem = parentJan ? janToRow.get(parentJan) : null;
                      
                      if (parentItem) {
                          listingUpdates.push({
                              type: "create_listing",
                              listing: {
                                  handle: storeHandle,
                                  title: parentItem.description || "Untitled", 
                                  bodyHtml: parentItem.bodyHtml || "",
                                  productCategory: parentItem.productCategory || "",
                                  productType: "",
                                  vendor: "SPNSS Ltd.",
                                  tags: [],
                                  status: "active",
                                  option1Name: "Title",
                                  images: [],
                                  lastUpdated: Date.now()
                              }
                          });
                          createdHandles.add(storeHandle);
                      }
                 }

                 if (handleToListing[storeHandle] || createdHandles.has(storeHandle)) {
                      const targetImage = item.listingImage || item.image;
                      if (targetImage) {
                           listingUpdates.push({
                               type: "add_image",
                               handle: storeHandle,
                               image: { url: targetImage, altText: item.imageAltText || "" }
                           });
                           indices.push(index);
                      }
                 }
             }
        }
    });

    return { updates, listingUpdates, indices };
};

const shopifyImportSlice = createSlice({
  name: "shopifyImport",
  initialState,
  reducers: {
    start_session: (state, action: PayloadAction<{ id: string; name: string }>) => {
      state.activeFile = action.payload;
      state.step = "idle";
      state.headerRow = null;
      state.rows = [];
      state.resolutions = {};
      state.lastSeenProduct = null;
    },
    set_header: (state, action: PayloadAction<string>) => {
        state.headerRow = action.payload;
        state.step = "importing";
    },
    append_raw_rows: (state, action: PayloadAction<{ rawRows: string[], done: boolean }>) => {
        const { rawRows, done } = action.payload;
        
        if (!state.headerRow) {
            rawRows.forEach(r => state.rows.push({ raw: r, parsed: null, error: "Missing Header" }));
        } else {
             const { items, nextContext } = parseShopifyChunk(state.headerRow, rawRows, state.lastSeenProduct);
             
             items.forEach((res, i) => {
                 state.rows.push({
                     raw: rawRows[i] || "", // Map back to raw if possible, though PapaParse consumed it. 
                                            // Ideally we use original rawRows index.
                                            // The chunk size matches, so index i corresponds to rawRows[i].
                     parsed: res.item,
                     error: res.error
                 });
             });
             state.lastSeenProduct = nextContext;
        }

        if (done) {
            state.step = "review";
            state.lastSeenProduct = null;
        } else {
             state.step = "importing";
        }
    },
    resolve_conflict: (
        state, 
        action: PayloadAction<{ index: number; resolvedActions: any[] }>
    ) => {
        const { index, resolvedActions } = action.payload;
        state.resolutions[index] = resolvedActions;
    },
    mark_items_done: (state, action: PayloadAction<{ indices: number[] }>) => {
        const { indices } = action.payload;
        indices.forEach(i => {
            if (state.rows[i]) {
                state.rows[i].processed = true;
            }
        });
    },
    clear_import: (state) => {
        state.activeFile = null;
        state.step = "idle";
        state.headerRow = null;
        state.rows = [];
        state.resolutions = {};
    },
    finish_import: (state: ShopifyImportState) => {
        state.activeFile = null;
        state.step = "idle";
        state.headerRow = null;
        state.rows = [];
        state.resolutions = {};
    },
    import_batch: (state, action: PayloadAction<{ filter: ShopifyImportBatchFilter; options?: ImportBatchOptions }>) => {
        // Trigger action for root reducer
    }
  },
});

export const { start_session, set_header, append_raw_rows, resolve_conflict, mark_items_done, clear_import, finish_import, import_batch } = shopifyImportSlice.actions;
export const shopifyImport = shopifyImportSlice.reducer;
