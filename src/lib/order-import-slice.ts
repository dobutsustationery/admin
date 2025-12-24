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
const reparse = (state: OrderImportState) => {
    // Combine Header and Body.
    // Legacy Header Fix: If the header was truncated inside a quote, 
    // simply joining it with the body (which starts with the rest of the quote)
    // will produce a valid CSV structure where the newline is accepted as part of the header column.
    // This naturally aligns the subsequent columns without manual healing logic.
    const fullCsv = (state.headerRow ? state.headerRow + "\n" : "") + (state.rawBody || "");
    
    if (!fullCsv.trim()) return;

    // Use Papa Parse on the full content
    const result = Papa.parse(fullCsv, {
        header: true,
        skipEmptyLines: "greedy", 
        transformHeader: (h) => h.trim().toLowerCase(), 
    });

    state.rows = [];

    result.data.forEach((row: any) => {
        // Cleaning: Normalize keys
        // Identify Map Keys
        const janCode = (row['jan code'] || row['jan_code'] || row['jancode'] || "").toString().trim();
        
        // Garbage Filter removed per user request
        
        // Skip purely empty rows (Papa parse might yield one depending on trailing newline)
        if (!janCode && Object.keys(row).length < 2) return;

        // Build Import Item
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
                 
        state.rows.push({
            raw: "", // We don't track exact raw lines in one-shot mode easily, unnecessary for display
            parsed: item,
            error: error
        });
    });
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
        // In legacy flow, header comes first. If body exists, reparse.
        if (state.rawBody) reparse(state);
    },
    
    // append_csv_chunk REMOVED: Legacy append_raw_rows is now the unified action.
    
    append_raw_rows: (state, action: PayloadAction<{ rawRows: string[] | string, done: boolean }>) => {
        const { rawRows, done } = action.payload;
        // Handle legacy array or string payload
        const text = Array.isArray(rawRows) ? rawRows.join("\n") : String(rawRows);
        
        state.rawBody = (state.rawBody || "") + text + "\n"; // Append newline for row separation
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
    }
  },
});

export const { start_session, set_header, append_raw_rows, resolve_conflict, mark_items_done, clear_import, finish_import } = orderImportSlice.actions;
export const orderImport = orderImportSlice.reducer;
