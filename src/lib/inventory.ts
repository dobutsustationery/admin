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
  archivedInventoryState: { [key: string]: InventoryState };
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
export const rename_subtype = createAction<{
  itemKey: string;
  subtype: string;
}>("rename_subtype");
export const delete_empty_order = createAction<{
  orderID: string;
}>("delete_empty_order");
export const archive_inventory = createAction<{
  archiveName: string;
}>("archive_inventory");

export function itemsLookIdentical(oldItem: Item, mergeItem: Item) {
  if (mergeItem.description !== oldItem.description) {
    //console.error(
    //`Merge conflict on description ${oldItem.description} vs ${mergeItem.description}`,
    //);
    return false;
  }
  if (mergeItem.hsCode !== oldItem.hsCode) {
    //console.error(
    //`Merge conflict on hsCode ${oldItem.hsCode} vs ${mergeItem.hsCode}`,
    //);
    return false;
  }
  if (mergeItem.image !== oldItem.image) {
    //console.error(
    //`Merge conflict on image ${oldItem.image} vs ${mergeItem.image}`,
    //);
    return false;
  }
  return true;
}

export const initialState: InventoryState = {
  idToItem: {},
  orderIdToOrder: {},
  archivedInventoryState: {},
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
  r.addCase(rename_subtype, (state, action) => {
    const { itemKey, subtype } = action.payload;
    if (state.idToItem[itemKey] !== undefined) {
      const mergeItemKey = `${state.idToItem[itemKey].janCode}${subtype}`;
      if (state.idToItem[mergeItemKey] !== undefined) {
        // make sure there are no merge confligcts on description, hsCode, image
        const mergeItem = state.idToItem[mergeItemKey];
        const oldItem = state.idToItem[itemKey];
        if (!itemsLookIdentical(oldItem, mergeItem)) {
          return state;
        }
        mergeItem.qty += oldItem.qty;
        mergeItem.shipped += oldItem.shipped;
      } else {
        state.idToItem[mergeItemKey] = {
          ...state.idToItem[itemKey],
          subtype,
        };
      }
      // find all orders which refer to the itemKey and point at the new itemKey
      for (const orderID in state.orderIdToOrder) {
        const existingItem = state.orderIdToOrder[orderID].items.filter(
          (i) => i.itemKey === itemKey,
        );
        for (let i = 0; i < existingItem.length; i++) {
          existingItem[i].itemKey = mergeItemKey;
        }
      }
      delete state.idToItem[itemKey];
      return state;
    }
  });
  r.addCase(delete_empty_order, (state, action) => {
    const orderID = action.payload.orderID;
    if (state.orderIdToOrder[orderID] !== undefined) {
      if (state.orderIdToOrder[orderID].items.length === 0) {
        delete state.orderIdToOrder[orderID];
      }
    }
  });
  r.addCase(archive_inventory, (state, action) => {
    const archiveName = action.payload.archiveName;
    state.archivedInventoryState[archiveName] = { ...state };
    // clear the item quantities
    state.idToItem = { ...state.idToItem };
    for (const itemKey in state.idToItem) {
      state.idToItem[itemKey] = { ...state.idToItem[itemKey] };
      state.idToItem[itemKey].shipped = 0;
      state.idToItem[itemKey].qty = 0;
    }
  });
});
