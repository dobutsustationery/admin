import { createAction, createReducer } from "@reduxjs/toolkit";

export interface HistoryItem {
  field: string;
  from: any;
  to: any;
}

export interface HistoryState {
  past: HistoryItem[];
  future: HistoryItem[];
}

const initialState: HistoryState = {
  past: [],
  future: []
};

export const history_add = createAction<HistoryItem>("history/add");
export const history_undo = createAction("history/undo");
export const history_redo = createAction("history/redo");
export const history_clear = createAction("history/clear");

export const history = createReducer(initialState, (builder) => {
  builder
    .addCase(history_add, (state, action) => {
      // If we are adding a new action, future is invalid
      state.future = [];
      state.past.push(action.payload);
    })
    .addCase(history_undo, (state) => {
      if (state.past.length === 0) return;
      const present = state.past.pop();
      if (present) {
        state.future.push(present);
      }
    })
    .addCase(history_redo, (state) => {
      if (state.future.length === 0) return;
      const next = state.future.pop();
      if (next) {
        state.past.push(next);
      }
    })
    .addCase(history_clear, (state) => {
        state.past = [];
        state.future = [];
    });
});
