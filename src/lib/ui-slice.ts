import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export interface UIState {
  columnWidths: Record<string, number>; // key: "view_field" -> width
}

const initialState: UIState = {
  columnWidths: {},
};

const uiSlice = createSlice({
  name: "ui",
  initialState,
  reducers: {
    set_column_width: (state, action: PayloadAction<{ view: string; field: string; width: number }>) => {
      const { view, field, width } = action.payload;
      const key = `${view}_${field}`;
      state.columnWidths[key] = width;
    },
  },
});

export const { set_column_width } = uiSlice.actions;
export const ui = uiSlice.reducer;
