import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import Papa from "papaparse";

export interface ImportItem {
  janCode: string;
  description: string;
  qty: number;
  carton: string;
  hsCode?: string;
  processed?: boolean;
  price?: number;
  weight?: number; // in grams
  countryOfOrigin?: string;
}

export interface RawRow {
    raw: string; // The raw CSV line (approximate)
    parsed: ImportItem | null;
    error?: string;
    processed?: boolean;
}

export interface ResolutionAction {
  type: string;
  payload: any;
}

export interface OrderImportState {
  activeFile: { id: string; name: string } | null;
  step: "idle" | "importing" | "review"; 
  headerRow: string | null;
  rawBody: string; // Full accumulated CSV body
  rows: RawRow[]; 
  resolutions: Record<number, ResolutionAction[]>;
}

const initialState: OrderImportState = {
  activeFile: null,
  step: "idle",
  headerRow: null,
  rawBody: "",
  rows: [],
  resolutions: {},
};

// Heuristic to find HS Code in parsed columns if not explicitly named
const findHSCode = (row: any): string => {
   const candidates = Object.entries(row).filter(([key, val]) => {
      return /hs\s*code/.test(key.toLowerCase());
   });

   for (const [key, val] of candidates) {
       const v = String(val).trim();
       if (!v) continue;
       if (/[a-zA-Z]/.test(v)) continue;
       if (!/\d/.test(v)) continue;
       if (/^[\d\.\s\-/]+$/.test(v)) {
           return v;
       }
   }
   return "";
 };

const mapImportItem = (row: any): ImportItem => {
    const janCode = (row['jan code'] || row['jan_code'] || row['jancode'] || "").toString().trim();
    return {
        janCode,
        description: row['description'] || "",
        qty: parseInt(row['total pcs'] || row['qty'] || row["order q'ty pcs"] || "0", 10),
        carton: row['carton number'] || row['carton'] || "",
        hsCode: findHSCode(row),
        price: row['price'] ? parseFloat(row['price'].replace(/[^0-9.]/g, "")) : undefined,
        weight: row['weight'] ? parseFloat(row['weight'].replace(/[^0-9.]/g, "")) : undefined,
        countryOfOrigin: row['country of origin'] || row['origin'] || row['country'] || undefined,
    };
};

// Core Parsing Logic: One-Shot
export const parseRows = (headerRow: string | null, rawBody: string): ImportItem[] => {
    // Combine Header and Body.
    // Legacy Header Fix: If the header was truncated inside a quote, 
    // simply joining it with the body (which starts with the rest of the quote)
    // will produce a valid CSV structure where the newline is accepted as part of the header column.
    // This naturally aligns the subsequent columns without manual healing logic.
    const fullCsv = (headerRow ? headerRow + "\n" : "") + (rawBody || "");
    
    if (!fullCsv.trim()) return [];

    // Use Papa Parse on the full content
    const result = Papa.parse(fullCsv, {
        header: true,
        skipEmptyLines: "greedy", 
        transformHeader: (h) => h.trim().toLowerCase(), 
    });

    const parsedItems: ImportItem[] = [];

    result.data.forEach((row: any) => {
        // Cleaning: Normalize keys
        // Identify Map Keys
        const janCode = (row['jan code'] || row['jan_code'] || row['jancode'] || "").toString().trim();
        
        // Skip purely empty rows (Papa parse might yield one depending on trailing newline)
        if (!janCode && Object.keys(row).length < 2) return;

        // Build Import Item
        let item: ImportItem;
                 
        if (!janCode) {
            // Skip rows without Jan Code in output for now or mark error?
            // The logic below pushed error items. We return ImportItem array.
            // But ImportItem interface handles valid items. 
            // If we want to support errors we might need a richer return type.
            // For `reparse` (UI), we need errors. 
            // For `finalize` (Action), we typically only import valid or error?
            // Let's assume we return ALL and filter later?
            // Actually, let's keep the exact logic:
            // "item" is null if no Jan Code.
            // But we need to return ImportItem[] for the internal action?
            // The synthetic action `bulk_import_items` expects `BulkImportItem[]` which wraps `Item`.
            // Let's output a cleaner structure from here.
            
            // Wait, this function is used by `reparse` to populate state.rows (RawRow[]).
            // So it should probably return something that maps to RawRow, or RawRow logic stays here?
            
            // Let's return ParsedRow[] where ParsedRow has item | error.
            return;
        } 

        const hs = findHSCode(row);
        
        item = {
            janCode,
            description: row['description'] || "",
            qty: parseInt(row['total pcs'] || row['qty'] || row["order q'ty pcs"] || "0", 10),
            carton: row['carton number'] || row['carton'] || "",
            hsCode: hs,
            price: row['price'] ? parseFloat(row['price'].replace(/[^0-9.]/g, "")) : undefined,
            weight: row['weight'] ? parseFloat(row['weight'].replace(/[^0-9.]/g, "")) : undefined,
            countryOfOrigin: row['country of origin'] || row['origin'] || row['country'] || undefined,
        };
        
        parsedItems.push(item);
    });
    
    return parsedItems;
};

// Internal helper that returns rich status for UI
const generateUIState = (headerRow: string | null, rawBody: string): RawRow[] => {
     const fullCsv = (headerRow ? headerRow + "\n" : "") + (rawBody || "");
    if (!fullCsv.trim()) return [];

    const result = Papa.parse(fullCsv, {
        header: true,
        skipEmptyLines: "greedy", 
        transformHeader: (h) => h.trim().toLowerCase(), 
    });

    const rows: RawRow[] = [];

    result.data.forEach((row: any) => {
        const janCode = (row['jan code'] || row['jan_code'] || row['jancode'] || "").toString().trim();
        if (!janCode && Object.keys(row).length < 2) return;

        let item: ImportItem | null = null;
        let error: string | undefined = undefined;
                 
        if (!janCode) {
            error = "Missing JAN Code";
        } else {
            const hs = findHSCode(row);
            item = {
                janCode,
                description: row['description'] || "",
                qty: parseInt(row['total pcs'] || row['qty'] || row["order q'ty pcs"] || "0", 10),
                carton: row['carton number'] || row['carton'] || "",
                hsCode: hs,
                price: row['price'] ? parseFloat(row['price'].replace(/[^0-9.]/g, "")) : undefined,
                weight: row['weight'] ? parseFloat(row['weight'].replace(/[^0-9.]/g, "")) : undefined,
                countryOfOrigin: row['country of origin'] || row['origin'] || row['country'] || undefined,
            };
        }
                 
        rows.push({
            raw: "", 
            parsed: item,
            error: error
        });
    });
    return rows;
}

const reparse = (state: OrderImportState) => {
    state.rows = generateUIState(state.headerRow, state.rawBody);
};


// Helper to compute batch updates for Root Reducer
export type ImportBatchFilter = "MATCH" | "NEW" | "RESOLVED";

export const computeOrderImportBatch = (
    orderState: OrderImportState, 
    inventoryIdToItem: Record<string, any>, // Item from inventory slice
    filter: ImportBatchFilter
): { updates: any[], indices: number[] } => {
    
    const updates: any[] = [];
    const indices: number[] = [];

    // Parse fresh (or use cached if we stored ParsedRow, but we use one-shot parseRows)
    const items = parseRows(orderState.headerRow, orderState.rawBody);

    items.forEach((item, index) => {
        // Skip if already processed
        // Check state.rows[index].processed
        // We assume parseRows returns items in same order as state.rows
        if (orderState.rows[index]?.processed) return;

        // RESOLVED Handling
        if (filter === "RESOLVED") {
            const resolutions = orderState.resolutions[index];
            if (resolutions && resolutions.length > 0) {
                 resolutions.forEach(res => {
                     // ResolutionAction.payload is the bulk update item effectively?
                     // In UI: type: "update_item", payload: { itemKey, qty, ... }
                     // We need to map this to BulkImportItem.
                     // BulkImportItem: { type: "update"|"new", id: ..., item: ... }
                     // The resolution payload from UI::processResolvedConflicts:
                     // { type: "update_item", payload: { itemKey, qty ... } }
                     
                     // We trust the UI resolved actions payload structure
                     const itemKey = res.payload.itemKey;
                     const qty = res.payload.qty;
                     
                     // Construct payload
                     const invItem = inventoryIdToItem[itemKey];
                     if (invItem) {
                          const payloadItem = {
                            ...invItem,
                            qty: qty, // This overwrites/updates based on intent
                            hsCode: res.payload.hsCode !== undefined ? res.payload.hsCode : invItem.hsCode,
                            weight: res.payload.weight !== undefined ? res.payload.weight : invItem.weight,
                            countryOfOrigin: res.payload.countryOfOrigin !== undefined ? res.payload.countryOfOrigin : invItem.countryOfOrigin
                          };
                          
                          updates.push({
                              type: 'update',
                              id: itemKey,
                              item: payloadItem
                          });
                     }
                 });
                 // Mark all resolved indices as handled
                 indices.push(index);
            }
            return;
        }

        // MATCH / NEW Handling
        const resolutions = orderState.resolutions[index];
        if (resolutions && resolutions.length > 0) return; // Prioritize Resolved filter for these

        // Logic from analyzedPlan
        const exists = inventoryIdToItem[item.janCode];
        
        if (filter === "MATCH" && exists) {
             updates.push({
                 type: "update",
                 id: item.janCode,
                 item: {
                     ...exists, 
                     // Pass the import values (will be merged/added by inventory reducer)
                     // But we want to use the imported Qty as the delta.
                     // The `mapOrderToInventory` sets `qty` from import.
                     // If we pass `exists`... wait.
                     // If we pass `exists`, we are overwriting the import data with old data?
                     // Verify `applyInventoryUpdate` in `inventory.ts`.
                     // It does `...existingItem, ...updateItem`. 
                     // So we should pass the NEW data as the `item` in `updates`.
                     // BUT we need `subtype`, `image` etc from existing if we want to preserve them?
                     // Actually `update_item` logic in `inventory.ts`:
                     // `const updatedItem = { ...state.idToItem[id], ...item };`
                     // So we only need to pass the FIELDS we want to update.
                     // We don't need to pass `...exists`.
                     
                     janCode: item.janCode,
                     qty: item.qty, // Delta
                     price: item.price, // Overwrite price? Receipts usually have current price.
                     weight: item.weight, // Overwrite weight? Usually safe.
                     // Safe Overwrite for generic fields
                     hsCode: exists.hsCode ? exists.hsCode : item.hsCode, 
                     countryOfOrigin: exists.countryOfOrigin ? exists.countryOfOrigin : item.countryOfOrigin
                 } 
             });
             indices.push(index);

        } else if (filter === "NEW" && !exists) {
            updates.push({
                type: "new",
                id: item.janCode,
                item: item // Will be mapped by mapOrderToInventory in Root Reducer?
                           // No, `computeOrderImportBatch` returns `any[]`.
                           // The Root Reducer calls `mapOrderToInventory(p)`.
                           // But here we are constructing the update object manually for logic.
                           // Actually the Root Reducer logic I implemented EARLIER simple-maps ALL items.
                           // I need to UPDATE Root Reducer to use this `computeOrderImportBatch` function.
                           // And this function should return `BulkImportItem[]`.
                           
                           // So I should map it here.
            });
            indices.push(index);
        }
    });

    return { updates, indices };
};

const orderImportSlice = createSlice({
  name: "orderImport",
  initialState,
  reducers: {
    start_session: (state, action: PayloadAction<{ id: string; name: string }>) => {
      state.activeFile = action.payload;
      state.step = "idle";
      state.headerRow = null;
      state.rawBody = "";
      state.rows = [];
      state.resolutions = {};
    },
    
    set_header: (state, action: PayloadAction<string>) => {
        state.headerRow = action.payload;
        if (state.rawBody) reparse(state);
    },
    
    append_raw_rows: (state, action: PayloadAction<{ rawRows: string[] | string, done: boolean }>) => {
        const { rawRows, done } = action.payload;
        const text = Array.isArray(rawRows) ? rawRows.join("\n") : String(rawRows);
        state.rawBody = (state.rawBody || "") + text + "\n";
        reparse(state);
        
        if (done) state.step = "review";
        else state.step = "importing";
    },
    
    resolve_conflict: (state, action: PayloadAction<{ index: number; resolvedActions: any[] }>) => {
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
        state.rawBody = "";
        state.rows = [];
        state.resolutions = {};
    },
    
    finish_import: (state) => {
        state.activeFile = null;
        state.step = "idle";
        state.headerRow = null;
        state.rawBody = "";
        state.rows = [];
        state.resolutions = {};
    },

    import_batch: (state, action: PayloadAction<{ filter: ImportBatchFilter }>) => {
        // Trigger action
    }
  },
});

export const { start_session, set_header, append_raw_rows, resolve_conflict, mark_items_done, clear_import, finish_import, import_batch } = orderImportSlice.actions;
export const orderImport = orderImportSlice.reducer;
