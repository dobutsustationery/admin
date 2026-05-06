import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import Papa from "papaparse";
import { canonicalizeSubtype, makeInventoryItemKey } from "./sku";

export interface LiveEventImportItem {
  janCode: string;
  subtype: string;
  description: string;
  image?: string;
  hsCode?: string;
  qty?: number;
  pieces?: number;
  shipped?: number;
  systemCount?: number;
  actualOfficeCount?: number;
  taking?: number;
  returned?: number;
  sold: number;
}

export interface LiveEventRawRow {
  raw: string;
  parsed: LiveEventImportItem | null;
  error?: string;
  warnings?: string[];
  approved: boolean;
  processed?: boolean;
}

export interface LiveEventImportState {
  rawPaste: string;
  delimiter: "csv" | "tsv" | "unknown";
  eventName: string;
  step: "idle" | "review";
  rows: LiveEventRawRow[];
}

export interface LiveEventCommitLine {
  index: number;
  itemKey: string;
  qty: number;
}

export interface LiveEventInventoryMatch {
  key: string;
  item: any;
  matchType: "exact" | "jan";
}

export const initialState: LiveEventImportState = {
  rawPaste: "",
  delimiter: "unknown",
  eventName: "",
  step: "idle",
  rows: [],
};

const normalizeHeaderKey = (key: string): string =>
  key
    .normalize("NFKC")
    .replace(/\uFEFF/g, "")
    .toLowerCase()
    .replace(/[\r\n]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const getCells = (row: Record<string, unknown>) =>
  Object.entries(row)
    .filter(([key]) => key !== "__parsed_extra" && key !== "")
    .map(([key, value]) => ({
      key,
      normalizedKey: normalizeHeaderKey(key),
      value: String(value ?? "").trim(),
    }));

const findCell = (
  row: Record<string, unknown>,
  predicates: Array<(normalizedHeader: string) => boolean>,
): string | undefined => {
  for (const cell of getCells(row)) {
    if (predicates.some((predicate) => predicate(cell.normalizedKey))) {
      return cell.value;
    }
  }
  return undefined;
};

const parseOptionalNumber = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const cleaned = value.replace(/,/g, "").replace(/[^0-9.-]/g, "");
  if (!cleaned) return undefined;
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseRequiredNumber = (value: string | undefined): number | undefined => {
  const parsed = parseOptionalNumber(value);
  return parsed === undefined ? undefined : parsed;
};

const findEventName = (headers: string[]): string => {
  for (const header of headers) {
    const cleaned = header
      .normalize("NFKC")
      .replace(/\uFEFF/g, "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const taking = cleaned.match(/^taking\s+to\s+(.+)$/i);
    if (taking?.[1]) return taking[1].trim();
  }
  for (const header of headers) {
    const cleaned = header
      .normalize("NFKC")
      .replace(/\uFEFF/g, "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const returned = cleaned.match(/^returned\s+from\s+(.+)$/i);
    if (returned?.[1]) return returned[1].trim();
  }
  return "";
};

const isEmptyParsedRow = (row: Record<string, unknown>): boolean =>
  getCells(row).every((cell) => cell.value === "");

const mapLiveEventItem = (
  row: Record<string, unknown>,
): {
  item: LiveEventImportItem | null;
  error?: string;
  warnings?: string[];
} => {
  if (isEmptyParsedRow(row)) return { item: null };

  const janCode = (
    findCell(row, [
      (h) => h === "jancode",
      (h) => h === "jan code",
      (h) => h === "jan",
      (h) => h === "sku",
      (h) => h === "variant sku",
    ]) || ""
  )
    .trim()
    .replace(/\s+/g, "");
  const subtype = (
    findCell(row, [
      (h) => h === "subtype",
      (h) => h === "variant",
      (h) => h === "option1 value",
      (h) => h === "option value",
    ]) || ""
  ).trim();
  const description = (
    findCell(row, [
      (h) => h === "description",
      (h) => h === "title",
      (h) => h === "product name",
      (h) => h === "item name",
      (h) => h === "product",
    ]) || ""
  ).trim();
  const taking = parseOptionalNumber(
    findCell(row, [(h) => h.startsWith("taking to ")]),
  );
  const returned = parseOptionalNumber(
    findCell(row, [(h) => h.startsWith("returned from ")]),
  );
  const explicitSold = parseRequiredNumber(
    findCell(row, [
      (h) => h === "sold",
      (h) => h === "qty sold",
      (h) => h === "quantity sold",
      (h) => h === "sales",
    ]),
  );
  const derivedSold =
    taking !== undefined && returned !== undefined
      ? taking - returned
      : undefined;
  const sold = explicitSold ?? derivedSold;
  const warnings: string[] = [];

  if (
    explicitSold !== undefined &&
    derivedSold !== undefined &&
    explicitSold !== derivedSold
  ) {
    warnings.push(
      `Sold (${explicitSold}) does not match taking minus returned (${derivedSold}).`,
    );
  }

  let error: string | undefined;
  if (!janCode) {
    error = "Missing JAN code";
  } else if (sold === undefined) {
    error = "Missing sold quantity";
  } else if (!Number.isInteger(sold)) {
    error = "Sold quantity must be a whole number";
  } else if (sold < 0) {
    error = "Sold quantity cannot be negative";
  }

  const item: LiveEventImportItem | null =
    sold === undefined
      ? null
      : {
          janCode,
          subtype,
          description,
          image: findCell(row, [
            (h) => h === "image",
            (h) => h === "image src",
          ]),
          hsCode: findCell(row, [
            (h) => h === "hscode",
            (h) => h === "hs code",
          ]),
          qty: parseOptionalNumber(findCell(row, [(h) => h === "qty"])),
          pieces: parseOptionalNumber(findCell(row, [(h) => h === "pieces"])),
          shipped: parseOptionalNumber(findCell(row, [(h) => h === "shipped"])),
          systemCount: parseOptionalNumber(
            findCell(row, [
              (h) => h === "inventory count per system",
              (h) => h === "system count",
            ]),
          ),
          actualOfficeCount: parseOptionalNumber(
            findCell(row, [
              (h) => h === "actual inventory count in office",
              (h) => h === "actual office count",
            ]),
          ),
          taking,
          returned,
          sold,
        };

  return { item, error, warnings };
};

export const parseLiveEventPaste = (
  rawPaste: string,
): Pick<LiveEventImportState, "delimiter" | "eventName" | "rows"> => {
  const trimmed = rawPaste.trim();
  const delimiter = trimmed.includes("\t")
    ? "tsv"
    : trimmed
      ? "csv"
      : "unknown";
  if (!trimmed) {
    return { delimiter: "unknown", eventName: "", rows: [] };
  }

  const result = Papa.parse<Record<string, unknown>>(trimmed, {
    header: true,
    skipEmptyLines: "greedy",
    delimiter: delimiter === "tsv" ? "\t" : "",
  });
  const headers = result.meta.fields || [];
  const eventName = findEventName(headers);
  const sourceLines = trimmed.split(/\r?\n/).slice(1);
  const rows: LiveEventRawRow[] = [];

  result.data.forEach((row, index) => {
    const mapped = mapLiveEventItem(row);
    if (!mapped.item && !mapped.error) return;

    rows.push({
      raw: sourceLines[index] || "",
      parsed: mapped.item,
      error: mapped.error,
      warnings: mapped.warnings,
      approved: !mapped.error,
    });
  });

  return { delimiter, eventName, rows };
};

export const findLiveEventInventoryMatch = (
  item: LiveEventImportItem,
  inventoryIdToItem: Record<string, any>,
): LiveEventInventoryMatch | null => {
  const exactKey = makeInventoryItemKey(item.janCode, item.subtype);
  const exact = inventoryIdToItem[exactKey];
  if (exact) return { key: exactKey, item: exact, matchType: "exact" };

  const incomingSubtypeCanon = canonicalizeSubtype(item.subtype);

  const janMatches = Object.entries(inventoryIdToItem)
    .filter(([, inventoryItem]: [string, any]) => {
      return (
        String(inventoryItem?.janCode || "").trim() === item.janCode &&
        canonicalizeSubtype(inventoryItem?.subtype) === incomingSubtypeCanon
      );
    })
    .map(([key, inventoryItem]) => ({ key, item: inventoryItem }));

  if (janMatches.length === 1) {
    return { ...janMatches[0], matchType: "jan" };
  }

  return null;
};

export const computeLiveEventImportCommit = (
  state: LiveEventImportState,
  inventoryIdToItem: Record<string, any>,
): { lines: LiveEventCommitLine[]; indices: number[] } => {
  const lines: LiveEventCommitLine[] = [];
  const indices: number[] = [];

  state.rows.forEach((row, index) => {
    if (row.processed || !row.approved || row.error || !row.parsed) return;
    const sold = Number(row.parsed.sold || 0);
    if (!Number.isInteger(sold) || sold < 0) return;

    const match = findLiveEventInventoryMatch(row.parsed, inventoryIdToItem);
    if (!match) return;

    if (sold > 0) {
      lines.push({ index, itemKey: match.key, qty: sold });
    }
    indices.push(index);
  });

  return { lines, indices };
};

const liveEventImportSlice = createSlice({
  name: "liveEventImport",
  initialState,
  reducers: {
    set_paste: (state, action: PayloadAction<{ rawPaste: string }>) => {
      const parsed = parseLiveEventPaste(action.payload.rawPaste);
      state.rawPaste = action.payload.rawPaste;
      state.delimiter = parsed.delimiter;
      state.eventName = parsed.eventName;
      state.rows = parsed.rows;
      state.step = parsed.rows.length > 0 ? "review" : "idle";
    },
    toggle_row_approval: (
      state,
      action: PayloadAction<{ index: number; approved?: boolean }>,
    ) => {
      const row = state.rows[action.payload.index];
      if (!row || row.error || row.processed) return;
      row.approved = action.payload.approved ?? !row.approved;
    },
    set_all_approvals: (
      state,
      action: PayloadAction<{ approved: boolean }>,
    ) => {
      state.rows.forEach((row) => {
        if (!row.error && !row.processed) {
          row.approved = action.payload.approved;
        }
      });
    },
    mark_rows_done: (state, action: PayloadAction<{ indices: number[] }>) => {
      action.payload.indices.forEach((index) => {
        if (state.rows[index]) {
          state.rows[index].processed = true;
          state.rows[index].approved = false;
        }
      });
    },
    clear_import: (state) => {
      state.rawPaste = "";
      state.delimiter = "unknown";
      state.eventName = "";
      state.step = "idle";
      state.rows = [];
    },
    commit_import: (state) => {
      // Root reducer derives inventory/order effects from the pasted fact.
    },
  },
});

export const {
  set_paste,
  toggle_row_approval,
  set_all_approvals,
  mark_rows_done,
  clear_import,
  commit_import,
} = liveEventImportSlice.actions;
export const liveEventImport = liveEventImportSlice.reducer;
