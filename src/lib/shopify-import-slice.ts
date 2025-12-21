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
  lastSeenProduct: { handle: string; description: string } | null;
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
                 
                 // Smart Inheritance Logic
                 if (handle) {
                     if (state.lastSeenProduct && state.lastSeenProduct.handle === handle) {
                         // Same product, inherit if missing
                         if (!title) {
                             console.log(`[Inherit] Inheriting title for ${handle}: ${state.lastSeenProduct.description}`);
                             title = state.lastSeenProduct.description;
                         }
                     } else {
                         // New product, update cache
                         console.log(`[Inherit] New product ${handle}: ${title}`);
                         state.lastSeenProduct = { handle, description: title };
                     }
                 } else {
                     console.log(`[Inherit] No handle for row`, parsedRow);
                 }

                 const janCode = (parsedRow['variant sku'] || "").toString().trim();
                 let item: ShopifyImportItem | null = null;
                 let error: string | undefined = undefined;
                 
                 if (!janCode) {
                     error = "Missing Variant SKU";
                 } else {
                     item = {
                        janCode,
                        description: title,
                        qty: parseInt(parsedRow['variant inventory qty'] || "0", 10),
                        price: parsedRow['variant price'] ? parseFloat(parsedRow['variant price'].replace(/[^0-9.]/g, "")) : undefined,
                        weight: parsedRow['variant grams'] ? parseFloat(parsedRow['variant grams'].replace(/[^0-9.]/g, "")) : undefined,
                        image: parsedRow['image src'] || "",
                        handle: handle,
                        
                        // New Parsed Fields
                        bodyHtml: parsedRow['body (html)'] || "",
                        productCategory: parsedRow['product category'] || "",
                        imagePosition: parsedRow['image position'] ? parseInt(parsedRow['image position'], 10) : undefined,
                        imageAltText: parsedRow['image alt text'] || ""
                     };
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
