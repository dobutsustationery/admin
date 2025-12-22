import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import Papa from "papaparse";

export interface ShopifyImportItem {
  janCode: string;
  description: string;
  qty: number; // Variant Inventory Qty
  price?: number; // Variant Price
  weight?: number; // Variant Grams
  image?: string; // Image Src (URL)
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

export interface ShopifyImportState {
  activeFile: { id: string; name: string } | null;
  step: "idle" | "importing" | "review"; 
  headerRow: string | null;
  rows: RawRow[];
  resolutions: Record<number, ResolutionAction[]>;
  lastSeenProduct: { 
    handle: string; 
    description: string;
    price?: number;
    weight?: number;
    image?: string;
    bodyHtml?: string;
    productCategory?: string;
    imagePosition?: number;
    imageAltText?: string;
  } | null;
}

const initialState: ShopifyImportState = {
  activeFile: null,
  step: "idle",
  headerRow: null,
  rows: [],
  resolutions: {},
  lastSeenProduct: null,
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
             const csvChunk = [state.headerRow, ...rawRows].join("\n");
             
             const result = Papa.parse(csvChunk, {
                  header: true,
                  skipEmptyLines: true,
                  transformHeader: (h) => h.trim().toLowerCase(), 
             });
             
             result.data.forEach((parsedRow: any, i) => {
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
                     if (state.lastSeenProduct && state.lastSeenProduct.handle === handle) {
                         // Same product, inherit if missing
                         if (!title) title = state.lastSeenProduct.description;
                         if (!priceStr && state.lastSeenProduct.price !== undefined) priceStr = String(state.lastSeenProduct.price);
                         if (!weightStr && state.lastSeenProduct.weight !== undefined) weightStr = String(state.lastSeenProduct.weight);
                         // Note: Image often varies by variant for color, but basic image might restart?
                         // Shopify logic: First Row = Product Image. Subseq rows = Variant Images?
                         // Use case: Blank means use parent?
                         // Let's assume blank means inherit for these too based on request (description, category, price, weight).
                         // The prompt specifically asked for: price, weight, description, and category.
                         if (!productCategory) productCategory = state.lastSeenProduct.productCategory;
                     } else {
                         // New product, update cache with parsed values (need to parse first to store valid numbers?)
                         // Store RAW or PARSED?
                         // Let's parse the numbers for the cache to be safe, or just store what we successfully parsed.
                         // But we haven't parsed yet.
                         // Let's do a preliminary parse or just store the strings?
                         // Better: Parse first, then define item, then update cache.
                     }
                 }

                 const janCode = (parsedRow['variant sku'] || "").toString().trim();
                 let item: ShopifyImportItem | null = null;
                 let error: string | undefined = undefined;
                 
                 if (!janCode) {
                     error = "Missing Variant SKU";
                 } else {
                     const qty = parseInt((parsedRow['variant inventory qty'] || "0").replace(/[^0-9-]/g, ""), 10) || 0;
                     const price = priceStr ? parseFloat(priceStr.replace(/[^0-9.]/g, "")) : undefined;
                     const weight = weightStr ? parseFloat(weightStr.replace(/[^0-9.]/g, "")) : undefined;
                     const image = imageStr || ""; // No inherit requested for image?
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
                        imageAltText: imageAltText || ""
                     };
                     
                     // Update Cache if valid handle and not inheriting (or even if inheriting? No, only update on fresh data?)
                     // If we are on the parenting row (or any row?), we should update cache?
                     // If it's the SAME handle, we probably don't want to overwrite cache with empty values.
                     // Only overwrite if present?
                     if (handle) {
                        if (!state.lastSeenProduct || state.lastSeenProduct.handle !== handle) {
                            // New Product
                            state.lastSeenProduct = {
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
                        } else {
                            // Same Product - maybe update cache if we found better data?
                            // Typically the first row has the master data.
                        }
                     }
                 }
                 
                 state.rows.push({
                     raw: rawRows[i], 
                     parsed: item,
                     error: error
                 });
             });
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
    }
  },
});

export const { start_session, set_header, append_raw_rows, resolve_conflict, mark_items_done, clear_import, finish_import } = shopifyImportSlice.actions;
export const shopifyImport = shopifyImportSlice.reducer;
