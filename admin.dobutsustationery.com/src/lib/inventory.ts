import { createAction, createReducer } from "@reduxjs/toolkit";

export interface Item {
  janCode: string;
  subtype: string;
  description: string;
  hsCode: string;
  image: string;
  qty: number;
  pieces: number;
}
export interface InventoryState {
  idToItem: { [key: string]: Item };
}

export const update_item = createAction<{ id: string; item: Item }>(
  "update_item",
);
export const update_field = createAction<{
  id: string;
  field: keyof Item;
  from: string | number;
  to: string | number;
}>("update_field");

export const initialState: InventoryState = {
  idToItem: {},
};

export const inventory = createReducer(initialState, (r) => {
  r.addCase(update_item, (state, action) => {
    state.idToItem[action.payload.id] = action.payload.item;
  });
  r.addCase(update_field, (state, action) => {
    state.idToItem[action.payload.id][action.payload.field] = action.payload.to;
  });
});
