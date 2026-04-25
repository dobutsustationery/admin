import { createAction, createReducer } from "@reduxjs/toolkit";
import { formatYen } from "./formatters";
import {
  type InventoryItemKey,
  canonicalizeInventoryItemKey,
  canonicalizeSubtype,
  makeInventoryItemKey,
} from "./sku";

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
  price?: number;
  cost?: number;
  weight?: number; // in grams

  // Shopify specific
  handle?: string;
  // bodyHtml removed for Listings slice migration
  countryOfOrigin?: string;
  imagePosition?: number;
}
export interface LineItem {
  itemKey: InventoryItemKey;
  qty: number;
}
export interface ShopifyLineFact {
  itemKey: InventoryItemKey;
  placed: number;
  cancelled: number;
  refunded: number;
}
export interface OrderInfo {
  date: Date;
  email?: string;
  product?: string;
  id: string;
  items: LineItem[];
  shopifyFacts?: {
    lines: Record<string, ShopifyLineFact>; // lineItemID -> counts
    refunds: Record<string, boolean>; // refundID -> processed
    reconciledTimestamp?: number;
  };
}
export interface InventoryState {
  idToItem: { [key: string]: Item };
  idToHistory: { [key: string]: { date: string; desc: string; val: number }[] };
  archivedInventoryState: { [key: string]: InventoryState };
  archivedInventoryDate: { [key: string]: string };
  hiddenInventoryState: { [key: string]: InventoryState };
  salesEvents: { [key: string]: OrderInfo };
  orderIdToOrder: { [key: string]: OrderInfo };
  shopifyUrlToDriveUrl: { [key: string]: string }; // [shopifyUrl] -> driveUrl
  hiddenExceptions?: { [key: string]: boolean };
  shopifyExceptions?: { [key: string]: string[] };
  initialized: boolean;
}

export const inventory_synced = createAction("inventory_synced");

export const hide_exception = createAction<{
  itemKey: InventoryItemKey;
}>("hide_exception");
export const show_exception = createAction<{
  itemKey: InventoryItemKey;
}>("show_exception");

export const hide_shopify_exception = createAction<{
  orderID: string;
}>("hide_shopify_exception");
export const clear_shopify_exceptions = createAction(
  "clear_shopify_exceptions",
);

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
  itemKey: InventoryItemKey;
  qty: number;
}>("package_item");
export const quantify_item = createAction<{
  orderID: string;
  itemKey: InventoryItemKey;
  qty: number;
}>("quantify_item");
export const retype_item = createAction<{
  orderID: string;
  itemKey: InventoryItemKey;
  janCode: string;
  subtype: string;
  qty: number;
}>("retype_item");
export const rename_subtype = createAction<{
  itemKey: InventoryItemKey;
  subtype: string;
}>("rename_subtype");
export const fix_jancode = createAction<{
  itemKey: InventoryItemKey;
  newJanCode: string;
  subtype?: string;
  mergeMode?: "strict" | "merge_if_identical";
  reason?: string;
}>("fix_jancode");
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
export interface BulkImportItem {
  type: "new" | "update";
  id: InventoryItemKey | string; // janCode or itemKey
  item: Item; // The full item object or partial update
}

export const bulk_import_items = createAction<{
  items: Array<BulkImportItem>;
}>("bulk_import_items");

export const shopify_order_created = createAction<{
  raw: any;
  topic: string;
}>("shopify_order_created");

export const shopify_order_updated = createAction<{
  raw: any;
  topic: string;
}>("shopify_order_updated");

export const shopify_order_cancelled = createAction<{
  raw: any;
  topic: string;
}>("shopify_order_cancelled");

export const shopify_refund_created = createAction<{
  raw: any;
  topic: string;
}>("shopify_refund_created");

export const shopify_order_reconciled = createAction<{
  raw: any;
  topic: string;
}>("shopify_order_reconciled");

export const shopify_unrecognized_topic = createAction<{
  raw: any;
  topic: string;
}>("shopify_unrecognized_topic");

function getTimestampMs(timestamp: any): number {
  if (typeof timestamp === "number") return timestamp;
  if (typeof timestamp?.seconds === "number") {
    const nanos = Number(timestamp?.nanoseconds || 0);
    return timestamp.seconds * 1000 + Math.floor(nanos / 1_000_000);
  }
  if (typeof timestamp?._seconds === "number") {
    const nanos = Number(timestamp?._nanoseconds || 0);
    return timestamp._seconds * 1000 + Math.floor(nanos / 1_000_000);
  }
  if (timestamp instanceof Date) return timestamp.getTime();
  if (typeof timestamp?.toDate === "function")
    return timestamp.toDate().getTime();
  return 0;
}

export const split_inventory_item = createAction<{
  sourceId: InventoryItemKey;
  splits: { newId: InventoryItemKey; qty: number; subtype: string }[];
}>("split_inventory_item");

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
  /*
  if (mergeItem.image !== oldItem.image) {
    //console.error(
    //`Merge conflict on image ${oldItem.image} vs ${mergeItem.image}`,
    //);
    return false;
  }
  */
  return true;
}

// Helper to apply update logic
function applyInventoryUpdate(
  state: InventoryState,
  id: string,
  item: Partial<Item>,
  timestamp: any,
) {
  if (!id) {
    console.error(
      "[InventoryDebug] applyInventoryUpdate called with missing ID",
    );
    return;
  }
  if (!state) {
    console.error(
      "[InventoryDebug] applyInventoryUpdate called with missing state!",
    );
    return;
  }

  id = id.trim();

  // Validation: check if the provided ID matches the canonical ID
  // derived from its janCode + subtype. If not, log an error.
  if (item.janCode) {
    const canonicalId = makeInventoryItemKey(item.janCode, item.subtype || "");
    if (
      id !== canonicalId &&
      canonicalizeInventoryItemKey(id) === canonicalId
    ) {
      id = canonicalId;
    }
    if (id !== canonicalId) {
      console.error(
        `[InventoryValidation] Item update ID mismatch! Passed ID: "${id}", Expected Canonical ID: "${canonicalId}" (JAN: "${item.janCode}", Subtype: "${item.subtype || ""}")`,
      );
    }
  }

  // Robust Timestamp Parsing
  const val = getTimestampMs(timestamp);

  const dateObj = new Date(val);
  const globalDate = dateObj.toLocaleString("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  // Safety check for state shape (idToHistory)
  if (!state.idToHistory) {
    console.error(
      "[InventoryDebug] state.idToHistory is MISSING. Initializing empty object.",
    );
    state.idToHistory = {};
  }

  if (!state.idToHistory[id]) {
    state.idToHistory[id] = [];
  } else if (!Array.isArray(state.idToHistory[id])) {
    console.warn(
      `[InventoryDebug] state.idToHistory['${id}'] exists but is NOT an array! Type: ${typeof state.idToHistory[id]}. Resetting to [].`,
    );
    state.idToHistory[id] = [];
  }

  // Safety check for idToItem
  if (!state.idToItem) {
    console.error(
      "[InventoryDebug] state.idToItem is MISSING. Initializing empty object.",
    );
    state.idToItem = {};
  }

  const existingItem = state.idToItem[id];
  const historyEntries: { date: string; desc: string; val: number }[] = [];

  // 1. Detect Changes
  if (existingItem) {
    // Compare fields
    if (item.cost !== undefined && item.cost !== existingItem.cost) {
      historyEntries.push({
        date: globalDate,
        desc: `Cost updated: ${formatYen(existingItem.cost)} -> ${formatYen(item.cost)}`,
        val,
      });
    }
    if (item.qty !== undefined && item.qty !== 0) {
      // Qty is usually a delta in bulk import (e.g. +50)
      // But wait, update_item usually takes a FULL ITEM or DELTA?
      // In computeOrderImportBatch, we passed: qty: item.qty (Delta)
      // The applyInventoryUpdate logic below does: qty = Number(item.qty) + qty (existing)
      // So item.qty IS a delta here.
      historyEntries.push({
        date: globalDate,
        desc: `Quantity adjustment: ${item.qty > 0 ? "+" : ""}${item.qty} (New Total: ${existingItem.qty + item.qty})`,
        val,
      });
    }
    if (item.hsCode && item.hsCode !== existingItem.hsCode) {
      historyEntries.push({
        date: globalDate,
        desc: `HS Code changed: ${existingItem.hsCode} -> ${item.hsCode}`,
        val,
      });
    }
    if (item.weight && item.weight !== existingItem.weight) {
      historyEntries.push({
        date: globalDate,
        desc: `Weight changed: ${existingItem.weight}g -> ${item.weight}g`,
        val,
      });
    }
    if (
      item.countryOfOrigin &&
      item.countryOfOrigin !== existingItem.countryOfOrigin
    ) {
      historyEntries.push({
        date: globalDate,
        desc: `Origin changed: ${existingItem.countryOfOrigin} -> ${item.countryOfOrigin}`,
        val,
      });
    }
    if (item.description && item.description !== existingItem.description) {
      // Description often changes slightly, log only if significant?
      // For now log it.
      historyEntries.push({
        date: globalDate,
        desc: `Description updated`,
        val,
      });
    }

    // Implicitly track migration: Shopify -> Drive
    const oldImage = existingItem.image;
    const newImage = item.image;
    if (oldImage && newImage && oldImage !== newImage) {
      historyEntries.push({
        date: globalDate,
        desc: `Image updated`,
        val,
      });
      if (
        oldImage.includes("cdn.shopify.com") &&
        newImage.includes("drive.google.com")
      ) {
        if (!state.shopifyUrlToDriveUrl) state.shopifyUrlToDriveUrl = {};
        state.shopifyUrlToDriveUrl[oldImage] = newImage;
      }
    }
  } else {
    // New Item
    historyEntries.push({
      date: globalDate,
      desc: `Created Item: ${item.description} (Qty: ${item.qty})`,
      val,
    });
  }

  // 2. Apply State Updates
  const currentQty = existingItem ? existingItem.qty : 0;
  const currentShipped = existingItem ? existingItem.shipped || 0 : 0;
  const currentCreationDate = existingItem
    ? existingItem.creationDate
    : globalDate + ` (${item.qty})`;

  const {
    bodyHtml,
    productCategory,
    listingImage,
    imageAltText,
    option1Value,
    ...inventoryItem
  } = item as any;

  state.idToItem[id] = {
    ...state.idToItem[id], // Preserve existing fields (e.g. price, handle)
    ...inventoryItem,
    janCode: item.janCode?.trim(),
    subtype: canonicalizeSubtype(item.subtype),
    hsCode: item.hsCode
      ? String(item.hsCode).replace(/\s+/g, "")
      : state.idToItem[id]?.hsCode || "",
    cost:
      item.cost !== undefined ? Number(item.cost) : state.idToItem[id]?.cost,
    creationDate: currentCreationDate,
    qty: Number(item.qty) + currentQty, // Apply Delta
    shipped: (Number(item.shipped) || 0) + currentShipped,
    timestamp: val,
  };

  if (state.idToItem[id].shipped === undefined) {
    state.idToItem[id].shipped = 0;
  }

  // 3. Push History
  // Final check before push
  if (!state.idToHistory[id]) {
    state.idToHistory[id] = [];
  }

  try {
    historyEntries.forEach((entry) => {
      state.idToHistory[id].push(entry);
    });
    // Fallback: If no changes detected but function called?
    // (e.g. identical update). No history needed.
  } catch (e) {
    console.error(
      `[InventoryDebug] Exception pushing to history for ${id}:`,
      e,
    );
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
  shopifyUrlToDriveUrl: {},
  shopifyExceptions: {},
  initialized: false,
};

function syncOrderItemsFromFacts(order: OrderInfo) {
  if (!order.shopifyFacts) return;
  const itemKeyToQty: Record<string, number> = {};
  for (const lineItemID in order.shopifyFacts.lines) {
    const fact = order.shopifyFacts.lines[lineItemID];
    const currentQty = fact.placed - fact.cancelled - fact.refunded;
    if (currentQty > 0) {
      itemKeyToQty[fact.itemKey] =
        (itemKeyToQty[fact.itemKey] || 0) + currentQty;
    }
  }
  order.items = Object.entries(itemKeyToQty).map(([itemKey, qty]) => ({
    itemKey: itemKey as InventoryItemKey,
    qty,
  }));
}

function mapSkuToItemKey(
  sku: string | undefined | null,
  lineItem: any,
): InventoryItemKey | null {
  let normalizedSku = String(sku || "").trim();
  if (normalizedSku && /^\d+/.test(normalizedSku)) {
    return normalizedSku as InventoryItemKey;
  }

  // Fallback: search in properties
  const properties = lineItem.properties || [];
  const janProp = properties.find(
    (p: any) => /jan/i.test(p.name) || /barcode/i.test(p.name),
  );
  if (janProp && janProp.value) {
    const jan = String(janProp.value).trim().replace(/\s+/g, "");
    let variantTitle = String(lineItem.variant_title || "").trim();
    if (variantTitle === "Default Title") variantTitle = "";
    return (jan + variantTitle) as InventoryItemKey;
  }

  return (normalizedSku as InventoryItemKey) || null;
}

function getOrCreateOrder(
  state: InventoryState,
  orderID: string,
  rawOrder: any,
  actionTimestamp: number,
): OrderInfo {
  if (!state.orderIdToOrder[orderID]) {
    state.orderIdToOrder[orderID] = {
      id: orderID,
      date: new Date(rawOrder.created_at || actionTimestamp),
      email: rawOrder.email || rawOrder.contact_email || "",
      items: [],
      shopifyFacts: { lines: {}, refunds: {} },
    };
  }
  const order = state.orderIdToOrder[orderID];
  if (!order.shopifyFacts) {
    order.shopifyFacts = { lines: {}, refunds: {} };
  }
  return order;
}

export const inventory = createReducer(initialState, (r) => {
  r.addCase(inventory_synced, (state) => {
    state.initialized = true;
  });

  r.addCase(shopify_order_created, (state, action) => {
    const rawOrder = action.payload.raw;
    const orderID = `shopify:${rawOrder.id}`;

    if (state.shopifyExceptions) {
      delete state.shopifyExceptions[orderID];
    }

    const actionTimestamp = getTimestampMs((action as any).timestamp);
    const order = getOrCreateOrder(state, orderID, rawOrder, actionTimestamp);

    const isReconciledLater =
      order.shopifyFacts!.reconciledTimestamp &&
      order.shopifyFacts!.reconciledTimestamp > actionTimestamp;

    const lineItems = rawOrder.line_items || [];
    for (const li of lineItems) {
      const itemKey = mapSkuToItemKey(li.sku, li);
      if (!itemKey) {
        if (!state.shopifyExceptions) state.shopifyExceptions = {};
        if (!state.shopifyExceptions[orderID])
          state.shopifyExceptions[orderID] = [];
        state.shopifyExceptions[orderID].push(
          `Unknown SKU: ${li.sku} (Line Item: ${li.id})`,
        );
        continue;
      }
      const canonicalKey = canonicalizeInventoryItemKey(itemKey);
      const qty = li.quantity;
      const lineItemID = String(li.id);

      if (!order.shopifyFacts!.lines[lineItemID]) {
        order.shopifyFacts!.lines[lineItemID] = {
          itemKey: canonicalKey,
          placed: 0,
          cancelled: 0,
          refunded: 0,
        };
      }
      const fact = order.shopifyFacts!.lines[lineItemID];
      const delta = qty - fact.placed;
      if (delta > 0) {
        fact.placed = qty;
        if (!isReconciledLater && state.idToItem[canonicalKey]) {
          state.idToItem[canonicalKey].shipped += delta;
          const historyVal = actionTimestamp;
          if (!state.idToHistory[canonicalKey])
            state.idToHistory[canonicalKey] = [];
          state.idToHistory[canonicalKey].push({
            date: new Date(historyVal).toLocaleString("en", {
              year: "numeric",
              month: "short",
              day: "numeric",
            }),
            desc: `Shopify Order Created: ${qty} for ${orderID}`,
            val: historyVal,
          });
        }
      }
    }
    if (!isReconciledLater) {
      syncOrderItemsFromFacts(order);
    }
  });

  r.addCase(shopify_order_cancelled, (state, action) => {
    applyOrderReconciliation(
      state,
      action.payload.raw,
      getTimestampMs((action as any).timestamp),
    );
  });

  r.addCase(shopify_refund_created, (state, action) => {
    const rawRefund = action.payload.raw;
    const orderID = `shopify:${rawRefund.order_id}`;
    const actionTimestamp = getTimestampMs((action as any).timestamp);
    const order = state.orderIdToOrder[orderID];
    if (!order || !order.shopifyFacts) {
      if (!state.shopifyExceptions) state.shopifyExceptions = {};
      if (!state.shopifyExceptions[orderID])
        state.shopifyExceptions[orderID] = [];
      state.shopifyExceptions[orderID].push(
        `Refund event for unknown order: ${orderID}`,
      );
      return;
    }

    const refundID = String(rawRefund.id);
    if (order.shopifyFacts.refunds[refundID]) return; // Already processed

    const isReconciledLater =
      order.shopifyFacts.reconciledTimestamp &&
      order.shopifyFacts.reconciledTimestamp > actionTimestamp;

    const refundLines = rawRefund.refund_line_items || [];
    for (const rli of refundLines) {
      const lineItemID = String(rli.line_item_id);
      const qty = rli.quantity;
      const fact = order.shopifyFacts.lines[lineItemID];
      if (!fact) continue;

      const canonicalKey = canonicalizeInventoryItemKey(fact.itemKey);
      const currentNet = fact.placed - fact.cancelled - fact.refunded;
      const amountToSubtract = Math.max(0, Math.min(qty, currentNet));

      fact.refunded += qty;
      if (
        !isReconciledLater &&
        state.idToItem[canonicalKey] &&
        amountToSubtract > 0
      ) {
        state.idToItem[canonicalKey].shipped -= amountToSubtract;
        const historyVal = actionTimestamp;
        if (!state.idToHistory[canonicalKey])
          state.idToHistory[canonicalKey] = [];
        state.idToHistory[canonicalKey].push({
          date: new Date(historyVal).toLocaleString("en", {
            year: "numeric",
            month: "short",
            day: "numeric",
          }),
          desc: `Shopify Order Refunded: ${qty} (impact -${amountToSubtract}) for ${orderID} (Refund: ${refundID})`,
          val: historyVal,
        });
      }
    }
    order.shopifyFacts.refunds[refundID] = true;
    if (!isReconciledLater) {
      syncOrderItemsFromFacts(order);
    }
  });

  function applyOrderReconciliation(
    state: InventoryState,
    rawOrder: any,
    actionTimestamp: number,
  ) {
    const orderID = `shopify:${rawOrder.id}`;

    if (state.shopifyExceptions) {
      delete state.shopifyExceptions[orderID];
    }

    const order = getOrCreateOrder(state, orderID, rawOrder, actionTimestamp);

    const timestamp = Date.parse(rawOrder.updated_at || rawOrder.created_at);

    if (
      order.shopifyFacts!.reconciledTimestamp &&
      order.shopifyFacts!.reconciledTimestamp >= timestamp
    ) {
      return;
    }

    const currentInventoryImpact: Record<string, number> = {};
    for (const item of order.items) {
      const itemKey = canonicalizeInventoryItemKey(item.itemKey);
      currentInventoryImpact[itemKey] =
        (currentInventoryImpact[itemKey] || 0) + item.qty;
    }

    const itemQtyMap: Record<string, number> = {};
    const lineItems = rawOrder.line_items || [];
    for (const li of lineItems) {
      const key = mapSkuToItemKey(li.sku, li);
      if (key) {
        const canonicalKey = canonicalizeInventoryItemKey(key);
        const currentQty = rawOrder.cancelled_at
          ? 0
          : li.quantity - (li.refund_quantity || 0);
        itemQtyMap[canonicalKey] = (itemQtyMap[canonicalKey] || 0) + currentQty;

        // Also update shopifyFacts so incremental actions work correctly
        if (!order.shopifyFacts!.lines[li.id]) {
          order.shopifyFacts!.lines[li.id] = {
            itemKey: canonicalKey,
            placed: li.quantity,
            cancelled: rawOrder.cancelled_at ? li.quantity : 0,
            refunded: li.refund_quantity || 0,
          };
        } else {
          const fact = order.shopifyFacts!.lines[li.id];
          fact.placed = Math.max(fact.placed, li.quantity);
          if (rawOrder.cancelled_at) {
            fact.cancelled = Math.max(fact.cancelled, li.quantity);
          }
          fact.refunded = Math.max(fact.refunded, li.refund_quantity || 0);
        }
      } else {
        if (!state.shopifyExceptions) state.shopifyExceptions = {};
        if (!state.shopifyExceptions[orderID])
          state.shopifyExceptions[orderID] = [];
        state.shopifyExceptions[orderID].push(
          `Unknown SKU: ${li.sku} (Line Item: ${li.id})`,
        );
      }
    }

    for (const [canonicalKey, currentQty] of Object.entries(itemQtyMap)) {
      const diff = currentQty - (currentInventoryImpact[canonicalKey] || 0);
      if (diff !== 0) {
        if (state.idToItem[canonicalKey]) {
          state.idToItem[canonicalKey].shipped += diff;
          const historyVal = actionTimestamp;
          if (!state.idToHistory[canonicalKey])
            state.idToHistory[canonicalKey] = [];
          state.idToHistory[canonicalKey].push({
            date: new Date(historyVal).toLocaleString("en", {
              year: "numeric",
              month: "short",
              day: "numeric",
            }),
            desc: `Shopify Order Reconciled: ${currentQty} (diff ${diff}) for ${orderID}`,
            val: historyVal,
          });
        }
      }
      delete currentInventoryImpact[canonicalKey];
    }

    for (const [key, qty] of Object.entries(currentInventoryImpact)) {
      const canonicalKey = key as InventoryItemKey;
      if (qty !== 0 && state.idToItem[canonicalKey]) {
        state.idToItem[canonicalKey].shipped -= qty;
        const historyVal = actionTimestamp;
        if (!state.idToHistory[canonicalKey])
          state.idToHistory[canonicalKey] = [];
        state.idToHistory[canonicalKey].push({
          date: new Date(historyVal).toLocaleString("en", {
            year: "numeric",
            month: "short",
            day: "numeric",
          }),
          desc: `Shopify Order Reconciled (Missing item reset): 0 (diff -${qty}) for ${orderID}`,
          val: historyVal,
        });
      }
    }

    order.shopifyFacts!.reconciledTimestamp = timestamp;
    syncOrderItemsFromFacts(order);
  }

  r.addCase(shopify_order_updated, (state, action) => {
    applyOrderReconciliation(
      state,
      action.payload.raw,
      getTimestampMs((action as any).timestamp),
    );
  });

  r.addCase(shopify_order_reconciled, (state, action) => {
    applyOrderReconciliation(
      state,
      action.payload.raw,
      getTimestampMs((action as any).timestamp),
    );
  });
  r.addCase(hide_shopify_exception, (state, action) => {
    if (state.shopifyExceptions) {
      delete state.shopifyExceptions[action.payload.orderID];
    }
  });

  r.addCase(clear_shopify_exceptions, (state) => {
    state.shopifyExceptions = {};
  });

  r.addCase(hide_exception, (state, action) => {
    if (!state.hiddenExceptions) state.hiddenExceptions = {};
    state.hiddenExceptions[action.payload.itemKey] = true;
  });
  r.addCase(show_exception, (state, action) => {
    if (state.hiddenExceptions) {
      delete state.hiddenExceptions[action.payload.itemKey];
    }
  });
  r.addCase(update_item, (state, action) => {
    applyInventoryUpdate(
      state,
      action.payload.id,
      action.payload.item,
      (action as any).timestamp,
    );
  });
  r.addCase(update_field, (state, action) => {
    const { id: itemKey, field, to: incomingValue, from } = action.payload;
    if (state.idToItem[itemKey]) {
      if (field === "subtype") {
        const subtype = (incomingValue as string)?.trim() || "";
        const mergeItemKey = makeInventoryItemKey(
          state.idToItem[itemKey].janCode,
          subtype,
        );

        if (itemKey === mergeItemKey) {
          const ts = (action as any).timestamp;
          const val =
            state.idToItem[itemKey].timestamp ||
            (ts ? new Date(ts.seconds * 1000).getTime() : 0);
          state.idToHistory[itemKey].push({
            date: state.idToItem[itemKey].creationDate,
            desc: `Subtype update ignored (identical): ${subtype}`,
            val,
          });
          return state;
        }

        if (state.idToItem[mergeItemKey] !== undefined) {
          const mergeItem = state.idToItem[mergeItemKey];
          const oldItem = state.idToItem[itemKey];
          if (!itemsLookIdentical(oldItem, mergeItem)) {
            console.error(
              "Merge conflict on subtype update",
              oldItem,
              mergeItem,
            );
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

        // Update orders
        for (const orderID in state.orderIdToOrder) {
          const existingItems = state.orderIdToOrder[orderID].items.filter(
            (i) => i.itemKey === itemKey,
          );
          for (const item of existingItems) {
            item.itemKey = mergeItemKey;
          }
        }

        // Merge history
        const oldHistory = state.idToHistory[itemKey] || [];
        if (!state.idToHistory[mergeItemKey])
          state.idToHistory[mergeItemKey] = [];
        const combined = [
          ...state.idToHistory[mergeItemKey],
          ...oldHistory.map((h) => ({ ...h, desc: `[${itemKey}] ${h.desc}` })),
        ];
        combined.sort((a, b) => (a.val || 0) - (b.val || 0));
        state.idToHistory[mergeItemKey] = combined;

        delete state.idToItem[itemKey];

        const val = getTimestampMs((action as any).timestamp);
        state.idToHistory[mergeItemKey].push({
          date: new Date(val).toLocaleString("en", {
            year: "numeric",
            month: "short",
            day: "numeric",
          }),
          desc: `Subtype updated via update_field from '${from}' to '${subtype}' (Key: ${itemKey} -> ${mergeItemKey})`,
          val,
        });
        return state;
      }

      (state.idToItem[itemKey] as any)[field] =
        field === "qty" ||
        field === "shipped" ||
        field === "price" ||
        field === "cost" ||
        field === "weight"
          ? Number(incomingValue)
          : incomingValue;
      const timestamp = (action as any).timestamp;
      let val = 0;
      let creationDate = "Invalid Date";

      if (timestamp) {
        if (timestamp.seconds) {
          val = new Date(timestamp.seconds * 1000).getTime();
        } else if (typeof timestamp === "number") {
          val = timestamp;
        }

        if (val > 0) {
          creationDate = new Date(val).toLocaleString("en", {
            year: "numeric",
            month: "short",
            day: "numeric",
          });
        }
      }

      state.idToHistory[itemKey].push({
        date: creationDate,
        desc: `${field} changed from ${from} to ${incomingValue}`,
        val,
      });
      if (field === "qty") {
        const q = state.idToItem[itemKey][field];
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
        `Skipping update_field for missing item: ${itemKey}`,
        action.payload,
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
      state.orderIdToOrder[orderID].items.push({
        itemKey: canonicalizeInventoryItemKey(itemKey),
        qty,
      });
      //console.log(`Create item ${itemKey} to ${qty} for order ${orderID}`)
    }
    if (state.idToItem[itemKey] !== undefined) {
      state.idToItem[itemKey].shipped += qty;
      if (!state.idToHistory[itemKey]) {
        console.warn(
          `[InventoryDebug] package_item: idToHistory missing for ${itemKey}. Initializing empty.`,
        );
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
    } else {
      console.warn(
        `Skipping package_item for missing item: ${itemKey}`,
        action.payload,
      );
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
          console.warn(
            `[InventoryDebug] quantify_item: idToHistory missing for ${itemKey}. Initializing empty.`,
          );
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
      state.orderIdToOrder[orderID].items.push({
        itemKey: canonicalizeInventoryItemKey(itemKey),
        qty,
      });
    }
    if (state.idToItem[itemKey] !== undefined) {
      state.idToItem[itemKey].shipped += qty - priorQty;
      if (!state.idToHistory[itemKey]) {
        console.warn(
          `[InventoryDebug] quantify_item (shipped update): idToHistory missing for ${itemKey}. Initializing empty.`,
        );
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
    } else {
      console.warn(
        `Skipping quantify_item for missing item: ${itemKey}`,
        action.payload,
      );
    }
  });
  r.addCase(retype_item, (state, action) => {
    const { itemKey, orderID, qty } = action.payload;
    const janCode = action.payload.janCode?.trim();
    const subtype = action.payload.subtype?.trim() || "";

    if (state.orderIdToOrder[orderID] === undefined) {
      const date = new Date(0);
      state.orderIdToOrder[orderID] = { id: orderID, items: [], date };
    }
    const newItemKey = makeInventoryItemKey(janCode, subtype);
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
    } else {
      console.warn(
        `Skipping retype_item shipped update for missing item(s): ${itemKey} or ${newItemKey}`,
        action.payload,
      );
    }
    if (!state.idToHistory[itemKey]) {
      console.warn(
        `[InventoryDebug] retype_item (old key): idToHistory missing for ${itemKey}. Initializing empty.`,
      );
      state.idToHistory[itemKey] = [];
    }
    state.idToHistory[itemKey].push({
      date: state.orderIdToOrder[orderID].date.toLocaleString("en", {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
      desc: `Retyped from ${itemKey} to ${newItemKey} for ${orderID} (qty: ${state.idToItem[newItemKey]?.qty || "?"})`,
      val: state.orderIdToOrder[orderID].date.getTime(),
    });
    if (!state.idToHistory[newItemKey]) {
      console.warn(
        `[InventoryDebug] retype_item (new key): idToHistory missing for ${newItemKey}. Initializing empty.`,
      );
      state.idToHistory[newItemKey] = [];
    }
    state.idToHistory[newItemKey].push({
      date: state.orderIdToOrder[orderID].date.toLocaleString("en", {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
      desc: `Retyped from ${itemKey} to ${newItemKey} for ${orderID} (qty: ${state.idToItem[newItemKey]?.qty || "?"})`,
      val: state.orderIdToOrder[orderID].date.getTime(),
    });
  });
  r.addCase(rename_subtype, (state, action) => {
    const { itemKey } = action.payload;
    const subtype = action.payload.subtype?.trim() || "";

    if (state.idToItem[itemKey] !== undefined) {
      const mergeItemKey = makeInventoryItemKey(
        state.idToItem[itemKey].janCode,
        subtype,
      );
      if (itemKey === mergeItemKey) {
        // Use action's timestamp for the event record.
        // Note: "rename_subtype" action payload doesn't seem to have a timestamp in the interface
        // but Firestore middleware attaches it. We need to grab it.
        const ts = (action as any).timestamp;
        const val =
          state.idToItem[itemKey].timestamp ||
          (ts ? new Date(ts.seconds * 1000).getTime() : 0);

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

      const prefixedOldHistory = oldHistory.map((h) => ({
        ...h,
        desc: `[${itemKey}] ${h.desc}`,
      }));

      // Combine and sort by date using 'val' timestamp
      const combined = [
        ...state.idToHistory[mergeItemKey],
        ...prefixedOldHistory,
      ];
      combined.sort((a, b) => {
        return (a.val || 0) - (b.val || 0);
      });

      // Reassign the sorted history
      state.idToHistory[mergeItemKey] = combined;

      // Delete the old item
      delete state.idToItem[itemKey];

      const val = getTimestampMs((action as any).timestamp);

      state.idToHistory[mergeItemKey].push({
        date: new Date(val).toLocaleString("en", {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
        desc: `Retyped from ${itemKey} to ${mergeItemKey}`,
        val,
      });
      return state;
    } else {
      console.warn(
        `Skipping rename_subtype for missing item: ${itemKey}`,
        action.payload,
      );
    }
  });
  r.addCase(fix_jancode, (state, action) => {
    const oldKey = canonicalizeInventoryItemKey(action.payload.itemKey);
    const source = state.idToItem[oldKey];
    if (!source) {
      console.warn(`[Inventory] fix_jancode: source item missing: ${oldKey}`);
      return;
    }

    const normalizedJan = (action.payload.newJanCode || "")
      .trim()
      .replace(/\s+/g, "");
    if (!normalizedJan) {
      console.warn("[Inventory] fix_jancode: newJanCode is empty");
      return;
    }

    const nextSubtype = (action.payload.subtype ?? source.subtype ?? "").trim();
    const newKey = makeInventoryItemKey(normalizedJan, nextSubtype);
    const mergeMode = action.payload.mergeMode || "strict";
    const val = getTimestampMs((action as any).timestamp);
    const date = new Date(val).toLocaleString("en", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

    if (!state.idToHistory[oldKey]) {
      state.idToHistory[oldKey] = [];
    }

    if (oldKey === newKey) {
      state.idToHistory[oldKey].push({
        date,
        desc: `fix_jancode ignored (same key): ${oldKey}`,
        val,
      });
      return;
    }

    const target = state.idToItem[newKey];
    if (target && mergeMode === "strict") {
      state.idToHistory[oldKey].push({
        date,
        desc: `fix_jancode blocked by strict merge mode (${oldKey} -> ${newKey})`,
        val,
      });
      return;
    }

    if (target && !itemsLookIdentical(source, target)) {
      state.idToHistory[oldKey].push({
        date,
        desc: `fix_jancode merge conflict (${oldKey} -> ${newKey})`,
        val,
      });
      return;
    }

    if (target) {
      target.qty += source.qty;
      target.shipped += source.shipped;
    } else {
      state.idToItem[newKey] = {
        ...source,
        janCode: normalizedJan,
        subtype: nextSubtype,
      };
    }

    // Rewrite order line items and consolidate duplicates.
    Object.values(state.orderIdToOrder).forEach((order) => {
      let movedQty = 0;
      const nextItems: LineItem[] = [];
      for (const line of order.items) {
        if (line.itemKey === oldKey) {
          movedQty += line.qty;
        } else {
          nextItems.push(line);
        }
      }
      if (movedQty > 0) {
        const existing = nextItems.find((line) => line.itemKey === newKey);
        if (existing) {
          existing.qty += movedQty;
        } else {
          nextItems.push({ itemKey: newKey, qty: movedQty });
        }
      }
      order.items = nextItems;
    });

    if (!state.idToHistory[newKey]) {
      state.idToHistory[newKey] = [];
    }

    const oldHistory = state.idToHistory[oldKey] || [];
    const prefixedOldHistory = oldHistory.map((h) => ({
      ...h,
      desc: `[${oldKey}] ${h.desc}`,
    }));
    const combinedHistory = [
      ...state.idToHistory[newKey],
      ...prefixedOldHistory,
    ];
    combinedHistory.sort((a, b) => (a.val || 0) - (b.val || 0));
    state.idToHistory[newKey] = combinedHistory;
    state.idToHistory[newKey].push({
      date,
      desc: `Fixed JAN code from ${oldKey} to ${newKey}${action.payload.reason ? ` (${action.payload.reason})` : ""}`,
      val,
    });

    if (state.hiddenExceptions?.[oldKey]) {
      state.hiddenExceptions[newKey] = true;
      delete state.hiddenExceptions[oldKey];
    }

    delete state.idToItem[oldKey];
    delete state.idToHistory[oldKey];
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
      shopifyUrlToDriveUrl: {},
      initialized: state.initialized,
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

    // Safety check for archive existence
    let archive = state.archivedInventoryState[archiveName];
    if (!archive && state.hiddenInventoryState[archiveName]) {
      archive = state.hiddenInventoryState[archiveName];
    }

    if (!archive) {
      console.warn(
        `[Inventory] make_sales: Archive '${archiveName}' not found. Skipping.`,
      );
      return state;
    }

    const items: LineItem[] = [];
    for (const itemKey in archive.idToItem) {
      const preitem = archive.idToItem[itemKey];
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
        items.push({
          itemKey: makeInventoryItemKey(preitem.janCode, preitem.subtype),
          qty,
        });
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

  r.addCase(split_inventory_item, (state, action) => {
    const { sourceId, splits } = action.payload;
    const sourceItem = state.idToItem[sourceId];

    if (!sourceItem) {
      console.error(`Cannot split missing item: ${sourceId}`);
      return;
    }

    const totalSplitQty = splits.reduce((sum, s) => sum + s.qty, 0);

    // Validation (optional, maybe allow negative/overdraft?)
    // if (sourceItem.qty < totalSplitQty) ...

    // 1. Update Source Item
    sourceItem.qty -= totalSplitQty;

    const timestamp = (action as any).timestamp;
    let val = 0;
    let dateStr = "Invalid Date";

    if (timestamp) {
      if (timestamp.seconds) {
        val = new Date(timestamp.seconds * 1000).getTime();
      } else if (typeof timestamp === "number") {
        val = timestamp;
      }

      if (val > 0) {
        dateStr = new Date(val).toLocaleString("en", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
      }
    }

    state.idToHistory[sourceId].push({
      date: dateStr,
      desc: `Split ${totalSplitQty} into ${splits.length} variants`,
      val,
    });

    // 2. Create New Items
    splits.forEach((split) => {
      if (state.idToItem[split.newId]) {
        console.warn(
          `Variant ID collision: ${split.newId} already exists. Merging/Overwriting.`,
        );
        // Merge logic? Or just add qty?
        state.idToItem[split.newId].qty += split.qty;
      } else {
        state.idToItem[split.newId] = {
          ...sourceItem,
          qty: split.qty,
          subtype: split.subtype,
          janCode: sourceItem.janCode, // Keep base JAN? Or update if provided?
          // Reset fields specific to the new item instance
          shipped: 0,
          creationDate: dateStr,
          timestamp: val,
        };
      }

      // History for new item
      if (!state.idToHistory[split.newId]) state.idToHistory[split.newId] = [];
      state.idToHistory[split.newId].push({
        date: dateStr,
        desc: `Split from ${sourceId} (${split.qty})`,
        val,
      });
    });

    // 3. Cleanup Source Item if empty
    if (sourceItem.qty <= 0) {
      delete state.idToItem[sourceId];
    }
  });

  r.addCase(bulk_import_items, (state, action) => {
    const updates = action.payload.items;
    const timestamp = (action as any).timestamp;

    updates.forEach((update) => {
      applyInventoryUpdate(state, update.id, update.item, timestamp);
    });
  });
});
