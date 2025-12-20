import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import Papa from "papaparse";

export interface ImportItem {
  janCode: string;
  description: string;
  qty: number;
  carton: string;
  hsCode?: string;
  processed?: boolean;
}

export interface RawRow {
    raw: string;
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
  step: "idle" | "importing" | "review"; // "importing" means receiving data
  headerRow: string | null;
  rows: RawRow[]; // The source of truth
  
  // Legacy/Derived "plan" view might be removed or computed, 
  // but for backward compat in UI during refactor, let's just use 'rows' in UI.
  // resolutions map index in 'rows' array to actions
  resolutions: Record<number, ResolutionAction[]>;
}

const initialState: OrderImportState = {
  activeFile: null,
  step: "idle",
  headerRow: null,
  rows: [],
  resolutions: {},
};
 
 const findHSCode = (row: any): string => {
   // 1. Candidate Pattern
   const candidates = Object.entries(row).filter(([key, val]) => {
      // Strict matching: "hs" followed by optional whitespace followed by "code"
      return /hs\s*code/.test(key.toLowerCase());
   });

   // 2. Value Heuristic
   for (const [key, val] of candidates) {
       const v = String(val).trim();
       if (!v) continue;
       
       // Reject if contains alphabet letters A-Z (descriptions usually do)
       // Exception: "HS 1234"? No, assuming clean codes.
       if (/[a-zA-Z]/.test(v)) continue;
       
       // Must contain at least one digit
       if (!/\d/.test(v)) continue;
       
       // Allowed chars: Digits, dots, spaces, dashes (maybe slashes?)
       if (/^[\d\.\s\-/]+$/.test(v)) {
           return v;
       }
   }
   
   return "";
 };
 
 const orderImportSlice = createSlice({
  name: "orderImport",
  initialState,
  reducers: {
    start_session: (state, action: PayloadAction<{ id: string; name: string }>) => {
      state.activeFile = action.payload;
      state.step = "idle";
      state.headerRow = null;
      state.rows = [];
      state.resolutions = {};
    },
    set_header: (state, action: PayloadAction<string>) => {
        state.headerRow = action.payload;
        state.step = "importing";
    },
    append_raw_rows: (state, action: PayloadAction<{ rawRows: string[], done: boolean }>) => {
        const { rawRows, done } = action.payload;
        
        // Parse logic in reducer!
        // We use the stored header to parse these specific rows.
        // We can use Papa.parse on the joined string with the header? 
        // Or cleaner: construct a mini-CSV string "header\nrow" for each?
        // Or just manual parse if we assume simple structure? 
        // User said "parsing... in reducer". Papa is safest for quotes etc.
        
        if (!state.headerRow) {
            // If no header yet, treat everything as error or wait?
            // Should not happen if protocol matches.
            rawRows.forEach(r => state.rows.push({ raw: r, parsed: null, error: "Missing Header" }));
        } else {
             // To parse correctly we need the header.
             // Papa.parse expects a string.
             const csvChunk = [state.headerRow, ...rawRows].join("\n");
             
             const result = Papa.parse(csvChunk, {
                  header: true,
                  skipEmptyLines: true,
                  transformHeader: (h) => h.trim().toLowerCase(), 
             });
             
             // Result.data will contain the parsed objects.
             // Note: Papa parse result might include the header row in meta, but data matches rows?
             // If we provide header row in input, data[0] corresponds to rawRows[0].
             
             // Verification:
             // Header: A,B
             // Row 1: 1,2
             // Input: "A,B\n1,2"
             // Output Data: [{A:1, B:2}] -> Correct.
             
             result.data.forEach((parsedRow: any, i) => {
                 // Basic Mapping
                 const janCode = (parsedRow['jan code'] || parsedRow['jan_code'] || parsedRow['jancode'] || "").toString().trim();
                 let item: ImportItem | null = null;
                 let error: string | undefined = undefined;
                 
                 if (!janCode) {
                     error = "Missing JAN Code";
                 } else {
                     item = {
                        janCode,
                        description: parsedRow['description'] || "",
                        qty: parseInt(parsedRow['total pcs'] || parsedRow['qty'] || "0", 10),
                        carton: parsedRow['carton number'] || parsedRow['carton'] || "",
                        hsCode: findHSCode(parsedRow),
                     };
                 }
                 
                 state.rows.push({
                     raw: rawRows[i], // rawRows index matches data index hopefully? 
                     // Wait, Papa.parse might skip empty lines. rawRows might have empty strings?
                     // If we used skipEmptyLines: true, indexes might shift if rawRows had empties.
                     // Better: Parse one by one or ensure rawRows are non-empty before dispatch.
                     // The UI should filter empty lines before dispatching "append_raw_rows".
                     parsed: item,
                     error: error
                 });
             });
        }

        if (done) {
            state.step = "review";
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
    finish_import: (state: OrderImportState) => {
        // Same as clear for now, but distinct intent
        state.activeFile = null;
        state.step = "idle";
        state.headerRow = null;
        state.rows = [];
        state.resolutions = {};
    }
  },
});

export const { start_session, set_header, append_raw_rows, resolve_conflict, mark_items_done, clear_import, finish_import } = orderImportSlice.actions;
export const orderImport = orderImportSlice.reducer;
