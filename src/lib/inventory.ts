import { createAction, createReducer } from "@reduxjs/toolkit";

// TODO hceck item history for 4542804115635Silver
export interface Item {
  janCode: string;
  subtype: string;
  description: string;
  hsCode: string;
  image: string;
  qty: number;
  pieces: number;
  shipped: number;
  creationDate: string;
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
  idToHistory: { [key: string]: { date: string; desc: string }[] };
  archivedInventoryState: { [key: string]: InventoryState };
  archivedInventoryDate: { [key: string]: string };
  hiddenInventoryState: { [key: string]: InventoryState };
  salesEvents: { [key: string]: OrderInfo };
  orderIdToOrder: { [key: string]: OrderInfo };
  initialized: boolean;
}

export const inventory_synced = createAction("inventory_synced");

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
export const hide_archive = createAction<{
  archiveName: string;
}>("hide_archive");
export const make_sales = createAction<{
  archiveName: string;
  date: Date;
}>("make_sales");

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
  idToHistory: {},
  orderIdToOrder: {},
  archivedInventoryState: {},
  archivedInventoryDate: {},
  hiddenInventoryState: {},
  salesEvents: {},
  initialized: false,
};

export const inventory = createReducer(initialState, (r) => {
  r.addCase(inventory_synced, (state) => {
    state.initialized = true;
  });
  r.addCase(update_item, (state, action) => {
    const id = action.payload.id;
    const timestamp = action.timestamp;
    let creationDate = "Unknown";
    if (timestamp) {
      const tsDate = new Date(timestamp.seconds * 1000);
      creationDate =
        tsDate.toLocaleString("en", {
          year: "numeric",
          month: "short",
          day: "numeric",
        }) + ` (${action.payload.item.qty})`;
    }
    if (!state.idToHistory[id]) {
      state.idToHistory[id] = [];
    }
    const date = creationDate;
    let qty = 0;
    let shipped = 0;
    if (state.idToItem[id] !== undefined) {
      creationDate = state.idToItem[id].creationDate + ", " + creationDate;
      qty = state.idToItem[id].qty;
      shipped = state.idToItem[id].shipped || 0;
    }
    state.idToItem[id] = {
      ...action.payload.item,
      creationDate,
      qty: action.payload.item.qty + qty,
      shipped: (action.payload.item.shipped || 0) + shipped,
    };
    if (state.idToItem[id].shipped === undefined) {
      state.idToItem[id].shipped = 0;
    }
    state.idToHistory[id].push({
      date,
      desc: `${action.payload.item.description}, +${action.payload.item.qty} plus ${qty}; ${state.idToItem[id].shipped} shipped`,
    });
  });

  // Action for importing multiple items at once
  // Used by Order Import flow
  r.addCase(createAction<{
    updates: { id: string; qty: number; }[], 
    newItems: { janCode: string; qty: number; }[],
    timestamp?: any
  }>("batch_update_inventory"), (state, action) => {
      const timestamp = action.payload.timestamp; // Use passed timestamp if available (or generate)
      let dateStr = "Imported";
      if (timestamp) {
         dateStr = new Date(timestamp.seconds * 1000).toLocaleString();
      }

      // 1. Process Updates
      action.payload.updates.forEach(update => {
          if (state.idToItem[update.id]) {
              const oldQty = state.idToItem[update.id].qty;
              state.idToItem[update.id].qty += update.qty;
              
              if (!state.idToHistory[update.id]) state.idToHistory[update.id] = [];
              state.idToHistory[update.id].push({
                  date: dateStr,
                  desc: `Import: Added ${update.qty} (Total: ${state.idToItem[update.id].qty})`
              });
          }
      });

      // 2. Process New Items
      // For new items, we create a basic placeholder using JAN as ID (if no subtype)
      // or we might need to handle them differently. 
      // The design says "Create Draft Item".
      // For now, let's create them as items with minimal info.
      action.payload.newItems.forEach(newItem => {
           const id = newItem.janCode; // Default to JAN as ID for new items
           
           if (!state.idToItem[id]) {
               // Totally new
               state.idToItem[id] = {
                   janCode: newItem.janCode,
                   subtype: "",
                   description: "New Import Item",
                   hsCode: "",
                   image: "",
                   qty: newItem.qty,
                   pieces: 1,
                   shipped: 0,
                   creationDate: dateStr
               };
               state.idToHistory[id] = [{
                   date: dateStr,
                   desc: `Import: Created with ${newItem.qty}`
               }];
           } else {
               // If somehow it exists (race condition?), treat as update
               state.idToItem[id].qty += newItem.qty;
               state.idToHistory[id].push({
                   date: dateStr,
                   desc: `Import: Added ${newItem.qty}`
               });
           }
      });
  });

  r.addCase(update_field, (state, action) => {
    if (state.idToItem[action.payload.id]) {
        state.idToItem[action.payload.id][action.payload.field] = action.payload.to;
        const timestamp = action.timestamp;
        let creationDate = "Unknown";
        if (timestamp) {
          const tsDate = new Date(timestamp.seconds * 1000);
          creationDate = tsDate.toLocaleString("en", {
            year: "numeric",
            month: "short",
            day: "numeric",
          });
        }
        state.idToHistory[action.payload.id].push({
          date: creationDate,
          desc: `${action.payload.field} changed from ${action.payload.from} to ${action.payload.to}`,
        });
        if (action.payload.field === "qty") {
          const q = state.idToItem[action.payload.id][action.payload.field];
          // type mismatch issue TODO
          if (q == 0) {
            // remove item from inventory
            // TODO: don't delete the item, instead verify that it
            // is removed from the display by the shipped vs qty check
            //delete state.idToItem[action.payload.id];
          }
        }
    } else {
        // console.warn(`Skipping update_field for missing item: ${action.payload.id}`);
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
      state.idToHistory[itemKey].push({
        date: state.orderIdToOrder[orderID].date.toLocaleString("en", {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
        desc: `Packaged ${qty} for ${orderID}`,
      });
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
        state.idToHistory[itemKey].push({
          date: state.orderIdToOrder[orderID].date.toLocaleString("en", {
            year: "numeric",
            month: "short",
            day: "numeric",
          }),
          desc: `Existing item quantified ${qty} for ${orderID}`,
        });
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
      state.idToHistory[itemKey].push({
        date: state.orderIdToOrder[orderID].date.toLocaleString("en", {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
        desc: `Quantified ${qty} for ${orderID}`,
      });
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
    state.idToHistory[itemKey].push({
      date: state.orderIdToOrder[orderID].date.toLocaleString("en", {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
      desc: `Retyped from ${itemKey} to ${newItemKey} for ${orderID} (qty: ${state.idToItem[newItemKey].qty})`,
    });
    if (!state.idToHistory[newItemKey]) {
      state.idToHistory[newItemKey] = [];
    }
    state.idToHistory[newItemKey].push({
      date: state.orderIdToOrder[orderID].date.toLocaleString("en", {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
      desc: `Retyped from ${itemKey} to ${newItemKey} for ${orderID} (qty: ${state.idToItem[newItemKey].qty})`,
    });
  });
  r.addCase(rename_subtype, (state, action) => {
    const { itemKey, subtype } = action.payload;
    if (state.idToItem[itemKey] !== undefined) {
      const mergeItemKey = `${state.idToItem[itemKey].janCode}${subtype}`;
      if (itemKey === mergeItemKey) {
        state.idToHistory[itemKey].push({
          date: state.idToItem[itemKey].creationDate,
          desc: `Retype ignored from ${itemKey} to ${mergeItemKey}`,
        });
        return state;
      }
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
      //delete state.idToItem[itemKey];
      state.idToItem[itemKey].shipped = 0;
      state.idToItem[itemKey].qty = 0;
      if (!state.idToHistory[itemKey]) {
        state.idToHistory[itemKey] = [];
      }
      state.idToHistory[itemKey].push({
        date: state.idToItem[itemKey].creationDate,
        desc: `Retyped from ${itemKey} to ${mergeItemKey} (qty: ${state.idToItem[mergeItemKey].qty})`,
      });
      if (!state.idToHistory[mergeItemKey]) {
        state.idToHistory[mergeItemKey] = [];
      }
      state.idToHistory[mergeItemKey].push({
        date: state.idToItem[itemKey].creationDate,
        desc: `Retyped from ${itemKey} to ${mergeItemKey}`,
      });
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
    const archive = (state.archivedInventoryState[archiveName] = { ...state });
    const timestamp = action.timestamp;
    let creationDate = "Unknown";
    if (timestamp) {
      const tsDate = new Date(timestamp.seconds * 1000);
      creationDate = tsDate.toLocaleString("en", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    }
    state.archivedInventoryDate[archiveName] = creationDate;
    // clear the item quantities
    state.idToItem = {};
    for (const itemKey in archive.idToItem) {
      state.idToItem[itemKey] = { ...archive.idToItem[itemKey] };
      const origShipped = state.idToItem[itemKey].shipped;
      state.idToItem[itemKey].shipped = 0;
      const origQty = state.idToItem[itemKey].qty;
      state.idToItem[itemKey].qty = 0;
      if (!state.idToHistory[itemKey]) {
        state.idToHistory[itemKey] = [];
      }
      state.idToHistory[itemKey].push({
        date: creationDate,
        desc: `Archived ${archiveName} (Qty: ${origQty}, Shipped: ${origShipped})`,
      });
    }
  });
  r.addCase(hide_archive, (state, action) => {
    const archiveName = action.payload.archiveName;
    if (state.archivedInventoryState[archiveName] !== undefined) {
      state.hiddenInventoryState[archiveName] =
        state.archivedInventoryState[archiveName];
      delete state.archivedInventoryState[archiveName];
    }
  });
  r.addCase(make_sales, (state, action) => {
    const archiveName = action.payload.archiveName;
    const orderID = archiveName;
    const items: LineItem[] = [];
    for (const itemKey in state.archivedInventoryState[archiveName].idToItem) {
      const preitem =
        state.archivedInventoryState[archiveName].idToItem[itemKey];
      const postitem = state.idToItem[itemKey];
      let preitemq = preitem.qty;
      if (preitem.pieces > 1) {
        preitemq *= preitem.pieces;
      }
      preitemq -= preitem.shipped;
      if (preitem.pieces > 1) {
        preitemq /= preitem.pieces;
      }
      let postitemq = postitem?.qty || 0;
      if (postitem?.pieces > 1) {
        postitemq *= postitem.pieces;
      }
      postitemq -= postitem?.shipped || 0;
      if (postitem?.pieces > 1) {
        postitemq /= postitem.pieces;
      }
      const qty = preitemq - postitemq;
      if (itemKey.startsWith("4542804104370")) {
        console.log("ITEM: ", itemKey);
        console.log("Preitem: ", { ...preitem });
        console.log("Postitem: ", { ...postitem });
      }
      if (qty !== 0) {
        items.push({ itemKey, qty });
      }
    }
    const email = "dobutsustationery@gmail.com";
    const product = archiveName;
    const date = action.payload.date;
    state.salesEvents[archiveName] = {
      id: orderID,
      items,
      email,
      product,
      date,
    };
  });
});
