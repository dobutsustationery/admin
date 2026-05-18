// Staging slice for the order-exceptions TSV cost paste (mirrors the
// live-event import flow). The paste is staged here with no inventory
// effect; commit is intercepted in the root reducer.
// See docs/investigations/DESIGN_ORDER_EXCEPTIONS_ROUTE.md §6.3
import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export interface StockOrderCostState {
  byOrder: Record<string, { rawPaste: string }>;
}

const initialState: StockOrderCostState = { byOrder: {} };

const slice = createSlice({
  name: "stockOrderCost",
  initialState,
  reducers: {
    set_stock_order_cost_paste: (
      state,
      action: PayloadAction<{ orderId: string; rawPaste: string }>,
    ) => {
      state.byOrder[action.payload.orderId] = {
        rawPaste: action.payload.rawPaste,
      };
    },
    clear_stock_order_cost_paste: (
      state,
      action: PayloadAction<{ orderId: string }>,
    ) => {
      delete state.byOrder[action.payload.orderId];
    },
    commit_stock_order_costs: (
      _state,
      _action: PayloadAction<{
        orderId: string;
        overrideExisting: boolean;
        approveDiscrepancy: boolean;
      }>,
    ) => {
      // Root reducer derives the inventory effect from the staged paste.
    },
  },
});

export const {
  set_stock_order_cost_paste,
  clear_stock_order_cost_paste,
  commit_stock_order_costs,
} = slice.actions;
export const stockOrderCost = slice.reducer;
