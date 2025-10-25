import { createAction, createReducer } from "@reduxjs/toolkit";

export interface Item {
  janCode: string;
  subtype: string;
  description: string;
  hsCode: string;
  image: string;
  qty: number;
  pieces: number;
  shipped: number;
}
export interface LineItem {
  itemKey: string;
  qty: number;
}
export interface OrderInfo {
  date: Date;
  email?: string;
  product?: string;
  id: string;
  items: LineItem[];
}
export interface InventoryState {
  idToItem: { [key: string]: Item };
  orderIdToOrder: { [key: string]: OrderInfo };
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
export const new_order = createAction<{
  orderID: string;
  date: Date;
  email: string;
  product: string;
}>("new_order");
export const package_item = createAction<{
  orderID: string;
  itemKey: string;
  qty: number;
}>("package_item");
export const quantify_item = createAction<{
  orderID: string;
  itemKey: string;
  qty: number;
}>("quantify_item");
export const retype_item = createAction<{
  orderID: string;
  itemKey: string;
  janCode: string;
  subtype: string;
  qty: number;
}>("retype_item");

export const initialState: InventoryState = {
  idToItem: {},
  orderIdToOrder: {},
};

export const inventory = createReducer(initialState, (r) => {
  r.addCase(update_item, (state, action) => {
    const id = action.payload.id;
    state.idToItem[id] = { ...action.payload.item };
    if (state.idToItem[id].shipped === undefined) {
      state.idToItem[id].shipped = 0;
    }
  });
  r.addCase(update_field, (state, action) => {
    state.idToItem[action.payload.id][action.payload.field] = action.payload.to;
    if (action.payload.field === "qty") {
      const q = state.idToItem[action.payload.id][action.payload.field];
      // type mismatch issue TODO
      if (q == 0) {
        // remove item from inventory
        // TODO: don't delete the item, instead verify that it
        // is removed from the display by the shipped vs qty check
        delete state.idToItem[action.payload.id];
      }
    }
  });
  r.addCase(new_order, (state, action) => {
    const orderID = action.payload.orderID;
    const email = action.payload.email;
    const date = action.payload.date;
    const product = action.payload.product;
    let items: LineItem[] = [];
    if (state.orderIdToOrder[orderID]) {
      items = [...state.orderIdToOrder[orderID].items];
    }
    state.orderIdToOrder[orderID] = {
      id: orderID,
      items,
      email,
      product,
      date,
    };
  });
  r.addCase(package_item, (state, action) => {
    const { itemKey, qty, orderID } = action.payload;
    if (state.orderIdToOrder[orderID] === undefined) {
      let date = new Date();
      if (action.timestamp) {
        date = new Date(action.timestamp.seconds * 1000);
      }
      state.orderIdToOrder[orderID] = { id: orderID, items: [], date };
    }
    const existingItem = state.orderIdToOrder[orderID].items.filter(
      (i) => i.itemKey === itemKey,
    );
    if (existingItem.length > 0) {
      existingItem[0].qty += qty;
      //console.log(`Package existing item ${existingItem[0].itemKey} to ${existingItem[0].qty} (of ${existingItem.length} items) for ${orderID}`)
    } else {
      state.orderIdToOrder[orderID].items.push({ itemKey, qty });
      //console.log(`Create item ${itemKey} to ${qty} for order ${orderID}`)
    }
    if (state.idToItem[itemKey] !== undefined) {
      state.idToItem[itemKey].shipped += qty;
    }
  });
  r.addCase(quantify_item, (state, action) => {
    const { itemKey, qty, orderID } = action.payload;
    if (state.orderIdToOrder[orderID] === undefined) {
      const date = new Date();
      state.orderIdToOrder[orderID] = { id: orderID, items: [], date };
    }
    const existingItem = state.orderIdToOrder[orderID].items.filter(
      (i) => i.itemKey === itemKey,
    );
    let priorQty = 0;
    if (existingItem.length > 0) {
      priorQty = existingItem[0].qty;
      if (qty > 0) {
        existingItem[0].qty = qty;
      } else {
        state.orderIdToOrder[orderID].items = state.orderIdToOrder[
          orderID
        ].items.filter((i) => i.itemKey !== itemKey);
      }
    } else {
      state.orderIdToOrder[orderID].items.push({ itemKey, qty });
    }
    if (state.idToItem[itemKey] !== undefined) {
      state.idToItem[itemKey].shipped += qty - priorQty;
    }
  });
  r.addCase(retype_item, (state, action) => {
    const { itemKey, subtype, orderID, janCode, qty } = action.payload;
    if (state.orderIdToOrder[orderID] === undefined) {
      const date = new Date();
      state.orderIdToOrder[orderID] = { id: orderID, items: [], date };
    }
    const newItemKey = `${janCode}${subtype}`;
    if (newItemKey !== itemKey) {
      state.orderIdToOrder[orderID].items = state.orderIdToOrder[
        orderID
      ].items.filter((i) => i.itemKey !== itemKey);
      const existingItem = state.orderIdToOrder[orderID].items.filter(
        (i) => i.itemKey === newItemKey,
      );
      if (existingItem.length > 0) {
        existingItem[0].qty += qty;
      } else {
        state.orderIdToOrder[orderID].items.push({ itemKey: newItemKey, qty });
      }
    } else {
      console.error(`${itemKey} vs ${newItemKey}`);
    }
    if (
      state.idToItem[itemKey] !== undefined &&
      state.idToItem[newItemKey] !== undefined
    ) {
      state.idToItem[itemKey].shipped -= qty;
      state.idToItem[newItemKey].shipped += qty;
    }
  });
});
