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
  cost?: number;
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

export const initialState: OrderImportState = {
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
    return /hs[\s-]*code/.test(key.toLowerCase());
  });

  for (const [key, val] of candidates) {
    const v = String(val).trim();
    if (!v) continue;
    if (/[a-zA-Z]/.test(v)) continue;
    if (!/\d/.test(v)) continue;
    if (/^[\d\.\s\-/]+$/.test(v)) {
      // Return without spaces
      return v.replace(/\s+/g, "");
    }
  }
  return "";
};

const normalizeHeaderKey = (key: string): string => {
  return key
    .normalize("NFKC")
    .replace(/\uFEFF/g, "")
    .toLowerCase()
    .replace(/[\r\n]+/g, " ") // Robust newline handling
    .replace(/\s+/g, " ")
    .trim();
};

const getOrderedRowCells = (
  row: Record<string, unknown>,
): Array<{ key: string; value: string }> => {
  return Object.entries(row)
    .filter(([key]) => key !== "__parsed_extra" && key !== "")
    .map(([key, value]) => ({ key, value: String(value ?? "").trim() }));
};

const getValueByHeaders = (
  row: Record<string, unknown>,
  headerPredicates: Array<(normalizedHeader: string) => boolean>,
  fallbackColumnIndex?: number,
): string | undefined => {
  const cells = getOrderedRowCells(row);

  for (const cell of cells) {
    const normalizedHeader = normalizeHeaderKey(cell.key);
    if (headerPredicates.some((predicate) => predicate(normalizedHeader))) {
      if (cell.value) return cell.value;
    }
  }

  if (fallbackColumnIndex !== undefined) {
    const fallback = cells[fallbackColumnIndex];
    if (fallback && fallback.value) {
      return fallback.value;
    }
  }

  return undefined;
};

const parseNumberish = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const cleaned = value.replace(/[^0-9.-]/g, "");
  if (!cleaned) return undefined;
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const mapImportItem = (row: any): ImportItem => {
  const janCode = (
    row["jan code"] ||
    row["jan_code"] ||
    row["jancode"] ||
    row["bar-code no."] ||
    ""
  )
    .toString()
    .trim();
  const countryOfOrigin = getValueByHeaders(row, [
    (h) => h === "country of origin",
    (h) => h === "origin",
    (h) => h === "country",
    (h) => h.includes("country of origin"),
  ]);

  const weight = parseNumberish(
    getValueByHeaders(row, [
      (h) => h === "weight",
      (h) => h.includes("weight in grams"),
      (h) => h.includes("per piece"),
      (h) => h.includes("weight in grams per piece"),
    ]),
  );

  const qty = parseInt(
      getValueByHeaders(row, [
          (h) => h === "total pcs",
          (h) => h === "qty",
          (h) => h.includes("q'ty") && !h.includes("unit"),
          (h) => h.includes("quantity") && !h.includes("unit"),
          (h) => /order\s*q'?ty/.test(h) && !h.includes("unit"),
      ]) || "0",
      10
  );

  return {
    janCode,
    description:
      row["description"] ||
      row["product name"] ||
      row["item name"] ||
      row["product"] ||
      row["title"] ||
      row["name"] ||
      row["product name（product number）"] ||
      "",
    qty,
    carton: row["carton number"] || row["carton"] || "",
    hsCode: findHSCode(row),
    // Map CSV 'unit price (yen)' (supplier cost) to 'cost'. Strict match required.
    cost: row["unit price (yen)"]
      ? parseFloat(row["unit price (yen)"].replace(/[^0-9.]/g, ""))
      : undefined,
    price: undefined,
    weight,
    countryOfOrigin: countryOfOrigin || undefined,
  };
};

// Core Parsing Logic: One-Shot
const parseCSV = (headerRow: string | null, rawBody: string): any[] => {
  const fullCsv = (headerRow ? headerRow + "\n" : "") + (rawBody || "");
  if (!fullCsv.trim()) return [];

  const result = Papa.parse(fullCsv, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim().toLowerCase(),
  });

  return result.data;
};

// Check if a row is effectively empty (no JAN code and few keys)
const isValidRow = (row: any, janCode: string): boolean => {
  // Skip purely empty rows or rows that clearly aren't data
  if (!janCode && Object.keys(row).length < 2) return false;
  return true;
};

export const parseRows = (
  headerRow: string | null,
  rawBody: string,
): ImportItem[] => {
  const data = parseCSV(headerRow, rawBody);
  const parsedItems: ImportItem[] = [];

  data.forEach((row: any) => {
    const item = mapImportItem(row);
    if (isValidRow(row, item.janCode) && item.janCode) {
      parsedItems.push(item);
    }
  });

  return parsedItems;
};

// Internal helper that returns rich status for UI
const generateUIState = (
  headerRow: string | null,
  rawBody: string,
): RawRow[] => {
  const data = parseCSV(headerRow, rawBody);
  const rows: RawRow[] = [];

  data.forEach((row: any) => {
    const item = mapImportItem(row);

    if (!isValidRow(row, item.janCode)) return;

    let error: string | undefined = undefined;
    let parsedItem: ImportItem | null = null;

    if (!item.janCode) {
      error = "Missing JAN Code";
    } else {
      parsedItem = item;
    }

    rows.push({
      raw: "", // We don't preserve raw line string in this optimization (Papa doesn't give it easily per row in JSON mode)
      parsed: parsedItem,
      error: error,
    });
  });
  return rows;
};

const reparse = (state: OrderImportState) => {
  state.rows = generateUIState(state.headerRow, state.rawBody);
};

// Helper to compute batch updates for Root Reducer
export type ImportBatchFilter = "MATCH" | "NEW" | "RESOLVED";

// Helper to optimize JAN lookup
const buildJanMap = (inventoryIdToItem: Record<string, any>) => {
  const map: Record<string, { id: string; item: any }[]> = {};
  Object.entries(inventoryIdToItem).forEach(([id, item]: [string, any]) => {
    if (item.janCode) {
      const jan = item.janCode.toString().trim();
      if (!map[jan]) map[jan] = [];
      map[jan].push({ id, item });
    }
  });
  return map;
};

export const computeOrderImportBatch = (
  orderState: OrderImportState,
  inventoryIdToItem: Record<string, any>,
  filter: ImportBatchFilter,
): { updates: any[]; indices: number[] } => {
  const updates: any[] = [];
  const indices: number[] = [];
  const janToItems = buildJanMap(inventoryIdToItem);

  // Use state.rows directly to ensure index alignment
  orderState.rows.forEach((row, index) => {
    if (row.processed) return;
    
    const item = row.parsed;
    if (!item) return; // Skip error rows

    // RESOLVED Handling
    if (filter === "RESOLVED") {
      const resolutions = orderState.resolutions[index];
      if (resolutions && resolutions.length > 0) {
        resolutions.forEach((res) => {
          const itemKey = res.payload.itemKey;
          const qty = res.payload.qty;
          const invItem = inventoryIdToItem[itemKey];
          if (invItem) {
              const payloadItem = {
                ...invItem,
                qty: qty,
                hsCode: res.payload.hsCode !== undefined ? res.payload.hsCode : (item.hsCode || invItem.hsCode),
                weight: res.payload.weight !== undefined ? res.payload.weight : (item.weight || invItem.weight),
                countryOfOrigin: res.payload.countryOfOrigin !== undefined ? res.payload.countryOfOrigin : (item.countryOfOrigin || invItem.countryOfOrigin),
                cost: res.payload.cost !== undefined ? res.payload.cost : (item.cost !== undefined ? item.cost : invItem.cost),
              };

            updates.push({
              type: "update",
              id: itemKey,
              item: payloadItem,
            });
          }
        });
        indices.push(index);
      }
      return;
    }

    // Skip items with pending manual resolutions if we are in batch mode
    const resolutions = orderState.resolutions[index];
    if (resolutions && resolutions.length > 0) return;

    const matches = janToItems[item.janCode] || [];
    const exists = matches.length > 0;
    
    // --- Conflict Detection ---
    let isConflict = false;
    let isDataMismatch = false;

    // 1. Subtype Conflict (Multiple Matches)
    if (matches.length > 1) {
        // Special Exception: If qty is 0, we allow it as a "Match" (updates cost/data on all)
        if (item.qty !== 0) {
            isConflict = true;
        }
    }

    // 2. Data Mismatch Conflict (Single Match OR Zero-Qty Multi-Match)
    // We check the FIRST item as the representative for data consistency
    if (exists) {
        const { item: existingItem } = matches[0];
        const existingHS = existingItem.hsCode;
        const newHS = item.hsCode;
        const existingWeight = existingItem.weight;
        const newWeight = item.weight;
        const existingCOO = existingItem.countryOfOrigin;
        const newCOO = item.countryOfOrigin;

        if (existingHS && newHS && existingHS !== newHS) isDataMismatch = true;
        if (existingWeight && newWeight && existingWeight !== newWeight) isDataMismatch = true;
        if (existingCOO && newCOO && existingCOO !== newCOO) isDataMismatch = true;
    }
    
    if (isDataMismatch) {
        isConflict = true;
    }

    // --- Action Generation ---

    if (filter === "MATCH" && exists && !isConflict) {
      if (item.qty === 0 && matches.length > 1) {
          // Zero Qty Multi-Match: Update ALL matches
          matches.forEach(({ id, item: existingItem }) => {
              updates.push({
                type: "update",
                id: id,
                item: {
                  ...existingItem,
                  janCode: item.janCode,
                  qty: 0, // No stock change
                  cost: item.cost, 
                  weight: item.weight,
                  hsCode: existingItem.hsCode ? existingItem.hsCode : item.hsCode,
                  countryOfOrigin: existingItem.countryOfOrigin ? existingItem.countryOfOrigin : item.countryOfOrigin,
                },
              });
          });
      } else {
          // Standard Single Match
          const { id, item: existingItem } = matches[0];
          updates.push({
            type: "update",
            id: id,
            item: {
              ...existingItem,
              janCode: item.janCode,
              qty: item.qty, // Add stock
              cost: item.cost,
              weight: item.weight,
              hsCode: existingItem.hsCode ? existingItem.hsCode : item.hsCode,
              countryOfOrigin: existingItem.countryOfOrigin ? existingItem.countryOfOrigin : item.countryOfOrigin,
            },
          });
      }
      indices.push(index);
    } else if (filter === "NEW" && !exists) {
      // DEBUG: Why is this NEW?
      console.log(`[ImportBatch] Processing NEW for CSV JAN: "${item.janCode}". Matches found: ${matches.length}`);
      
      updates.push({
        type: "new",
        id: item.janCode,
        item: item,
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
    start_session: (
      state,
      action: PayloadAction<{ id: string; name: string }>,
    ) => {
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

    append_raw_rows: (
      state,
      action: PayloadAction<{ rawRows: string[] | string; done: boolean }>,
    ) => {
      const { rawRows, done } = action.payload;
      const text = Array.isArray(rawRows)
        ? rawRows.join("\n")
        : String(rawRows);
      state.rawBody = (state.rawBody || "") + text + "\n";
      reparse(state);

      if (done) state.step = "review";
      else state.step = "importing";
    },

    resolve_conflict: (
      state,
      action: PayloadAction<{ index: number; resolvedActions: any[] }>,
    ) => {
      const { index, resolvedActions } = action.payload;
      state.resolutions[index] = resolvedActions;
    },

    mark_items_done: (state, action: PayloadAction<{ indices: number[] }>) => {
      const { indices } = action.payload;
      indices.forEach((i) => {
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

    import_batch: (
      state,
      action: PayloadAction<{ filter: ImportBatchFilter }>,
    ) => {
      // Trigger action
    },
  },
});

export const {
  start_session,
  set_header,
  append_raw_rows,
  resolve_conflict,
  mark_items_done,
  clear_import,
  finish_import,
  import_batch,
} = orderImportSlice.actions;
export const orderImport = orderImportSlice.reducer;
