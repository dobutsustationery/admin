import { createAction, createReducer } from "@reduxjs/toolkit";
import { formatYen } from "./formatters";
import {
  type InventoryItemKey,
  canonicalizeInventoryItemKey,
  canonicalizeSubtype,
  makeInventoryItemKey,
} from "./sku";
export type { InventoryItemKey };
import {
  type FirestoreTimestampLike,
  toTimestampMs,
  deriveCreationTimestampMs,
} from "./timestamped-action";
import {
  type LedgerEntry,
  walkLedger,
  UNKNOWN_RECEIPT_DATE,
} from "./cost-engine";

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
  rawSku?: string;
  entityId?: InventoryEntityId;
  manualEntityId?: InventoryEntityId;
}
export type OrderDisplayStatus =
  | "ok"
  | "canceled"
  | "refunded"
  | "partial_refund"
  | "unpaid";

export function getOrderDisplayStatus(order: {
  status?: string;
  isPaid?: boolean;
}): OrderDisplayStatus {
  const s = String(order.status || "")
    .trim()
    .toLowerCase();
  if (s === "canceled" || s === "cancelled") return "canceled";
  if (s === "refunded" || s === "fully refunded" || s === "fully_refunded") {
    return "refunded";
  }
  if (s === "partially refunded" || s === "partially_refunded") {
    return "partial_refund";
  }
  if (order.isPaid === false || s === "unpaid") return "unpaid";
  return "ok";
}

export interface OrderInfo {
  date: Date;
  eventDate?: Date;
  email?: string;
  product?: string;
  id: string;
  items: LineItem[];
  // Verbatim status string from the upstream marketplace (e.g. Etsy's
  // "Canceled", "Paid", "Completed", "Fully Refunded").  Used by the UI
  // to flag non-normal orders; compare case-insensitively.
  status?: string;
  isPaid?: boolean;
  shopifyFacts?: {
    lines: Record<string, ShopifyLineFact>; // lineItemID -> counts
    refunds: Record<string, boolean>; // refundID -> processed
    reconciledTimestamp?: number;
  };
  etsyFacts?: {
    lines: Record<string, ShopifyLineFact>; // transaction_id -> counts (reusing ShopifyLineFact shape)
    reconciledTimestamp?: number;
  };
}
export interface InventoryState {
  idToItem: { [key: string]: Item };
  idToHistory: {
    [key: string]: { date: string; desc: string; val: number }[];
  };
  keyIdentity?: InventoryKeyIdentityState;
  archivedInventoryState: { [key: string]: InventoryState };
  archivedInventoryDate: { [key: string]: string };
  hiddenInventoryState: { [key: string]: InventoryState };
  salesEvents: { [key: string]: OrderInfo };
  orderIdToOrder: { [key: string]: OrderInfo };
  shopifyUrlToDriveUrl: { [key: string]: string }; // [shopifyUrl] -> driveUrl
  hiddenExceptions?: { [key: string]: boolean };
  shopifyExceptions?: { [key: string]: string[] };
  etsyExceptions?: { [key: string]: string[] };
  // Per-item date-sorted receipt/sale ledger; `cost` is derived from it.
  // See docs/investigations/DESIGN_INVENTORY_COST_AND_VALUATION.md
  costLedger?: { [key: string]: LedgerEntry[] };
  // Per stock-order receipt date + JPY/EUR totals (owner-supplied).
  stockOrderRegistry?: { [orderId: string]: StockOrderMeta };
  initialized: boolean;
}

export interface StockOrderMeta {
  supplier?: string;
  receivedAt?: number; // epoch ms; absent -> UNKNOWN_RECEIPT_DATE
  totalOrderJpy?: number;
  totalOrderEur?: number;
}

export type InventoryEntityId = string;

export interface KeyBindingInterval {
  key: InventoryItemKey;
  entityId: InventoryEntityId;
  validFromMs: number;
  validToMs?: number;
  openedByActionType: string;
  closedByActionType?: string;
}

export interface InventoryKeyIdentityState {
  intervalsByKey: Record<InventoryItemKey, KeyBindingInterval[]>;
  currentKeyByEntityId: Record<InventoryEntityId, InventoryItemKey>;
  entityIdByCurrentKey: Record<InventoryItemKey, InventoryEntityId>;
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
export const hide_etsy_exception = createAction<{
  orderID: string;
}>("hide_etsy_exception");
export const clear_shopify_exceptions = createAction(
  "clear_shopify_exceptions",
);
export const clear_etsy_exceptions = createAction("clear_etsy_exceptions");

export const update_item = createAction<{ id: string; item: Item }>(
  "update_item",
);
export const update_field = createAction<{
  id: string;
  field: keyof Item;
  from: string | number;
  to: string | number;
}>("update_field");
// Batched, non-re-keying field writes for a single item. Semantically
// identical to dispatching update_field once per entry in order, but in
// a single Immer produce. Used by the approve_proposal orchestration to
// collapse ~6 inventory reducer passes/variant into 1 (see
// docs/investigations/REPLAY_PERFORMANCE.md). "subtype" is intentionally
// NOT supported here — it re-keys the item and must stay a separate,
// last update_field.
export const update_fields = createAction<{
  id: string;
  fields: {
    field: keyof Item;
    from: string | number;
    to: string | number;
  }[];
}>("update_fields");
export const new_order = createAction<{
  orderID: string;
  date: Date;
  email: string;
  product: string;
  eventDate?: Date;
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
export const cancel_order = createAction<{
  orderID: string;
}>("cancel_order");

/**
 * Pure decision helper used by the order-detail page's Cancel Order button.
 *
 * Returns the broadcast inputs (uid + action) when a cancel is safe to send,
 * or null when any precondition is missing.  This exists as a standalone
 * function so the null-safety can be exercised by unit tests without booting
 * a Svelte component -- a previous bug crashed in the click handler when the
 * user store was undefined.
 */
export function prepareCancelOrder(
  orderID: string | null | undefined,
  uid: string | null | undefined,
  alreadyCanceled: boolean,
): { uid: string; action: ReturnType<typeof cancel_order> } | null {
  if (!orderID) return null;
  if (!uid) return null;
  if (alreadyCanceled) return null;
  return { uid, action: cancel_order({ orderID }) };
}
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
  // Present when this row originates from a stock-order import. Marks the
  // qty delta as a genuine receipt (vs. archive-restore / manual / live)
  // and carries the per-unit cost + receipt date for the ledger.
  stockOrder?: {
    orderId: string;
    unitCostJpy: number;
    unitCostEur: number;
    receivedAt: number;
  };
}

export const bulk_import_items = createAction<{
  items: Array<BulkImportItem>;
}>("bulk_import_items");

// Owner-supplied receipt date / paid-exchange totals for a stock order.
// Replays like any other action; the ledger reads it on materialisation.
export const set_stock_order_meta = createAction<{
  orderId: string;
  meta: StockOrderMeta;
}>("set_stock_order_meta");

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

export const etsy_order_created = createAction<{
  raw: any;
  topic: string;
}>("etsy_order_created");

export const etsy_order_updated = createAction<{
  raw: any;
  topic: string;
}>("etsy_order_updated");
export const etsy_unrecognized_topic = createAction<{
  raw: any;
  topic: string;
}>("etsy_unrecognized_topic");
export const etsy_order_reconciled = createAction<{
  raw: any;
  topic: string;
}>("etsy_order_reconciled");

function getTimestampMs(timestamp: any): number {
  const ms = toTimestampMs(timestamp as FirestoreTimestampLike);
  return ms ?? 0;
}

const createEmptyKeyIdentityState = (): InventoryKeyIdentityState => ({
  intervalsByKey: {},
  currentKeyByEntityId: {},
  entityIdByCurrentKey: {},
});

const ensureKeyIdentityState = (
  state: InventoryState,
): InventoryKeyIdentityState => {
  if (!state.keyIdentity) {
    state.keyIdentity = createEmptyKeyIdentityState();
  }
  state.keyIdentity.intervalsByKey ||= {};
  state.keyIdentity.currentKeyByEntityId ||= {};
  state.keyIdentity.entityIdByCurrentKey ||= {};
  return state.keyIdentity;
};

const cloneKeyIdentityState = (
  state: InventoryKeyIdentityState | undefined,
): InventoryKeyIdentityState => ({
  intervalsByKey: Object.fromEntries(
    Object.entries(state?.intervalsByKey || {}).map(([key, intervals]) => [
      key,
      intervals.map((interval) => ({ ...interval })),
    ]),
  ) as Record<InventoryItemKey, KeyBindingInterval[]>,
  currentKeyByEntityId: { ...(state?.currentKeyByEntityId || {}) },
  entityIdByCurrentKey: { ...(state?.entityIdByCurrentKey || {}) },
});

const actionDocIdForEntity = (
  actionType: string,
  actionDocId: string | undefined,
  atMs: number,
  key: InventoryItemKey,
): string => actionDocId || `local:${actionType}:${atMs}:${key}`;

const makeInventoryEntityId = (
  creatingActionDocId: string,
  originalInventoryKey: InventoryItemKey,
): InventoryEntityId => `${creatingActionDocId}:${originalInventoryKey}`;

const findBindingIntervalAt = (
  intervals: KeyBindingInterval[] | undefined,
  atMs: number,
): KeyBindingInterval | undefined => {
  if (!intervals?.length) return undefined;
  let low = 0;
  let high = intervals.length - 1;
  let candidate: KeyBindingInterval | undefined;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const interval = intervals[mid];
    if (interval.validFromMs <= atMs) {
      candidate = interval;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (
    candidate &&
    candidate.validFromMs <= atMs &&
    (candidate.validToMs === undefined || atMs < candidate.validToMs)
  ) {
    return candidate;
  }

  return undefined;
};

const findActiveBindingInterval = (
  intervals: KeyBindingInterval[] | undefined,
  entityId?: InventoryEntityId,
): KeyBindingInterval | undefined => {
  if (!intervals?.length) return undefined;
  for (let i = intervals.length - 1; i >= 0; i -= 1) {
    const interval = intervals[i];
    if (
      interval.validToMs === undefined &&
      (!entityId || interval.entityId === entityId)
    ) {
      return interval;
    }
  }
  return undefined;
};

const bindNewInventoryEntity = (
  state: InventoryState,
  rawKey: string,
  atMs: number,
  actionType: string,
  actionDocId?: string,
): InventoryEntityId | undefined => {
  const identity = ensureKeyIdentityState(state);
  const key = canonicalizeInventoryItemKey(rawKey);
  const existingEntityId = identity.entityIdByCurrentKey[key];
  if (existingEntityId) return existingEntityId;

  // Check if we already have an active binding for this key in the intervals list
  // that somehow got out of sync with entityIdByCurrentKey
  const activeInterval = findActiveBindingInterval(
    identity.intervalsByKey[key],
  );
  if (activeInterval) {
    identity.entityIdByCurrentKey[key] = activeInterval.entityId;
    identity.currentKeyByEntityId[activeInterval.entityId] = key;
    return activeInterval.entityId;
  }

  // Guard against pending writes with no server timestamp yet
  if (atMs <= 0 && !actionType.includes(":backfill")) return undefined;

  const creatingActionDocId = actionDocIdForEntity(
    actionType,
    actionDocId,
    atMs,
    key,
  );
  const entityId = makeInventoryEntityId(creatingActionDocId, key);
  if (!identity.intervalsByKey[key]) identity.intervalsByKey[key] = [];
  identity.intervalsByKey[key].push({
    key,
    entityId,
    validFromMs: atMs,
    openedByActionType: actionType,
  });
  identity.currentKeyByEntityId[entityId] = key;
  identity.entityIdByCurrentKey[key] = entityId;
  return entityId;
};

const currentEntityIdsForKey = (
  identity: InventoryKeyIdentityState,
  key: InventoryItemKey,
): InventoryEntityId[] => {
  const ids = new Set<InventoryEntityId>();
  const direct = identity.entityIdByCurrentKey[key];
  if (direct) ids.add(direct);
  for (const [entityId, currentKey] of Object.entries(
    identity.currentKeyByEntityId,
  )) {
    if (currentKey === key) ids.add(entityId);
  }
  return [...ids];
};

const renameInventoryEntityKey = (
  state: InventoryState,
  rawOldKey: string,
  rawNewKey: string,
  atMs: number,
  actionType: string,
): void => {
  const oldKey = canonicalizeInventoryItemKey(rawOldKey);
  const newKey = canonicalizeInventoryItemKey(rawNewKey);
  if (oldKey === newKey) return;

  // Guard against pending writes
  if (atMs <= 0 && !actionType.includes(":backfill")) return;

  const identity = ensureKeyIdentityState(state);
  let entityIds = currentEntityIdsForKey(identity, oldKey);
  if (entityIds.length === 0) {
    const historicalInterval = findBindingIntervalAt(
      identity.intervalsByKey[oldKey],
      atMs,
    );
    if (historicalInterval) {
      entityIds = [historicalInterval.entityId];
    }
  }
  if (entityIds.length === 0) {
    const backfillId = bindNewInventoryEntity(
      state,
      oldKey,
      0,
      `${actionType}:backfill`,
    );
    entityIds = backfillId ? [backfillId] : [];
  }

  for (const entityId of entityIds) {
    const activeOldInterval = findActiveBindingInterval(
      identity.intervalsByKey[oldKey],
      entityId,
    );
    if (activeOldInterval) {
      activeOldInterval.validToMs = atMs;
      activeOldInterval.closedByActionType = actionType;
    }
  }

  const newKeyHasActiveOwner = !!findActiveBindingInterval(
    identity.intervalsByKey[newKey],
  );
  if (!newKeyHasActiveOwner) {
    if (!identity.intervalsByKey[newKey]) identity.intervalsByKey[newKey] = [];
    for (const entityId of entityIds) {
      identity.intervalsByKey[newKey].push({
        key: newKey,
        entityId,
        validFromMs: atMs,
        openedByActionType: actionType,
      });
    }
    identity.entityIdByCurrentKey[newKey] = entityIds[0];
  }

  for (const entityId of entityIds) {
    identity.currentKeyByEntityId[entityId] = newKey;
  }
  delete identity.entityIdByCurrentKey[oldKey];
};

const closeInventoryEntityKey = (
  state: InventoryState,
  rawKey: string,
  atMs: number,
  actionType: string,
): void => {
  const key = canonicalizeInventoryItemKey(rawKey);

  // Guard against pending writes
  if (atMs <= 0 && !actionType.includes(":backfill")) return;

  const identity = ensureKeyIdentityState(state);
  const entityIds = currentEntityIdsForKey(identity, key);
  for (const entityId of entityIds) {
    const activeInterval = findActiveBindingInterval(
      identity.intervalsByKey[key],
      entityId,
    );
    if (activeInterval) {
      activeInterval.validToMs = atMs;
      activeInterval.closedByActionType = actionType;
    }
    delete identity.currentKeyByEntityId[entityId];
  }
  delete identity.entityIdByCurrentKey[key];
};

export type HistoricalSkuResolutionOutcome =
  | "resolved"
  | "missing_historical_binding"
  | "ambiguous_historical_binding"
  | "missing_current_key";

export interface HistoricalSkuResolution {
  itemKey: InventoryItemKey;
  entityId?: InventoryEntityId;
  outcome: HistoricalSkuResolutionOutcome;
}

export const resolveHistoricalInventoryKey = (
  state: InventoryState,
  rawKey: string,
  effectiveAtMs: number,
): HistoricalSkuResolution => {
  const key = canonicalizeInventoryItemKey(rawKey);
  const identity = ensureKeyIdentityState(state);
  const interval = findBindingIntervalAt(
    identity.intervalsByKey[key],
    effectiveAtMs,
  );
  if (!interval) {
    return {
      itemKey: key,
      outcome: "missing_historical_binding",
    };
  }

  const currentKey = identity.currentKeyByEntityId[interval.entityId];
  if (!currentKey) {
    return {
      itemKey: key,
      entityId: interval.entityId,
      outcome: "missing_current_key",
    };
  }

  return {
    itemKey: canonicalizeInventoryItemKey(currentKey),
    entityId: interval.entityId,
    outcome: "resolved",
  };
};

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

// When applyInventoryUpdate redirects a write from a bare-JAN id to its
// canonical (subtyped) id, a row may already exist under the bare-JAN
// key (e.g. created by an order import before the Shopify import
// assigned a subtype). Leaving it behind produces an orphaned shell and
// shifts order-line keys. Migrate it into the canonical row using the
// same semantics as rename_subtype: additive qty/shipped merge, order
// reference + entity-binding rewrite, history merge, then delete the
// stale bare-JAN row. See docs/investigations/REPLAY_CONSOLE_ERRORS.md.
function migrateBareJanRowToCanonical(
  state: InventoryState,
  oldKey: string,
  canonicalId: string,
  subtype: string,
  timestamp: any,
  actionType: string,
) {
  // Order references and entity bindings are rewritten unconditionally:
  // once this JAN is known to be subtyped, any line still pointing at
  // the bare JAN is the malformed one we want to repair.
  rewriteOrderItemKeyReferences(
    state,
    oldKey as InventoryItemKey,
    canonicalId as InventoryItemKey,
  );
  renameInventoryEntityKey(
    state,
    oldKey,
    canonicalId,
    getTimestampMs(timestamp),
    actionType,
  );

  const oldItem = state.idToItem[oldKey];
  if (oldItem) {
    const mergeItem = state.idToItem[canonicalId];
    if (mergeItem) {
      mergeItem.qty += oldItem.qty || 0;
      mergeItem.shipped = (mergeItem.shipped || 0) + (oldItem.shipped || 0);
    } else {
      state.idToItem[canonicalId] = { ...oldItem, subtype };
    }
  }

  const oldHistory = state.idToHistory[oldKey];
  if (oldHistory && oldHistory.length > 0) {
    if (!state.idToHistory[canonicalId]) state.idToHistory[canonicalId] = [];
    const prefixed = oldHistory.map((h) => ({
      ...h,
      desc: `[${oldKey}] ${h.desc}`,
    }));
    state.idToHistory[canonicalId] = [
      ...state.idToHistory[canonicalId],
      ...prefixed,
    ].sort((a, b) => (a.val || 0) - (b.val || 0));
  }

  migrateCostLedger(state, oldKey, canonicalId);

  delete state.idToItem[oldKey];
  delete state.idToHistory[oldKey];
}

// Carry the cost ledger with the item across a key change/merge. Entries
// from the old key are appended after the destination's and re-seq'd so
// the deterministic (at, seq) order is preserved; the destination cost is
// re-derived. See docs/investigations/DESIGN_INVENTORY_COST_AND_VALUATION.md
function migrateCostLedger(
  state: InventoryState,
  oldKey: string,
  newKey: string,
) {
  if (!state.costLedger || !state.costLedger[oldKey]) return;
  if (!state.costLedger[newKey]) state.costLedger[newKey] = [];
  const merged = [...state.costLedger[newKey], ...state.costLedger[oldKey]];
  merged.forEach((e, i) => (e.seq = i));
  state.costLedger[newKey] = merged;
  delete state.costLedger[oldKey];
  rederiveCostFromLedger(state, newKey);
}

// Copy (don't move) a ledger to a new key — for splits where the source
// row survives. Entries are deep-cloned so later mutation is independent.
function copyCostLedger(
  state: InventoryState,
  sourceKey: string,
  newKey: string,
) {
  if (!state.costLedger || !state.costLedger[sourceKey]) return;
  state.costLedger[newKey] = state.costLedger[sourceKey].map((e, i) => ({
    ...e,
    seq: i,
  }));
  rederiveCostFromLedger(state, newKey);
}

// Append a dated sale (outflow) to the ledger so the perpetual walk
// reduces on-hand at the right point in time. `qty` may be negative
// (a refund/cancel/reset restores on-hand). No-op if the item has no
// ledger (nothing was ever received -> sale is irrelevant to cost).
function recordSale(
  state: InventoryState,
  key: string,
  qty: number,
  atMs: number,
) {
  if (!qty || !Number.isFinite(qty)) return;
  if (!state.costLedger || !state.costLedger[key]) return;
  const ledger = state.costLedger[key];
  ledger.push({
    kind: "sale",
    at: Number.isFinite(atMs) && atMs > 0 ? atMs : UNKNOWN_RECEIPT_DATE,
    seq: ledger.length,
    qty,
  });
  rederiveCostFromLedger(state, key);
}

function rederiveCostFromLedger(state: InventoryState, key: string) {
  const ledger = state.costLedger?.[key];
  const item = state.idToItem[key];
  if (!ledger || !item) return;
  const hasPriced = ledger.some(
    (e) => e.kind === "receipt" && e.unitCostJpy > 0,
  );
  if (ledger.length >= 2 || hasPriced) {
    item.cost = walkLedger(ledger).avgJpy;
  }
}

// Helper to apply update logic
function applyInventoryUpdate(
  state: InventoryState,
  id: string,
  item: Partial<Item>,
  timestamp: any,
  actionType = "update_item",
  actionDocId?: string,
  stockOrder?: BulkImportItem["stockOrder"],
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

  // Validation: the idToItem key must equal makeInventoryItemKey(janCode,
  // subtype). When the payload carries an explicit (janCode, subtype),
  // that pair is authoritative — canonicalize on write instead of logging
  // and writing under a stale/bare-JAN key. See
  // docs/investigations/REPLAY_CONSOLE_ERRORS.md and
  // SHOPIFY_IMPORT_OPTION1_PHANTOM_VARIANT.md.
  if (item.janCode) {
    const canonicalId = makeInventoryItemKey(item.janCode, item.subtype || "");
    if (
      id !== canonicalId &&
      canonicalizeInventoryItemKey(id) === canonicalId
    ) {
      // Structural-normalization case (whitespace / format).
      id = canonicalId;
    }
    // "Bare JAN" = a numeric JAN with NO subtype component. Use the
    // structural split (digits prefix + remainder); the id is bare only
    // when the remainder is empty. This excludes ids that already encode
    // a subtype (e.g. a "Variant SKU" of "4542804108606Bear" parsed as
    // janCode), arbitrary synthetic itemIds, and "JAN:Subtype" variant
    // ids — all of which other slices reference and must not be silently
    // re-keyed here.
    const idMatch = id.trim().match(/^(\d+)(.*)$/);
    const idIsBareJan = !!idMatch && idMatch[2] === "";
    if (
      id !== canonicalId &&
      idIsBareJan &&
      (item.subtype || "").trim() !== ""
    ) {
      // Bare numeric JAN id + explicit payload subtype: the Shopify
      // import MATCH/NEW signature — 100% of the 93 production
      // console.error cases. Redirect the write to the canonical key and
      // migrate any stale bare-JAN row (and its order references) into
      // it.
      const staleKey = id;
      id = canonicalId;
      migrateBareJanRowToCanonical(
        state,
        staleKey,
        canonicalId,
        canonicalizeSubtype(item.subtype),
        timestamp,
        actionType,
      );
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
  const isNewItem = !existingItem;
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

  // Always try to bind, it handles its own idempotency
  bindNewInventoryEntity(state, id, val, actionType, actionDocId);

  // --- Cost-lot ledger materialisation -------------------------------
  // See docs/investigations/DESIGN_INVENTORY_COST_AND_VALUATION.md
  // `cost` is derived from this ledger. Single-receipt items derive the
  // exact same value as the old last-write (walk of one priced lot ==
  // that lot's cost); only genuine stock-order re-orders add a second
  // lot and therefore blend. Never-priced items keep cost untouched.
  if (!state.costLedger) state.costLedger = {};
  if (!state.costLedger[id]) state.costLedger[id] = [];
  const ledger = state.costLedger[id];
  const deltaQty = Number(item.qty);
  let ledgerChanged = false;

  // Pending writes (atMs <= 0, e.g. an optimistic local write before the
  // server timestamp resolves) are guarded here exactly like entity
  // binding: defer ledger materialisation until the confirming write
  // carries a real timestamp. deriveCreationTimestampMs stays strict —
  // it is only reached on a resolved (val > 0) timestamp.
  if (val > 0 && isNewItem) {
    ledger.push({
      kind: "receipt",
      at: deriveCreationTimestampMs(timestamp),
      seq: ledger.length,
      qty: Number.isFinite(deltaQty) ? deltaQty : 0,
      unitCostJpy: Number(item.cost) > 0 ? Number(item.cost) : 0,
      unitCostEur: 0,
    });
    ledgerChanged = true;
  } else if (val > 0 && stockOrder) {
    if (Number.isFinite(deltaQty) && deltaQty > 0) {
      // Genuine re-order: a new dated receipt at the re-order price.
      ledger.push({
        kind: "receipt",
        at: stockOrder.receivedAt || UNKNOWN_RECEIPT_DATE,
        seq: ledger.length,
        qty: deltaQty,
        unitCostJpy: stockOrder.unitCostJpy,
        unitCostEur: stockOrder.unitCostEur,
      });
      ledgerChanged = true;
    } else {
      // Original order (qty 0): attach landed cost to unpriced receipts.
      for (const e of ledger) {
        if (e.kind === "receipt" && !(e.unitCostJpy > 0)) {
          e.unitCostJpy = stockOrder.unitCostJpy;
          e.unitCostEur = stockOrder.unitCostEur;
          ledgerChanged = true;
        }
      }
    }
  }

  if (ledgerChanged) {
    const hasPriced = ledger.some(
      (e) => e.kind === "receipt" && e.unitCostJpy > 0,
    );
    if (ledger.length >= 2 || hasPriced) {
      const derived = walkLedger(ledger).avgJpy;
      state.idToItem[id].cost = derived;
      historyEntries.push({
        date: globalDate,
        desc: `Cost derived from ${ledger.length} lot(s): ${formatYen(derived)}`,
        val,
      });
    }
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
  keyIdentity: createEmptyKeyIdentityState(),
  orderIdToOrder: {},
  archivedInventoryState: {},
  archivedInventoryDate: {},
  hiddenInventoryState: {},
  salesEvents: {},
  shopifyUrlToDriveUrl: {},
  shopifyExceptions: {},
  etsyExceptions: {},
  costLedger: {},
  stockOrderRegistry: {},
  initialized: false,
};

function syncOrderItemsFromFacts(order: OrderInfo) {
  const itemKeyToQty: Record<string, number> = {};

  if (order.shopifyFacts) {
    for (const lineItemID in order.shopifyFacts.lines) {
      const fact = order.shopifyFacts.lines[lineItemID];
      const currentQty = fact.placed - fact.cancelled - fact.refunded;
      if (currentQty > 0) {
        itemKeyToQty[fact.itemKey] =
          (itemKeyToQty[fact.itemKey] || 0) + currentQty;
      }
    }
  }

  if (order.etsyFacts) {
    for (const lineItemID in order.etsyFacts.lines) {
      const fact = order.etsyFacts.lines[lineItemID];
      const currentQty = fact.placed - fact.cancelled - fact.refunded;
      if (currentQty > 0) {
        itemKeyToQty[fact.itemKey] =
          (itemKeyToQty[fact.itemKey] || 0) + currentQty;
      }
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

  // Fallback: search in properties (Shopify)
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

  // Fallback for Etsy: search in variations or title
  if (lineItem.listing_id || lineItem.variations) {
    // If we have a non-numeric SKU, it might be JAN+Subtype already
    if (normalizedSku) {
      return normalizedSku as InventoryItemKey;
    }

    // Try to find JAN in title or variations
    const title = String(lineItem.title || "").trim();
    const janMatch = title.match(/\b\d{13}\b/);
    if (janMatch) {
      const jan = janMatch[0];
      let subtype = "";
      if (lineItem.variations) {
        subtype = lineItem.variations
          .map((v: any) => v.formatted_value)
          .join(" ");
      }
      return makeInventoryItemKey(jan, subtype);
    }
  }

  return (normalizedSku as InventoryItemKey) || null;
}

function getOrderFactEffectiveAtMs(rawOrder: any, actionTimestamp: number) {
  const parsed = Date.parse(
    rawOrder.processed_at || rawOrder.created_at || rawOrder.updated_at || "",
  );
  return Number.isFinite(parsed) ? parsed : actionTimestamp;
}

function resolveLineItemInventoryKey(
  state: InventoryState,
  lineItem: any,
  effectiveAtMs: number,
): {
  itemKey: InventoryItemKey | null;
  rawSku: string;
  entityId?: InventoryEntityId;
  outcome?: HistoricalSkuResolutionOutcome;
} {
  const rawItemKey = mapSkuToItemKey(lineItem.sku, lineItem);
  if (!rawItemKey) {
    return { itemKey: null, rawSku: String(lineItem.sku || "") };
  }
  const resolved = resolveHistoricalInventoryKey(
    state,
    rawItemKey,
    effectiveAtMs,
  );
  return {
    itemKey: resolved.itemKey,
    rawSku: String(lineItem.sku || rawItemKey),
    entityId: resolved.entityId,
    outcome: resolved.outcome,
  };
}

function rewriteOrderItemKeyReferences(
  state: InventoryState,
  oldKey: InventoryItemKey,
  newKey: InventoryItemKey,
) {
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

    if (order.shopifyFacts?.lines) {
      for (const fact of Object.values(order.shopifyFacts.lines)) {
        if (fact.itemKey === oldKey) {
          fact.itemKey = newKey;
        }
      }
    }
    if (order.etsyFacts?.lines) {
      for (const fact of Object.values(order.etsyFacts.lines)) {
        if (fact.itemKey === oldKey) {
          fact.itemKey = newKey;
        }
      }
    }
  });
}

function getOrCreateOrder(
  state: InventoryState,
  orderID: string,
  rawOrder: any,
  actionTimestamp: number,
): OrderInfo {
  const isEtsy = orderID.startsWith("etsy:");
  if (!state.orderIdToOrder[orderID]) {
    state.orderIdToOrder[orderID] = {
      id: orderID,
      date: new Date(
        rawOrder.created_at ||
          (rawOrder.create_timestamp ? rawOrder.create_timestamp * 1000 : 0) ||
          actionTimestamp,
      ),
      email:
        rawOrder.email || rawOrder.contact_email || rawOrder.buyer_email || "",
      items: [],
      shopifyFacts: isEtsy ? undefined : { lines: {}, refunds: {} },
      etsyFacts: isEtsy ? { lines: {} } : undefined,
    };
  }
  const order = state.orderIdToOrder[orderID];
  if (isEtsy && !order.etsyFacts) {
    order.etsyFacts = { lines: {} };
  } else if (!isEtsy && !order.shopifyFacts) {
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
    const shopifyTimestamp = Date.parse(
      rawOrder.created_at || rawOrder.updated_at,
    );
    const effectiveAtMs = getOrderFactEffectiveAtMs(rawOrder, actionTimestamp);
    const order = getOrCreateOrder(state, orderID, rawOrder, actionTimestamp);

    const isReconciledLater =
      order.shopifyFacts!.reconciledTimestamp &&
      order.shopifyFacts!.reconciledTimestamp > shopifyTimestamp;

    const lineItems = rawOrder.line_items || [];
    for (const li of lineItems) {
      const { itemKey, rawSku, entityId, outcome } =
        resolveLineItemInventoryKey(state, li, effectiveAtMs);
      if (!itemKey || outcome === "missing_historical_binding") {
        if (!state.shopifyExceptions) state.shopifyExceptions = {};
        if (!state.shopifyExceptions[orderID])
          state.shopifyExceptions[orderID] = [];
        if (!itemKey) {
          state.shopifyExceptions[orderID].push(
            `Unknown SKU: ${li.sku} (Line Item: ${li.id})`,
          );
        } else {
          state.shopifyExceptions[orderID].push(
            `Missing historical binding for SKU: ${li.sku} (Line Item: ${li.id})`,
          );
        }
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
          rawSku,
          entityId,
        };
      }
      const fact = order.shopifyFacts!.lines[lineItemID];
      if (fact.manualEntityId) {
        const currentKey =
          state.keyIdentity?.currentKeyByEntityId[fact.manualEntityId];
        if (currentKey) {
          fact.itemKey = currentKey;
          fact.entityId = fact.manualEntityId;
        }
      } else {
        fact.itemKey = canonicalKey;
        fact.entityId ??= entityId;
      }
      fact.rawSku ??= rawSku;

      const delta = qty - fact.placed;

      // Always update facts so they reflect the latest known state from this action
      fact.placed = Math.max(fact.placed, qty);
      const effectiveKey = fact.itemKey;

      if (state.idToItem[effectiveKey]) {
        if (!isReconciledLater && delta > 0) {
          state.idToItem[effectiveKey].shipped += delta;
          recordSale(state, effectiveKey, delta, effectiveAtMs);
        }

        const historyVal = actionTimestamp;
        if (!state.idToHistory[effectiveKey])
          state.idToHistory[effectiveKey] = [];

        const alreadyLogged = state.idToHistory[effectiveKey].some(
          (h) =>
            h.desc.includes("Shopify Order Created") &&
            h.desc.includes(orderID),
        );

        if (!alreadyLogged) {
          state.idToHistory[effectiveKey].push({
            date: new Date(historyVal).toLocaleString("en", {
              year: "numeric",
              month: "short",
              day: "numeric",
            }),
            desc: `Shopify Order Created: ${qty} for ${orderID}`,
            val: historyVal,
          });
          state.idToHistory[effectiveKey].sort((a, b) => a.val - b.val);
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
      "Shopify Order Cancelled",
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

    const shopifyTimestamp = Date.parse(rawRefund.created_at);
    const isReconciledLater =
      order.shopifyFacts.reconciledTimestamp &&
      order.shopifyFacts.reconciledTimestamp > shopifyTimestamp;

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
      if (state.idToItem[canonicalKey]) {
        if (!isReconciledLater && amountToSubtract > 0) {
          state.idToItem[canonicalKey].shipped -= amountToSubtract;
        }

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
        state.idToHistory[canonicalKey].sort((a, b) => a.val - b.val);
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
    labelPrefix: string = "Shopify Order Reconciled",
  ) {
    const orderID = `shopify:${rawOrder.id}`;

    if (state.shopifyExceptions) {
      delete state.shopifyExceptions[orderID];
    }

    const order = getOrCreateOrder(state, orderID, rawOrder, actionTimestamp);

    const timestamp = Date.parse(rawOrder.updated_at || rawOrder.created_at);
    const effectiveAtMs = getOrderFactEffectiveAtMs(rawOrder, actionTimestamp);

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

    const oldFacts = order.shopifyFacts!.lines;
    const newFacts: Record<string, ShopifyLineFact> = {};
    const itemQtyMap: Record<string, number> = {};

    const lineItems = rawOrder.line_items || [];
    for (const li of lineItems) {
      const {
        itemKey: resolvedKey,
        rawSku,
        entityId,
        outcome,
      } = resolveLineItemInventoryKey(state, li, effectiveAtMs);

      const lineItemID = String(li.id);
      const oldFact = oldFacts[lineItemID];

      if (resolvedKey && outcome !== "missing_historical_binding") {
        const isManualRetype =
          oldFact &&
          (oldFact.manualEntityId ||
            (oldFact.itemKey !== resolvedKey && oldFact.rawSku === rawSku));

        let canonicalKey: InventoryItemKey;
        if (oldFact?.manualEntityId) {
          const currentKey =
            state.keyIdentity?.currentKeyByEntityId[oldFact.manualEntityId];
          canonicalKey = currentKey
            ? canonicalizeInventoryItemKey(currentKey)
            : canonicalizeInventoryItemKey(oldFact.itemKey);
        } else {
          canonicalKey = canonicalizeInventoryItemKey(
            isManualRetype ? oldFact!.itemKey : resolvedKey,
          );
        }

        const currentQty = rawOrder.cancelled_at
          ? 0
          : li.quantity - (li.refund_quantity || 0);
        itemQtyMap[canonicalKey] = (itemQtyMap[canonicalKey] || 0) + currentQty;

        // Authoritative Fact Update (Finding 1)
        newFacts[lineItemID] = {
          itemKey: canonicalKey,
          placed: li.quantity,
          cancelled: rawOrder.cancelled_at ? li.quantity : 0,
          refunded: li.refund_quantity || 0,
          rawSku,
          entityId,
          manualEntityId: oldFact?.manualEntityId,
        };
      } else {
        // resolution failed
        if (oldFact) {
          // §3.1 carry forward
          newFacts[lineItemID] = oldFact;

          // If we already have impact for this line, carry it forward
          // so we don't accidentally subtract it in the diff loop below (§3.1).
          const canonicalKey = canonicalizeInventoryItemKey(oldFact.itemKey);
          const previousImpact =
            oldFact.placed - oldFact.cancelled - oldFact.refunded;
          itemQtyMap[canonicalKey] =
            (itemQtyMap[canonicalKey] || 0) + previousImpact;
        }

        if (!state.shopifyExceptions) state.shopifyExceptions = {};
        if (!state.shopifyExceptions[orderID])
          state.shopifyExceptions[orderID] = [];
        if (!resolvedKey) {
          state.shopifyExceptions[orderID].push(
            `Unknown SKU: ${li.sku} (Line Item: ${li.id})`,
          );
        } else {
          state.shopifyExceptions[orderID].push(
            `Missing historical binding for SKU: ${li.sku} (Line Item: ${li.id})`,
          );
        }
      }
    }

    // Replace facts map authoritatively (Finding 1)
    order.shopifyFacts!.lines = newFacts;

    // Address Finding 3: authorize refund IDs from payload
    if (rawOrder.refunds) {
      rawOrder.refunds.forEach((r: any) => {
        order.shopifyFacts!.refunds[String(r.id)] = true;
      });
    }

    for (const [canonicalKey, currentQty] of Object.entries(itemQtyMap)) {
      const diff = currentQty - (currentInventoryImpact[canonicalKey] || 0);
      if (diff !== 0) {
        if (state.idToItem[canonicalKey]) {
          state.idToItem[canonicalKey].shipped += diff;
          recordSale(state, canonicalKey, diff, effectiveAtMs);
          const historyVal = actionTimestamp;
          if (!state.idToHistory[canonicalKey])
            state.idToHistory[canonicalKey] = [];
          state.idToHistory[canonicalKey].push({
            date: new Date(historyVal).toLocaleString("en", {
              year: "numeric",
              month: "short",
              day: "numeric",
            }),
            desc: `${labelPrefix}: ${currentQty} (diff ${diff}) for ${orderID}`,
            val: historyVal,
          });
          state.idToHistory[canonicalKey].sort((a, b) => a.val - b.val);
        }
      }
      delete currentInventoryImpact[canonicalKey];
    }

    for (const [key, qty] of Object.entries(currentInventoryImpact)) {
      const canonicalKey = key as InventoryItemKey;
      if (qty !== 0 && state.idToItem[canonicalKey]) {
        state.idToItem[canonicalKey].shipped -= qty;
        recordSale(state, canonicalKey, -qty, effectiveAtMs);
        const historyVal = actionTimestamp;
        if (!state.idToHistory[canonicalKey])
          state.idToHistory[canonicalKey] = [];
        state.idToHistory[canonicalKey].push({
          date: new Date(historyVal).toLocaleString("en", {
            year: "numeric",
            month: "short",
            day: "numeric",
          }),
          desc: `${labelPrefix} (Missing item reset): 0 (diff -${qty}) for ${orderID}`,
          val: historyVal,
        });
        state.idToHistory[canonicalKey].sort((a, b) => a.val - b.val);
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
      "Shopify Order Updated",
    );
  });

  r.addCase(shopify_order_reconciled, (state, action) => {
    applyOrderReconciliation(
      state,
      action.payload.raw,
      getTimestampMs((action as any).timestamp),
    );
  });
  r.addCase(etsy_order_created, (state, action) => {
    applyEtsyOrderReconciliation(
      state,
      action.payload.raw,
      getTimestampMs((action as any).timestamp),
      "Etsy Order Created",
    );
  });

  r.addCase(etsy_order_updated, (state, action) => {
    applyEtsyOrderReconciliation(
      state,
      action.payload.raw,
      getTimestampMs((action as any).timestamp),
      "Etsy Order Updated",
    );
  });

  r.addCase(etsy_order_reconciled, (state, action) => {
    applyEtsyOrderReconciliation(
      state,
      action.payload.raw,
      getTimestampMs((action as any).timestamp),
    );
  });

  function applyEtsyOrderReconciliation(
    state: InventoryState,
    rawReceipt: any,
    actionTimestamp: number,
    labelPrefix: string = "Etsy Order Reconciled",
  ) {
    const orderID = `etsy:${rawReceipt.receipt_id}`;
    if (state.etsyExceptions) {
      delete state.etsyExceptions[orderID];
    }

    const order = getOrCreateOrder(state, orderID, rawReceipt, actionTimestamp);
    const timestamp =
      (rawReceipt.updated_timestamp || rawReceipt.create_timestamp) * 1000;
    const effectiveAtMs = timestamp;

    if (
      order.etsyFacts!.reconciledTimestamp &&
      order.etsyFacts!.reconciledTimestamp >= timestamp
    ) {
      return;
    }

    const oldFacts = order.etsyFacts!.lines;
    const newFacts: Record<string, ShopifyLineFact> = {};

    const transactions = rawReceipt.transactions || [];
    for (const tx of transactions) {
      const {
        itemKey: resolvedKey,
        rawSku,
        entityId,
        outcome,
      } = resolveLineItemInventoryKey(state, tx, effectiveAtMs);

      const lineItemID = String(tx.transaction_id);
      const oldFact = oldFacts[lineItemID];

      if (resolvedKey && outcome !== "missing_historical_binding") {
        const isManualRetype =
          oldFact &&
          (oldFact.manualEntityId ||
            (oldFact.itemKey !== resolvedKey && oldFact.rawSku === rawSku));

        let canonicalKey: InventoryItemKey;
        if (oldFact?.manualEntityId) {
          const currentKey =
            state.keyIdentity?.currentKeyByEntityId[oldFact.manualEntityId];
          canonicalKey = currentKey
            ? canonicalizeInventoryItemKey(currentKey)
            : canonicalizeInventoryItemKey(oldFact.itemKey);
        } else {
          canonicalKey = canonicalizeInventoryItemKey(
            isManualRetype ? oldFact!.itemKey : resolvedKey,
          );
        }

        // Etsy emits status strings in title case (e.g. "Canceled",
        // "Fully Refunded"); compare case-insensitively after stripping
        // whitespace so a typo'd payload still resolves correctly.
        const normalizedStatus = String(rawReceipt.status || "")
          .trim()
          .toLowerCase();
        const isCancelled =
          normalizedStatus === "canceled" || normalizedStatus === "cancelled";
        const isUnpaid =
          rawReceipt.is_paid === false || normalizedStatus === "unpaid";
        const isFullRefund =
          normalizedStatus === "refunded" ||
          normalizedStatus === "fully refunded" ||
          normalizedStatus === "fully_refunded";

        newFacts[lineItemID] = {
          itemKey: canonicalKey,
          placed: tx.quantity,
          cancelled: isCancelled || isUnpaid ? tx.quantity : 0,
          refunded: isFullRefund ? tx.quantity : 0,
          rawSku,
          entityId,
          manualEntityId: oldFact?.manualEntityId,
        };
      } else {
        if (oldFact) {
          newFacts[lineItemID] = oldFact;
        }

        if (!state.etsyExceptions) state.etsyExceptions = {};
        if (!state.etsyExceptions[orderID]) state.etsyExceptions[orderID] = [];
        state.etsyExceptions[orderID].push(
          `Unknown SKU: ${rawSku} (Transaction: ${tx.transaction_id})`,
        );
      }
    }

    // Authoritative diff loop for idToItem.shipped
    const netDiffMap: Record<string, number> = {};

    // 1. Accumulate new impact (positives)
    for (const f of Object.values(newFacts)) {
      const k = canonicalizeInventoryItemKey(f.itemKey);
      const impact = f.placed - f.cancelled - f.refunded;
      netDiffMap[k] = (netDiffMap[k] || 0) + impact;
    }
    // 2. Subtract old impact (negatives)
    for (const f of Object.values(oldFacts)) {
      const k = canonicalizeInventoryItemKey(f.itemKey);
      const impact = f.placed - f.cancelled - f.refunded;
      netDiffMap[k] = (netDiffMap[k] || 0) - impact;
    }

    // Commit diffs to idToItem
    for (const [canonicalKey, diff] of Object.entries(netDiffMap)) {
      if (diff !== 0 && state.idToItem[canonicalKey] !== undefined) {
        state.idToItem[canonicalKey].shipped += diff;
        recordSale(state, canonicalKey, diff, effectiveAtMs);
        if (!state.idToHistory[canonicalKey])
          state.idToHistory[canonicalKey] = [];
        state.idToHistory[canonicalKey].push({
          date: new Date(actionTimestamp).toLocaleString("en", {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
          desc: `${labelPrefix} (Order ${orderID}): diff ${diff}`,
          val: actionTimestamp,
        });
        state.idToHistory[canonicalKey].sort((a, b) => a.val - b.val);
      }
    }

    // Authoritative commit
    order.etsyFacts!.lines = newFacts;
    order.etsyFacts!.reconciledTimestamp = timestamp;
    if (typeof rawReceipt.status === "string") {
      order.status = rawReceipt.status;
    }
    if (typeof rawReceipt.is_paid === "boolean") {
      order.isPaid = rawReceipt.is_paid;
    }
    syncOrderItemsFromFacts(order);
  }

  r.addCase(hide_shopify_exception, (state, action) => {
    if (state.shopifyExceptions) {
      delete state.shopifyExceptions[action.payload.orderID];
    }
  });

  r.addCase(hide_etsy_exception, (state, action) => {
    if (state.etsyExceptions) {
      delete state.etsyExceptions[action.payload.orderID];
    }
  });

  r.addCase(clear_shopify_exceptions, (state) => {
    state.shopifyExceptions = {};
  });

  r.addCase(clear_etsy_exceptions, (state) => {
    state.etsyExceptions = {};
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
  r.addCase(set_stock_order_meta, (state, action) => {
    if (!state.stockOrderRegistry) state.stockOrderRegistry = {};
    const { orderId, meta } = action.payload;
    state.stockOrderRegistry[orderId] = {
      ...state.stockOrderRegistry[orderId],
      ...meta,
    };
  });
  r.addCase(update_item, (state, action) => {
    applyInventoryUpdate(
      state,
      action.payload.id,
      action.payload.item,
      (action as any).timestamp,
      action.type,
      (action as any).id,
    );
  });
  r.addCase(update_field, (state, action) => {
    const { field, to: incomingValue, from } = action.payload;
    const itemKey = canonicalizeInventoryItemKey(action.payload.id);
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

        // Update order references and temporal key identity.
        rewriteOrderItemKeyReferences(
          state,
          itemKey as InventoryItemKey,
          mergeItemKey,
        );
        renameInventoryEntityKey(
          state,
          itemKey,
          mergeItemKey,
          getTimestampMs((action as any).timestamp),
          action.type,
        );
        migrateCostLedger(state, itemKey, mergeItemKey);

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

      // Pending-tolerant (null / {seconds:0} are valid pending writes
      // here, not errors): resolve via the canonical converter and only
      // format a date when it resolves to a real (> 0) time.
      if (timestamp) {
        val = toTimestampMs(timestamp as FirestoreTimestampLike) ?? 0;

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
  r.addCase(update_fields, (state, action) => {
    const itemKey = canonicalizeInventoryItemKey(action.payload.id);
    if (state.idToItem[itemKey]) {
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
      // Mirror the non-subtype branch of update_field exactly, per entry,
      // in dispatch order — same field write + same history entry.
      for (const { field, from, to: incomingValue } of action.payload.fields) {
        (state.idToItem[itemKey] as any)[field] =
          field === "qty" ||
          field === "shipped" ||
          field === "price" ||
          field === "cost" ||
          field === "weight"
            ? Number(incomingValue)
            : incomingValue;
        state.idToHistory[itemKey].push({
          date: creationDate,
          desc: `${field} changed from ${from} to ${incomingValue}`,
          val,
        });
      }
    } else {
      console.warn(
        `Skipping update_fields for missing item: ${itemKey}`,
        action.payload,
      );
    }
  });
  r.addCase(new_order, (state, action) => {
    const orderID = action.payload.orderID;
    const email = action.payload.email;
    const date = action.payload.date;
    const product = action.payload.product;
    const eventDate = action.payload.eventDate;
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
      eventDate,
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
      const order = state.orderIdToOrder[orderID];

      // Surgical move for idempotency and correctness (§3.2)
      const oldItemIdx = order.items.findIndex((i) => i.itemKey === itemKey);
      if (oldItemIdx !== -1) {
        const moveQty = Math.min(order.items[oldItemIdx].qty, qty);
        order.items[oldItemIdx].qty -= moveQty;
        if (order.items[oldItemIdx].qty === 0) {
          order.items.splice(oldItemIdx, 1);
        }
        const newItemIdx = order.items.findIndex(
          (i) => i.itemKey === newItemKey,
        );
        if (newItemIdx !== -1) {
          order.items[newItemIdx].qty += moveQty;
        } else {
          order.items.push({ itemKey: newItemKey, qty: moveQty });
        }

        // Shipped accumulator is decoupled per side: the order line was moved
        // qty units from old -> new, so old.shipped should drop and
        // new.shipped should rise — independently. The previous both-must-exist
        // guard silently dropped the increment when the retype's source key
        // was a renamed-away ghost, leaving inventory.shipped behind the
        // order's view (see docs/investigations/GHOST_MISSING_15_AUDIT.md).
        if (state.idToItem[itemKey] !== undefined) {
          state.idToItem[itemKey].shipped -= moveQty;
        }
        if (state.idToItem[newItemKey] !== undefined) {
          state.idToItem[newItemKey].shipped += moveQty;
        } else {
          console.warn(
            `Skipping retype_item shipped update for missing new item: ${newItemKey}`,
            action.payload,
          );
        }
      }

      // If this is a Shopify order, we MUST update the shopifyFacts.lines
      // otherwise a later reconciliation will undo this retype.
      const newEntityId = bindNewInventoryEntity(
        state,
        newItemKey,
        getTimestampMs((action as any).timestamp),
        action.type,
        (action as any).id,
      );

      if (order.shopifyFacts?.lines) {
        for (const fact of Object.values(order.shopifyFacts.lines)) {
          if (
            fact.itemKey === itemKey ||
            (fact.itemKey === newItemKey && !fact.manualEntityId)
          ) {
            fact.itemKey = newItemKey;
            if (newEntityId) {
              fact.manualEntityId = newEntityId;
            }
          }
        }
      }
      if (order.etsyFacts?.lines) {
        for (const fact of Object.values(order.etsyFacts.lines)) {
          if (
            fact.itemKey === itemKey ||
            (fact.itemKey === newItemKey && !fact.manualEntityId)
          ) {
            fact.itemKey = newItemKey;
            if (newEntityId) {
              fact.manualEntityId = newEntityId;
            }
          }
        }
      }
    } else {
      console.error(`${itemKey} vs ${newItemKey}`);
    }

    // history logic follows...
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
      // Find all order references to the itemKey and point them at the new key.
      rewriteOrderItemKeyReferences(
        state,
        itemKey as InventoryItemKey,
        mergeItemKey,
      );
      renameInventoryEntityKey(
        state,
        itemKey,
        mergeItemKey,
        getTimestampMs((action as any).timestamp),
        action.type,
      );
      migrateCostLedger(state, itemKey, mergeItemKey);

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
    rewriteOrderItemKeyReferences(state, oldKey, newKey);
    renameInventoryEntityKey(state, oldKey, newKey, val, action.type);
    migrateCostLedger(state, oldKey, newKey);

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
  r.addCase(cancel_order, (state, action) => {
    const orderID = action.payload.orderID;
    const order = state.orderIdToOrder[orderID];
    if (!order) return;

    // 1. Reverse shipped impact for every line currently attributed to
    //    this order in idToItem.shipped.
    for (const line of order.items) {
      const itemKey = canonicalizeInventoryItemKey(line.itemKey);
      const item = state.idToItem[itemKey];
      if (item !== undefined && line.qty) {
        item.shipped -= line.qty;
      }
    }

    // 2. For marketplace-derived orders (etsy/shopify), update the
    //    underlying facts so the next reconcile doesn't undo us.  Marking
    //    every fact as cancelled=placed leaves a 0-impact record that
    //    syncOrderItemsFromFacts will collapse to an empty items array.
    if (order.etsyFacts) {
      for (const lineId in order.etsyFacts.lines) {
        const fact = order.etsyFacts.lines[lineId];
        fact.cancelled = fact.placed;
        fact.refunded = 0;
      }
      syncOrderItemsFromFacts(order);
    } else if (order.shopifyFacts) {
      for (const lineId in order.shopifyFacts.lines) {
        const fact = order.shopifyFacts.lines[lineId];
        fact.cancelled = fact.placed;
        fact.refunded = 0;
      }
      syncOrderItemsFromFacts(order);
    } else {
      // Non-marketplace order: items is the source of truth, just empty it.
      order.items = [];
    }

    order.status = "Canceled";
  });
  r.addCase(archive_inventory, (state, action) => {
    const archiveName = action.payload.archiveName;
    // Prevent circular reference by picking only relevant state
    const archive = (state.archivedInventoryState[archiveName] = {
      idToItem: { ...state.idToItem },
      idToHistory: { ...state.idToHistory },
      keyIdentity: cloneKeyIdentityState(state.keyIdentity),
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
    const date = action.payload.date;
    const saleAtMs =
      date instanceof Date ? date.getTime() : getTimestampMs(date);
    for (const it of items) {
      recordSale(state, it.itemKey, it.qty, saleAtMs);
    }
    const email = "dobutsustationery@gmail.com";
    const product = archiveName;
    state.salesEvents[archiveName] = {
      id: orderID,
      items,
      email,
      product,
      date,
    };
  });

  r.addCase(split_inventory_item, (state, action) => {
    const sourceId = canonicalizeInventoryItemKey(action.payload.sourceId);
    const splits = action.payload.splits.map((s) => ({
      ...s,
      newId: canonicalizeInventoryItemKey(s.newId),
    }));
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

      // New item inherits the source's cost basis (same unit cost).
      copyCostLedger(state, sourceId, split.newId);

      // History for new item
      if (!state.idToHistory[split.newId]) state.idToHistory[split.newId] = [];
      state.idToHistory[split.newId].push({
        date: dateStr,
        desc: `Split from ${sourceId} (${split.qty})`,
        val,
      });
      bindNewInventoryEntity(
        state,
        split.newId,
        val,
        action.type,
        (action as any).id,
      );
    });

    // 3. Cleanup Source Item if empty
    if (sourceItem.qty <= 0) {
      closeInventoryEntityKey(state, sourceId, val, action.type);
      delete state.idToItem[sourceId];
      if (state.costLedger) delete state.costLedger[sourceId];
    }
  });

  r.addCase(bulk_import_items, (state, action) => {
    const updates = action.payload.items;
    const timestamp = (action as any).timestamp;

    updates.forEach((update) => {
      applyInventoryUpdate(
        state,
        update.id,
        update.item,
        timestamp,
        action.type,
        (action as any).id,
        update.stockOrder,
      );
    });
  });
});
