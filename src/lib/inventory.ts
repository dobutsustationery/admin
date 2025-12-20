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
  timestamp: number;
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
  idToHistory: { [key: string]: { date: string; desc: string; val: number }[] };
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

export const bulk_import_items = createAction<{
  items: Array<{
    type: "new" | "update";
    id: string; // janCode or itemKey
    item: Item; // The full item object or partial update
  }>;
}>("bulk_import_items");

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

// Helper to apply update logic
function applyInventoryUpdate(state: InventoryState, id: string, item: Item, timestamp?: any) {
    if (!id) {
        console.error("[InventoryDebug] applyInventoryUpdate called with missing ID", item);
        return;
    }
    if (!state) {
        console.error("[InventoryDebug] applyInventoryUpdate called with missing state!");
        return;
    }

    let creationDate = "Unknown";
    let globalDate = "Unknown";
    // We assume an action ALWAYS has a timestamp in this architecture.
    // If not, we might crash or have 0, but user insists no legacy data.
    // Defaulting to 0 if missing to make it obvious rather than non-deterministic Date.now()
    let val = 0; 

    if (timestamp) {
      const tsDate = new Date(timestamp.seconds * 1000);
      val = tsDate.getTime();
      globalDate = tsDate.toLocaleString("en", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
      creationDate = globalDate + ` (${item.qty})`;
    }
    
    // Safety check for state shape (idToHistory)
    if (!state.idToHistory) {
        console.error("[InventoryDebug] state.idToHistory is MISSING. Initializing empty object.");
        state.idToHistory = {};
    }

    if (!state.idToHistory[id]) {
      state.idToHistory[id] = [];
    } else if (!Array.isArray(state.idToHistory[id])) {
       console.warn(`[InventoryDebug] state.idToHistory['${id}'] exists but is NOT an array! Type: ${typeof state.idToHistory[id]}. Resetting to [].`);
       state.idToHistory[id] = [];
    }

    const date = creationDate;
    let qty = 0;
    let shipped = 0;
    
    // Safety check for idToItem
    if (!state.idToItem) {
        console.error("[InventoryDebug] state.idToItem is MISSING. Initializing empty object.");
        state.idToItem = {};
    }

    if (state.idToItem[id] !== undefined) {
      creationDate = state.idToItem[id].creationDate + ", " + creationDate;
      qty = state.idToItem[id].qty;
      shipped = state.idToItem[id].shipped || 0;
    }
    state.idToItem[id] = {
      ...item,
      creationDate,
      qty: item.qty + qty,
      shipped: (item.shipped || 0) + shipped,
      timestamp: val,
    };
    if (state.idToItem[id].shipped === undefined) {
      state.idToItem[id].shipped = 0;
    }
    
    // Final check before push
    if (!state.idToHistory[id]) {
        console.error(`[InventoryDebug] CRITICAL: state.idToHistory['${id}'] is undefined immediately before push! This should be impossible.`);
        state.idToHistory[id] = [];
    }

    try {
        state.idToHistory[id].push({
          date: globalDate,
          desc: `${item.description}, +${item.qty} plus ${qty}; ${state.idToItem[id].shipped} shipped`,
          val,
        });
    } catch (e) {
        console.error(`[InventoryDebug] Exception pushing to history for ${id}:`, e);
        console.log(`[InventoryDebug] Dump for ${id}:`, JSON.stringify(state.idToHistory[id]));
    }
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
    applyInventoryUpdate(state, action.payload.id, action.payload.item, (action as any).timestamp);
  });
  r.addCase(update_field, (state, action) => {
    if (state.idToItem[action.payload.id]) {
      (state.idToItem[action.payload.id] as any)[action.payload.field] =
        action.payload.to;
      const timestamp = (action as any).timestamp;
      let creationDate = "Unknown";
      let val = 0;
      if (timestamp) {
        const tsDate = new Date(timestamp.seconds * 1000);
        val = tsDate.getTime();
        creationDate = tsDate.toLocaleString("en", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
      }
      state.idToHistory[action.payload.id].push({
        date: creationDate,
        desc: `${action.payload.field} changed from ${action.payload.from} to ${action.payload.to}`,
        val,
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
      console.warn(
        `Skipping update_field for missing item: ${action.payload.id}`,
      );
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
      let date = new Date(0); // Default to epoch if missing
      let val = 0;
      if ((action as any).timestamp) {
        date = new Date((action as any).timestamp.seconds * 1000);
        val = date.getTime();
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
      if (!state.idToHistory[itemKey]) {
        console.warn(`[InventoryDebug] package_item: idToHistory missing for ${itemKey}. Initializing empty.`);
        state.idToHistory[itemKey] = [];
      }
      state.idToHistory[itemKey].push({
        date: state.orderIdToOrder[orderID].date.toLocaleString("en", {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
        desc: `Packaged ${qty} for ${orderID}`,
        val: state.orderIdToOrder[orderID].date.getTime(), // orderIdToOrder[orderID].date is derived from action TS above
      });
    }
  });
  r.addCase(quantify_item, (state, action) => {
    const { itemKey, qty, orderID } = action.payload;
    if (state.orderIdToOrder[orderID] === undefined) {
      const date = new Date(0);
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
        if (!state.idToHistory[itemKey]) {
            console.warn(`[InventoryDebug] quantify_item: idToHistory missing for ${itemKey}. Initializing empty.`);
            state.idToHistory[itemKey] = [];
        }
        state.idToHistory[itemKey].push({
          date: state.orderIdToOrder[orderID].date.toLocaleString("en", {
            year: "numeric",
            month: "short",
            day: "numeric",
          }),
          desc: `Existing item quantified ${qty} for ${orderID}`,
          val: state.orderIdToOrder[orderID].date.getTime(),
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
      if (!state.idToHistory[itemKey]) {
          console.warn(`[InventoryDebug] quantify_item (shipped update): idToHistory missing for ${itemKey}. Initializing empty.`);
          state.idToHistory[itemKey] = [];
      }
      state.idToHistory[itemKey].push({
        date: state.orderIdToOrder[orderID].date.toLocaleString("en", {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
        desc: `Quantified ${qty} for ${orderID}`,
        val: state.orderIdToOrder[orderID].date.getTime(),
      });
    }
  });
  r.addCase(retype_item, (state, action) => {
    const { itemKey, subtype, orderID, janCode, qty } = action.payload;
    if (state.orderIdToOrder[orderID] === undefined) {
      const date = new Date(0);
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
    if (!state.idToHistory[itemKey]) {
        console.warn(`[InventoryDebug] retype_item (old key): idToHistory missing for ${itemKey}. Initializing empty.`);
        state.idToHistory[itemKey] = [];
    }
    state.idToHistory[itemKey].push({
      date: state.orderIdToOrder[orderID].date.toLocaleString("en", {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
      desc: `Retyped from ${itemKey} to ${newItemKey} for ${orderID} (qty: ${state.idToItem[newItemKey]?.qty || '?'})`,
      val: state.orderIdToOrder[orderID].date.getTime(),
    });
    if (!state.idToHistory[newItemKey]) {
      console.warn(`[InventoryDebug] retype_item (new key): idToHistory missing for ${newItemKey}. Initializing empty.`);
      state.idToHistory[newItemKey] = [];
    }
    state.idToHistory[newItemKey].push({
      date: state.orderIdToOrder[orderID].date.toLocaleString("en", {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
      desc: `Retyped from ${itemKey} to ${newItemKey} for ${orderID} (qty: ${state.idToItem[newItemKey]?.qty || '?'})`,
      val: state.orderIdToOrder[orderID].date.getTime(),
    });
  });
  r.addCase(rename_subtype, (state, action) => {
    const { itemKey, subtype } = action.payload;
    if (state.idToItem[itemKey] !== undefined) {
      const mergeItemKey = `${state.idToItem[itemKey].janCode}${subtype}`;
      if (itemKey === mergeItemKey) {
          
          // Use action's timestamp for the event record.
          // Note: "rename_subtype" action payload doesn't seem to have a timestamp in the interface
          // but Firestore middleware attaches it. We need to grab it.
          const ts = (action as any).timestamp;
          const val = state.idToItem[itemKey].timestamp || (ts ? new Date(ts.seconds * 1000).getTime() : 0);

          state.idToHistory[itemKey].push({
          date: state.idToItem[itemKey].creationDate,
          desc: `Retype ignored from ${itemKey} to ${mergeItemKey}`,
          val, 
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
      
      // Merge history: Copy old history to new key
      const oldHistory = state.idToHistory[itemKey] || [];
      if (!state.idToHistory[mergeItemKey]) {
           state.idToHistory[mergeItemKey] = [];
      }
      
      const prefixedOldHistory = oldHistory.map(h => ({
          ...h,
          desc: `[${itemKey}] ${h.desc}`
      }));
      
      // Combine and sort by date using 'val' timestamp
      const combined = [...state.idToHistory[mergeItemKey], ...prefixedOldHistory];
      combined.sort((a, b) => {
          return (a.val || 0) - (b.val || 0);
      });
      
      // Reassign the sorted history (Redux Toolkit allows mutation or reassignment)
      state.idToHistory[mergeItemKey] = combined;

      //delete state.idToItem[itemKey];
      state.idToItem[itemKey].shipped = 0;
      state.idToItem[itemKey].qty = 0;
      if (!state.idToHistory[itemKey]) {
        console.warn(`[InventoryDebug] rename_subtype (old key): idToHistory missing for ${itemKey}. Initializing empty.`);
        state.idToHistory[itemKey] = [];
      }
      
      const ts = (action as any).timestamp;
      // Use the item's timestamp to match its creationDate string, if available
      const val = state.idToItem[itemKey].timestamp || (ts ? new Date(ts.seconds * 1000).getTime() : 0);
      
      state.idToHistory[itemKey].push({
        date: state.idToItem[itemKey].creationDate,
        desc: `Retyped from ${itemKey} to ${mergeItemKey} (qty: ${state.idToItem[mergeItemKey].qty})`,
        val,
      });
      
      state.idToHistory[mergeItemKey].push({
        date: state.idToItem[itemKey].creationDate,
        desc: `Retyped from ${itemKey} to ${mergeItemKey}`,
        val,
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
    // Prevent circular reference by picking only relevant state
    const archive = (state.archivedInventoryState[archiveName] = {
        idToItem: { ...state.idToItem },
        idToHistory: { ...state.idToHistory },
        orderIdToOrder: { ...state.orderIdToOrder },
        salesEvents: { ...state.salesEvents },
        archivedInventoryDate: { ...state.archivedInventoryDate },
        // Do NOT include archivedInventoryState or hiddenInventoryState to avoid recursion
        archivedInventoryState: {},
        hiddenInventoryState: {},
        initialized: state.initialized
    });
    const timestamp = (action as any).timestamp;
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
        val: timestamp ? new Date(timestamp.seconds * 1000).getTime() : 0,
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
  
  r.addCase(bulk_import_items, (state, action) => {
      const updates = action.payload.items;
      const timestamp = (action as any).timestamp;
      
      updates.forEach(update => {
          applyInventoryUpdate(state, update.id, update.item, timestamp);
      });
  });
});
