import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type {
  StockOrderScanBatchAuditRow,
  StockOrderUnmatchedScanDaySummary,
} from "./order-exceptions";

export interface UIState {
  columnWidths: Record<string, number>; // key: "view_field" -> width
  stockOrderScanBatchAudit?: {
    generatedAt: number;
    rows: StockOrderScanBatchAuditRow[];
    unmatchedScanDays?: StockOrderUnmatchedScanDaySummary[];
  };
}

const initialState: UIState = {
  columnWidths: {},
};

const uiSlice = createSlice({
  name: "ui",
  initialState,
  reducers: {
    set_column_width: (
      state,
      action: PayloadAction<{ view: string; field: string; width: number }>,
    ) => {
      const { view, field, width } = action.payload;
      const key = `${view}_${field}`;
      state.columnWidths[key] = width;
    },
    set_stock_order_scan_batch_audit: (
      state,
      action: PayloadAction<{
        generatedAt: number;
        rows: StockOrderScanBatchAuditRow[];
        unmatchedScanDays?: StockOrderUnmatchedScanDaySummary[];
      }>,
    ) => {
      state.stockOrderScanBatchAudit = action.payload;
    },
  },
});

export const { set_column_width, set_stock_order_scan_batch_audit } =
  uiSlice.actions;
export const ui = uiSlice.reducer;
