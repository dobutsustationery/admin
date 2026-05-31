import { combineReducers } from "@reduxjs/toolkit";
import { history } from "./history";
import {
  inventory,
  bulk_import_items,
  type BulkImportItem,
  type Item,
  update_field,
  update_fields,
  new_order,
  package_item,
  split_inventory_item,
  fix_jancode,
  set_stock_order_meta,
  apply_stock_order_costs,
} from "./inventory";
import { names } from "./names";
import { photos, rename_jan_group } from "./photos-slice";
import {
  orderImport,
  computeOrderImportBatch,
  mark_items_done as markOrderDone,
} from "./order-import-slice";
import {
  shopifyImport,
  computeShopifyImportBatch,
  mark_items_done as markShopifyDone,
} from "./shopify-import-slice";
import {
  liveEventImport,
  computeLiveEventImportCommit,
  mark_rows_done as markLiveEventRowsDone,
} from "./live-event-import-slice";
import { computeStockOrderCostCommit } from "./order-exceptions";
import {
  listings,
  add_listing_image,
  create_listing,
  update_listing,
} from "./listings-slice";
import {
  shopifySync,
  replace_shopify_sync_events as replaceShopifySyncEvents,
} from "./shopify-sync-slice";
import { shopifyCatalog } from "./shopify-catalog-slice";
import { syncQueue } from "./sync-queue-slice";
import listingCreation, {
  add_variants_internal,
  add_proposals_internal,
  findListingVariantByIdentity,
  update_variant_value,
  update_variant_qty,
  set_variant_photo_group,
  remove_proposal,
  remove_variant_requested,
  complete_batch,
} from "./listing-creation-slice";
import { ui } from "./ui-slice";
import { logAction } from "./devtools-middleware";
import { generateHandle } from "./handle-utils";
import { buildDraftListingImages } from "./listing-image-logic";
import { canonicalizeInventoryItemKey, makeInventoryItemKey } from "./sku";
import { CURRENT_SCHEMA_VERSION } from "./schema-version";
import {
  keyAudit,
  key_audit_observe_canonical,
  key_audit_record_ghost_access,
  key_audit_register_ghost,
} from "./key-audit-slice";
import {
  normalizeTimestampedAction,
  toTimestampMs,
  withInheritedTimestamp,
  type TimestampedAction,
} from "./timestamped-action";
import { normalizeShopifySyncEventType } from "./sync-events";

const reducerObject = {
  names,
  inventory,
  history,
  photos,
  orderImport,
  shopifyImport,
  liveEventImport,
  listings,
  shopifySync,
  shopifyCatalog,
  syncQueue,
  listingCreation,
  ui,
  keyAudit,
  schemaVersion: (state: number = CURRENT_SCHEMA_VERSION) =>
    state || CURRENT_SCHEMA_VERSION,
};
const combinedReducer = combineReducers(reducerObject);

export { toTimestampMs };

const normalizeActionTimestampMs = (action: TimestampedAction): number =>
  action._timestamp;

const keepLatestTimestamp = (
  currentTimestampMs: number,
  nextTimestampMs: number,
): number =>
  Math.max(Number(currentTimestampMs || 0), Number(nextTimestampMs || 0));

const getIncomingIdObservations = (
  action: any,
): Array<{
  actionPath: string;
  incomingId: string;
}> => {
  const p = action?.payload || {};
  const observations: Array<{ actionPath: string; incomingId: string }> = [];
  const maybePush = (actionPath: string, rawValue: any) => {
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (value) observations.push({ actionPath, incomingId: value });
  };

  switch (action?.type) {
    case "update_field":
    case "update_item":
      maybePush("payload.id", p.id);
      break;
    case "package_item":
    case "quantify_item":
    case "retype_item":
    case "rename_subtype":
    case "replace_subtype":
    case "fix_jancode":
      maybePush("payload.itemKey", p.itemKey);
      maybePush("payload.sourceKey", p.sourceKey);
      maybePush("payload.targetKey", p.targetKey);
      break;
    case "split_inventory_item":
      maybePush("payload.sourceId", p.sourceId);
      break;
    case "listingCreation/remove_variant_requested":
      maybePush("payload.itemId", p.itemId);
      break;
  }

  return observations;
};

const applyKeyAuditInstrumentation = (
  state: any,
  action: any,
  nextState: any,
) => {
  let nextKeyAudit = nextState.keyAudit;
  const atMs = normalizeActionTimestampMs(action);
  const priorInventory = state?.inventory?.idToItem || {};
  const nextInventory = nextState?.inventory?.idToItem || {};
  const priorGhostMap = state?.keyAudit?.ghostMap || {};

  // 1) Global canonicalization observation and collision detection
  const observations = getIncomingIdObservations(action);
  observations.forEach(({ incomingId }) => {
    const canonicalId = canonicalizeInventoryItemKey(incomingId);
    nextKeyAudit = keyAudit(
      nextKeyAudit,
      key_audit_observe_canonical({
        atMs,
        actionType: action.type,
        incomingId,
        canonicalId,
      }),
    );
  });

  // 2) Track would-be ghost IDs when subtype rename re-keys old -> new and old key disappears
  const maybeItemRekey =
    action?.type === "rename_subtype" ||
    action?.type === "replace_subtype" ||
    action?.type === "fix_jancode" ||
    (action?.type === "update_field" && action?.payload?.field === "subtype");
  if (maybeItemRekey) {
    const oldId =
      action?.type === "rename_subtype" || action?.type === "fix_jancode"
        ? action?.payload?.itemKey
        : action?.type === "replace_subtype"
          ? action?.payload?.sourceKey
          : action?.payload?.id;
    const oldItem = oldId ? priorInventory[oldId] : undefined;
    if (oldItem) {
      const newSubtype =
        action?.type === "rename_subtype"
          ? (action?.payload?.subtype || "").trim()
          : action?.type === "replace_subtype"
            ? (priorInventory[action?.payload?.targetKey]?.subtype || "").trim()
            : action?.type === "fix_jancode"
              ? (
                  action?.payload?.subtype ??
                  action?.payload?.newSubtype ??
                  oldItem.subtype
                )
                  .toString()
                  .trim()
              : (action?.payload?.to || "").trim();
      const newJanCode =
        action?.type === "fix_jancode"
          ? String(action?.payload?.newJanCode || oldItem.janCode)
              .trim()
              .replace(/\s+/g, "")
          : action?.type === "replace_subtype"
            ? String(
                priorInventory[action?.payload?.targetKey]?.janCode ||
                  oldItem.janCode,
              )
                .trim()
                .replace(/\s+/g, "")
            : oldItem.janCode;
      const canonicalId = makeInventoryItemKey(newJanCode, newSubtype);
      const oldMissingAfter = oldId && !nextInventory[oldId];
      const newExistsAfter = !!nextInventory[canonicalId];
      if (
        oldId &&
        canonicalId &&
        oldId !== canonicalId &&
        oldMissingAfter &&
        newExistsAfter
      ) {
        nextKeyAudit = keyAudit(
          nextKeyAudit,
          key_audit_register_ghost({
            ghostId: oldId,
            canonicalId,
            janCode: oldItem.janCode || "",
            oldSubtype: oldItem.subtype || "",
            newSubtype,
            renamedAtMs: atMs,
            renamedByActionType: action.type,
          }),
        );
      }
    }
  }

  // 3) Record ghost access attempts (read/write intents against stale IDs)
  observations.forEach(({ actionPath, incomingId }) => {
    const canonicalCandidate = canonicalizeInventoryItemKey(incomingId);
    const knownGhost = !!priorGhostMap[incomingId];
    const mappedCanonicalId = priorGhostMap[incomingId]?.canonicalId;
    const hasRaw = !!priorInventory[incomingId];
    const hasCanonical = !!priorInventory[canonicalCandidate];
    const isPotentialGhostAccess =
      knownGhost ||
      (!hasRaw && (incomingId !== canonicalCandidate || hasCanonical));

    if (!isPotentialGhostAccess) return;

    const outcome = hasRaw
      ? "found_raw"
      : hasCanonical
        ? "found_under_canonical"
        : "missing";
    const eventId = [
      String(atMs),
      action.type,
      actionPath,
      incomingId,
      canonicalCandidate,
    ].join("|");

    nextKeyAudit = keyAudit(
      nextKeyAudit,
      key_audit_record_ghost_access({
        id: eventId,
        atMs,
        actionType: action.type,
        actionPath,
        requestedId: incomingId,
        canonicalCandidate,
        knownGhost,
        mappedCanonicalId,
        outcome,
      }),
    );
  });

  return { ...nextState, keyAudit: nextKeyAudit };
};

// When applyInventoryUpdate redirects a bare-JAN import write to its
// canonical (jan+subtype) key and migrates the inventory row, the
// listings.idToHandle map and photos.janCodeToPhotos groups still point
// at the stale bare-JAN key (they live in other slices the inventory
// reducer cannot touch). Mirror the rename_subtype cross-slice
// orchestration for each such re-key. See
// docs/investigations/REPLAY_CONSOLE_ERRORS.md.
const reconcileImportItemRekeys = (
  nextState: any,
  items: Array<{ id?: string; item?: any }>,
  logger: any,
  ts: number,
): any => {
  if (!Array.isArray(items) || items.length === 0) return nextState;
  for (const entry of items) {
    const rawId = (entry?.id || "").toString().trim();
    const jan = entry?.item?.janCode;
    const subtype = (entry?.item?.subtype || "").toString().trim();
    if (!rawId || !jan || !subtype) continue;
    const newKey = makeInventoryItemKey(jan, subtype);
    if (rawId === newKey) continue;

    // 1. listings.idToHandle
    const handle = nextState.listings?.idToHandle?.[rawId];
    if (handle) {
      const listingState = nextState.listings;
      const nextIdToHandle = { ...listingState.idToHandle, [newKey]: handle };
      delete nextIdToHandle[rawId];
      nextState = {
        ...nextState,
        listings: { ...listingState, idToHandle: nextIdToHandle },
      };
    }

    // 2. photos.janCodeToPhotos
    const photoCandidates = [rawId, `${jan}:`, jan];
    const found = photoCandidates.find(
      (c) => nextState.photos?.janCodeToPhotos?.[c],
    );
    const newPhotoKey = `${jan}:${subtype}`;
    if (found && found !== newPhotoKey) {
      const photosState = nextState.photos;
      const nextJanCodeToPhotos = { ...photosState.janCodeToPhotos };
      const groupPhotos = nextJanCodeToPhotos[found] || [];
      if (groupPhotos.length > 0) {
        if (!nextJanCodeToPhotos[newPhotoKey]) {
          nextJanCodeToPhotos[newPhotoKey] = [];
        }
        nextJanCodeToPhotos[newPhotoKey] = [
          ...nextJanCodeToPhotos[newPhotoKey],
          ...groupPhotos,
        ];
        delete nextJanCodeToPhotos[found];
        nextState = {
          ...nextState,
          photos: { ...photosState, janCodeToPhotos: nextJanCodeToPhotos },
        };
        logger(
          {
            type: "photos/rename_jan_group (synthetic)",
            payload: { oldJan: found, newJan: newPhotoKey },
            _ephemeral: true,
          },
          nextState,
          ts,
        );
      }
    }
  }
  return nextState;
};

// Helper to map Order Import Item to Inventory Item
const mapOrderToInventory = (importItem: any): Item => {
  return {
    janCode: importItem.janCode,
    subtype: "",
    description: importItem.description,
    hsCode: importItem.hsCode || "",
    image: "",
    qty: importItem.qty,
    pieces: 1,
    shipped: 0,
    creationDate: "Unknown",
    timestamp: 0,
    price: importItem.price,
    // Order-import parses supplier cost from the CSV (unit price (yen)),
    // but this mapper previously dropped it, so every order-import-created
    // item lost its cost — the largest SKU-review COST-exception
    // bucket. See docs/investigations/COST_EXCEPTIONS.md.
    cost: importItem.cost,
    weight: importItem.weight,
    countryOfOrigin: importItem.countryOfOrigin,
  };
};

// Helper to map Shopify Import Item to Inventory Item
const mapShopifyToInventory = (importItem: any): Item => {
  return {
    janCode: importItem.janCode,
    subtype: "",
    description: importItem.description,
    hsCode: "",
    image: importItem.image || "",
    qty: importItem.qty,
    pieces: 1,
    shipped: 0,
    creationDate: "Unknown",
    timestamp: 0,
    price: importItem.price,
    weight: importItem.weight,
    handle: importItem.handle,
    ...importItem,
  } as Item;
};

const trimString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const isShopifyCdnUrl = (value: string): boolean =>
  value.includes("cdn.shopify.com");

// These three are pure string->string transforms but each runs a
// `new URL()` parse. During a full replay the photos/shopify_cdn_uploaded
// handler calls them on every inventory item image and every listing
// image on every action, re-parsing the same URLs ~10^6 times (see
// docs/investigations/REPLAY_PERFORMANCE.md). Memoize on the raw input
// string: same input always yields the same output, so the cache cannot
// change behavior. A bounded cap prevents unbounded growth in the
// long-lived app (replay distinct-URL counts are well under the cap).
const SHOPIFY_URL_MEMO_CAP = 50_000;
const memoizeStringFn = (
  fn: (raw: string) => string,
): ((raw: string) => string) => {
  const cache = new Map<string, string>();
  return (raw: string): string => {
    const key = typeof raw === "string" ? raw : "";
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const out = fn(raw);
    if (cache.size >= SHOPIFY_URL_MEMO_CAP) cache.clear();
    cache.set(key, out);
    return out;
  };
};

const canonicalizeShopifyCdnUrl = memoizeStringFn((raw: string): string => {
  const value = trimString(raw);
  if (!value) return "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (_) {
    return value;
  }
  if (!parsed.hostname.toLowerCase().includes("cdn.shopify.com")) return value;

  // Normalize repeated slashes in path and preserve search params order as-is.
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");
  return parsed.toString();
});

const toDeletedShopifyPathVariant = memoizeStringFn(
  (rawUrl: string): string => {
    const value = trimString(rawUrl);
    if (!value) return "";
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch (_) {
      return "";
    }
    if (!parsed.hostname.toLowerCase().includes("cdn.shopify.com")) return "";
    const normalizedPath = parsed.pathname.replace(/\/{2,}/g, "/");
    const nextPath = normalizedPath.replace(
      /^(\/s\/files\/(?:[^/]+\/){4})(?:deleted\/)?files\//i,
      "$1deleted/files/",
    );
    if (nextPath === normalizedPath) return "";
    parsed.pathname = nextPath.replace(/\/{2,}/g, "/");
    return parsed.toString();
  },
);

const toNonDeletedShopifyPathVariant = memoizeStringFn(
  (rawUrl: string): string => {
    const value = trimString(rawUrl);
    if (!value) return "";
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch (_) {
      return "";
    }
    if (!parsed.hostname.toLowerCase().includes("cdn.shopify.com")) return "";
    const nextPath = parsed.pathname.replace(
      /^(\/s\/files\/(?:[^/]+\/){4})deleted\/files\//i,
      "$1files/",
    );
    if (nextPath === parsed.pathname) return "";
    parsed.pathname = nextPath.replace(/\/{2,}/g, "/");
    return parsed.toString();
  },
);

// Root reducer to handle full state hydration and Event Sourcing Orchestration
export const rootReducer = (
  state: any,
  incomingAction: any,
  logger = logAction,
) => {
  const action = normalizeTimestampedAction(incomingAction);
  const inheritTimestamp = <T extends Record<string, unknown>>(a: T) =>
    withInheritedTimestamp(a, action);

  if (action.type === "HYDRATE") {
    const hydratedState = { ...state, ...action.payload };

    // Schema Version Validation:
    // If the hydrated state has an outdated schema version (or none),
    // discard it and return the current state (initial) to force a full replay.
    if (hydratedState.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      console.warn(
        `[Hydrate] Schema mismatch (Expected: ${CURRENT_SCHEMA_VERSION}, Found: ${hydratedState.schemaVersion}). Discarding snapshot and forcing replay.`,
      );
      return state;
    }

    return hydratedState;
  }

  // 1. Standard Reducer Execution
  let nextState: any = combinedReducer(state, action);

  // 2. Ensure schemaVersion is always present in the state
  if (nextState.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    nextState = { ...nextState, schemaVersion: CURRENT_SCHEMA_VERSION };
  }

  // 2.5 Key integrity observability (non-blocking, no behavior changes)
  nextState = applyKeyAuditInstrumentation(state, action, nextState);

  // 2.6 Direct update_item / bulk_import_items can also trigger the
  // bare-JAN -> canonical inventory re-key inside applyInventoryUpdate;
  // mirror the cross-slice (idToHandle / photo group) migration.
  if (action.type === "update_item" && action.payload) {
    nextState = reconcileImportItemRekeys(
      nextState,
      [{ id: action.payload.id, item: action.payload.item }],
      logger,
      action._timestamp,
    );
  } else if (
    action.type === "bulk_import_items" &&
    Array.isArray(action.payload?.items)
  ) {
    nextState = reconcileImportItemRekeys(
      nextState,
      action.payload.items,
      logger,
      action._timestamp,
    );
  }

  // 3. Interception & Composition

  if (
    action.type === replaceShopifySyncEvents.type &&
    Array.isArray(action.payload) &&
    action.payload.length > 0
  ) {
    const listingState = nextState.listings;
    const nextHandleToListing = { ...listingState.handleToListing };
    let changed = false;

    for (const ev of action.payload) {
      const normalizedEventType = normalizeShopifySyncEventType(
        String(ev?.eventType || ""),
      );
      if (normalizedEventType !== "sync_completed") continue;

      const handle = String(ev?.handle || "").trim();
      if (!handle) continue;

      const completedAtMs = toTimestampMs(ev?.timestamp);
      if (!completedAtMs) continue;

      const listing = nextHandleToListing[handle];
      if (!listing) continue;

      if (completedAtMs > Number(listing.lastUpdated || 0)) {
        nextHandleToListing[handle] = {
          ...listing,
          lastUpdated: completedAtMs,
        };
        changed = true;
      }
    }

    if (changed) {
      nextState = {
        ...nextState,
        listings: {
          ...listingState,
          handleToListing: nextHandleToListing,
        },
      };
    }
  }

  if (action.type === "photos/shopify_cdn_uploaded") {
    const permanentUrl = trimString(action.payload?.permanentUrl);
    const rawCandidates = [
      trimString(action.payload?.sourceBaseUrl),
      trimString(action.payload?.sourceUrl),
    ].filter((url) => isShopifyCdnUrl(url));

    const sourceCandidates = Array.from(
      new Set(
        rawCandidates.flatMap((url) => [
          url,
          canonicalizeShopifyCdnUrl(url),
          toDeletedShopifyPathVariant(url),
          toNonDeletedShopifyPathVariant(url),
        ]),
      ),
    ).filter(Boolean);

    if (permanentUrl && sourceCandidates.length > 0) {
      const sourceSet = new Set(
        sourceCandidates.map((url) => canonicalizeShopifyCdnUrl(url)),
      );
      let inventoryChanged = false;
      let mapChanged = false;
      let listingsChanged = false;

      const inventoryState = nextState.inventory;
      const nextIdToItem: Record<string, any> = { ...inventoryState.idToItem };
      const nextShopifyUrlToDriveUrl = {
        ...(inventoryState.shopifyUrlToDriveUrl || {}),
      };

      Object.entries(nextIdToItem).forEach(([id, raw]) => {
        const item = raw as any;
        const currentImage = trimString(item?.image);
        if (!sourceSet.has(canonicalizeShopifyCdnUrl(currentImage))) return;
        if (currentImage !== permanentUrl) {
          nextIdToItem[id] = { ...item, image: permanentUrl };
          inventoryChanged = true;
        }
      });

      sourceCandidates.forEach((sourceUrl) => {
        if (nextShopifyUrlToDriveUrl[sourceUrl] === permanentUrl) return;
        nextShopifyUrlToDriveUrl[sourceUrl] = permanentUrl;
        mapChanged = true;
      });

      const listingsState = nextState.listings;
      const nextHandleToListing = { ...listingsState.handleToListing };

      Object.entries(nextHandleToListing).forEach(([handle, listingRaw]) => {
        const listing = listingRaw as any;
        const existingImages = Array.isArray(listing?.images)
          ? listing.images
          : [];
        if (existingImages.length === 0) return;

        let listingChanged = false;
        const seenUrls = new Set<string>();
        const nextImages: any[] = [];

        existingImages.forEach((img: any) => {
          const currentUrl = trimString(img?.url);
          const currentId = trimString(img?.id);
          let nextUrl = currentUrl;
          let nextId = currentId;

          if (
            sourceSet.has(canonicalizeShopifyCdnUrl(currentUrl)) &&
            currentUrl !== permanentUrl
          ) {
            nextUrl = permanentUrl;
            if (
              currentId === currentUrl ||
              sourceSet.has(canonicalizeShopifyCdnUrl(currentId))
            ) {
              nextId = permanentUrl;
            }
            listingChanged = true;
          }

          if (!seenUrls.has(nextUrl)) {
            seenUrls.add(nextUrl);
            nextImages.push(
              nextUrl === currentUrl && nextId === currentId
                ? img
                : { ...img, url: nextUrl, id: nextId || nextUrl },
            );
          } else {
            listingChanged = true;
          }
        });

        if (listingChanged) {
          nextHandleToListing[handle] = {
            ...listing,
            images: nextImages,
            lastUpdated: keepLatestTimestamp(
              listing.lastUpdated,
              normalizeActionTimestampMs(action),
            ),
          };
          listingsChanged = true;
        }
      });

      if (inventoryChanged || mapChanged) {
        nextState = {
          ...nextState,
          inventory: {
            ...inventoryState,
            idToItem: nextIdToItem,
            shopifyUrlToDriveUrl: nextShopifyUrlToDriveUrl,
          },
        };
      }

      if (listingsChanged) {
        nextState = {
          ...nextState,
          listings: {
            ...nextState.listings,
            handleToListing: nextHandleToListing,
          },
        };
      }
    }
  }

  // Synchronize Listings idToHandle and Photo Groups when item keys change
  const isRetype = action.type === "retype_item";
  const isRename = action.type === "rename_subtype";
  const isReplaceSubtype = action.type === "replace_subtype";
  const isFixJanCode = action.type === "fix_jancode";
  const isSubtypeUpdate =
    action.type === "update_field" && action.payload.field === "subtype";
  const isVariantValueUpdate =
    action.type === "listingCreation/update_variant_value";

  if (
    isRetype ||
    isRename ||
    isReplaceSubtype ||
    isFixJanCode ||
    isSubtypeUpdate ||
    isVariantValueUpdate
  ) {
    let oldItemId = "";
    let newItemId = "";
    let oldBaseJan = "";
    let newBaseJan = "";
    let oldSubtype = "";
    let newSubtype = "";

    if (isRetype) {
      const { itemKey, janCode, subtype } = action.payload;
      oldItemId = itemKey;
      newBaseJan = janCode;
      newSubtype = subtype?.trim() || "";
      newItemId = makeInventoryItemKey(newBaseJan, newSubtype);
      const oldItem = state.inventory.idToItem[oldItemId];
      if (oldItem) {
        oldBaseJan = oldItem.janCode;
        oldSubtype = oldItem.subtype;
      }
    } else if (isRename) {
      const { itemKey, subtype } = action.payload;
      oldItemId = itemKey;
      newSubtype = subtype?.trim() || "";
      const oldItem = state.inventory.idToItem[oldItemId];
      if (oldItem) {
        oldBaseJan = oldItem.janCode;
        newBaseJan = oldBaseJan;
        oldSubtype = oldItem.subtype;
        newItemId = makeInventoryItemKey(newBaseJan, newSubtype);
      }
    } else if (isReplaceSubtype) {
      const { sourceKey, targetKey } = action.payload;
      oldItemId = sourceKey;
      newItemId = targetKey;
      const oldItem = state.inventory.idToItem[oldItemId];
      const newItem = state.inventory.idToItem[newItemId];
      if (oldItem && newItem) {
        oldBaseJan = oldItem.janCode;
        oldSubtype = oldItem.subtype;
        newBaseJan = newItem.janCode;
        newSubtype = newItem.subtype;
      }
    } else if (isSubtypeUpdate) {
      const { id: itemKey, to: subtype } = action.payload;
      oldItemId = itemKey;
      newSubtype = (subtype as string)?.trim() || "";
      const oldItem = state.inventory.idToItem[oldItemId];
      if (oldItem) {
        oldBaseJan = oldItem.janCode;
        newBaseJan = oldBaseJan;
        oldSubtype = oldItem.subtype;
        newItemId = makeInventoryItemKey(newBaseJan, newSubtype);
      }
    } else if (isFixJanCode) {
      const { itemKey, newJanCode, subtype } = action.payload;
      oldItemId = itemKey;
      const oldItem = state.inventory.idToItem[oldItemId];
      if (oldItem) {
        oldBaseJan = oldItem.janCode;
        oldSubtype = oldItem.subtype;
        newBaseJan = String(newJanCode || "")
          .trim()
          .replace(/\s+/g, "");
        newSubtype = (subtype ?? oldSubtype ?? "").trim();
        newItemId = makeInventoryItemKey(newBaseJan, newSubtype);
      }
    }

    if (oldItemId && newItemId && oldItemId !== newItemId) {
      // 1. Sync idToHandle (Listings)
      const handle = state.listings.idToHandle[oldItemId];
      if (handle) {
        const listingState = nextState.listings;
        const nextIdToHandle = {
          ...listingState.idToHandle,
          [newItemId]: handle,
        };
        delete nextIdToHandle[oldItemId];
        nextState = {
          ...nextState,
          listings: { ...listingState, idToHandle: nextIdToHandle },
        };
      }

      // 2. Sync Photo Groups (Photos)
      // Try OldItemID first, then OldBaseJan:OldSubtype
      const candidates = [oldItemId, `${oldBaseJan}:${oldSubtype}`];
      const found = candidates.find((c) => state.photos.janCodeToPhotos[c]);
      if (found) {
        const newPhotoKey = newSubtype
          ? `${newBaseJan}:${newSubtype}`
          : newBaseJan;
        if (found !== newPhotoKey) {
          console.log(
            `[RootReducer] Orchestrating photo group rename: ${found} -> ${newPhotoKey}`,
          );

          // Update Photos State immutably
          const photosState = nextState.photos;
          const nextJanCodeToPhotos = { ...photosState.janCodeToPhotos };
          const groupPhotos = nextJanCodeToPhotos[found] || [];

          if (groupPhotos.length > 0) {
            if (!nextJanCodeToPhotos[newPhotoKey]) {
              nextJanCodeToPhotos[newPhotoKey] = [];
            }
            nextJanCodeToPhotos[newPhotoKey] = [
              ...nextJanCodeToPhotos[newPhotoKey],
              ...groupPhotos,
            ];
            delete nextJanCodeToPhotos[found];

            nextState = {
              ...nextState,
              photos: {
                ...photosState,
                janCodeToPhotos: nextJanCodeToPhotos,
              },
            };

            // Log a synthetic action for clarity in devtools
            logger(
              {
                type: "photos/rename_jan_group (synthetic)",
                payload: { oldJan: found, newJan: newPhotoKey },
                _ephemeral: true,
              },
              nextState,
              action._timestamp,
            );
          }
        }
      }
    }

    if (isFixJanCode && oldItemId && newItemId && oldItemId !== newItemId) {
      const oldJanBaseKey = oldBaseJan;
      const oldJanSubtypeKey = oldSubtype
        ? `${oldBaseJan}:${oldSubtype}`
        : oldBaseJan;
      const newJanBaseKey = newBaseJan;
      const newJanSubtypeKey = newSubtype
        ? `${newBaseJan}:${newSubtype}`
        : newBaseJan;

      const remapPhotoGroupKey = (key: string): string => {
        if (!key) return key;
        if (key === oldJanSubtypeKey) return newJanSubtypeKey;
        if (key === oldJanBaseKey) return newJanBaseKey;
        return key;
      };

      // 3) Listing Creation re-key migration (itemId, proposal key, photo group refs)
      const creationState = nextState.listingCreation;
      const nextProposals: Record<string, any> = {};

      const mergeProposals = (target: any, source: any) => {
        const mergedInventoryIds = Array.from(
          new Set([
            ...(target.inventoryItemIds || []),
            ...(source.inventoryItemIds || []),
          ]),
        );
        const mergedPhotoGroupIds = Array.from(
          new Set([
            ...(target.photoGroupIds || []),
            ...(source.photoGroupIds || []),
          ]),
        );
        const variantById = new Map<string, any>();
        [...(target.variants || []), ...(source.variants || [])].forEach((v) =>
          variantById.set(v.id, v),
        );
        return {
          ...target,
          ...source,
          inventoryItemIds: mergedInventoryIds,
          photoGroupIds: mergedPhotoGroupIds,
          variants: Array.from(variantById.values()),
        };
      };

      Object.entries(creationState.proposals || {}).forEach(
        ([key, proposalRaw]) => {
          const proposal = proposalRaw as any;
          let nextKey = remapPhotoGroupKey(key);
          const nextInventoryItemIds = (proposal.inventoryItemIds || []).map(
            (id: string) => (id === oldItemId ? newItemId : id),
          );
          const nextVariants = (proposal.variants || []).map((v: any) => ({
            ...v,
            itemId: v.itemId === oldItemId ? newItemId : v.itemId,
            photoGroupKey: v.photoGroupKey
              ? remapPhotoGroupKey(v.photoGroupKey)
              : v.photoGroupKey,
          }));
          const nextPhotoGroupIds = (proposal.photoGroupIds || []).map(
            (id: string) => remapPhotoGroupKey(id),
          );
          const nextJanCode = remapPhotoGroupKey(proposal.janCode || "");
          const nextProposal = {
            ...proposal,
            janCode: nextJanCode,
            inventoryItemIds: Array.from(new Set(nextInventoryItemIds)),
            variants: nextVariants,
            photoGroupIds: Array.from(new Set(nextPhotoGroupIds)),
          };

          if (nextProposals[nextKey]) {
            nextProposals[nextKey] = mergeProposals(
              nextProposals[nextKey],
              nextProposal,
            );
          } else {
            nextProposals[nextKey] = nextProposal;
          }
        },
      );

      const nextActiveBatchJans = Array.from(
        new Set((creationState.activeBatchJans || []).map(remapPhotoGroupKey)),
      );
      const nextOriginalBatchJans = Array.from(
        new Set(
          (creationState.originalBatchJans || []).map(remapPhotoGroupKey),
        ),
      );

      nextState = {
        ...nextState,
        listingCreation: {
          ...creationState,
          proposals: nextProposals,
          activeBatchJans: nextActiveBatchJans,
          originalBatchJans: nextOriginalBatchJans,
        },
      };

      // 4) Import resolution key migration
      const migrateOrderResolution = (resolution: any) => {
        if (!resolution) return resolution;
        if (resolution.type === "split" && resolution.allocations) {
          const nextAllocations: Record<string, number> = {};
          Object.entries(resolution.allocations).forEach(([k, qty]) => {
            const mapped = k === oldItemId ? newItemId : k;
            nextAllocations[mapped] =
              (nextAllocations[mapped] || 0) + Number(qty || 0);
          });
          return { ...resolution, allocations: nextAllocations };
        }
        if (
          resolution.type === "data_mismatch" &&
          resolution.itemKey === oldItemId
        ) {
          return { ...resolution, itemKey: newItemId };
        }
        return resolution;
      };

      const nextOrderResolutions: Record<string, any> = {};
      Object.entries(nextState.orderImport?.resolutions || {}).forEach(
        ([idx, res]) => {
          nextOrderResolutions[idx] = migrateOrderResolution(res);
        },
      );

      const nextShopifyResolutions: Record<string, any[]> = {};
      Object.entries(nextState.shopifyImport?.resolutions || {}).forEach(
        ([idx, actions]) => {
          nextShopifyResolutions[idx] = (actions as any[]).map((a) => {
            if (a?.payload?.itemKey === oldItemId) {
              return { ...a, payload: { ...a.payload, itemKey: newItemId } };
            }
            return a;
          });
        },
      );

      nextState = {
        ...nextState,
        orderImport: {
          ...nextState.orderImport,
          resolutions: nextOrderResolutions,
        },
        shopifyImport: {
          ...nextState.shopifyImport,
          resolutions: nextShopifyResolutions,
        },
      };
    }

    // Handle variant value update separately (Listing Creation)
    if (isVariantValueUpdate) {
      const { janCode, variantId, value } = action.payload;
      const proposal = state.listingCreation.proposals[janCode];
      if (proposal) {
        const variant = findListingVariantByIdentity(proposal, variantId);
        if (variant && variant.photoGroupKey) {
          const oldPhotoKey = variant.photoGroupKey;
          const cleanSubtype = value?.trim() || "";
          // Use the JAN from the OLD photo key to support merged proposals with multiple JANs
          const baseJan = oldPhotoKey.split(":")[0];
          const newPhotoKey = cleanSubtype
            ? `${baseJan}:${cleanSubtype}`
            : baseJan;

          if (
            state.photos.janCodeToPhotos[oldPhotoKey] &&
            oldPhotoKey !== newPhotoKey
          ) {
            // 1. Rename the actual photo group
            const photosState = nextState.photos;
            const nextJanCodeToPhotos = { ...photosState.janCodeToPhotos };
            const groupPhotos = nextJanCodeToPhotos[oldPhotoKey] || [];

            if (groupPhotos.length > 0) {
              if (!nextJanCodeToPhotos[newPhotoKey]) {
                nextJanCodeToPhotos[newPhotoKey] = [];
              }
              nextJanCodeToPhotos[newPhotoKey] = [
                ...nextJanCodeToPhotos[newPhotoKey],
                ...groupPhotos,
              ];
              delete nextJanCodeToPhotos[oldPhotoKey];

              nextState = {
                ...nextState,
                photos: {
                  ...photosState,
                  janCodeToPhotos: nextJanCodeToPhotos,
                },
              };

              // Log synthetic action
              logger(
                inheritTimestamp({
                  type: "photos/rename_jan_group (synthetic)",
                  payload: { oldJan: oldPhotoKey, newJan: newPhotoKey },
                  _ephemeral: true,
                }),
                nextState,
                action._timestamp,
              );
            }

            // 2. Update the variant's photoGroupKey reference
            const creationAction = inheritTimestamp(
              set_variant_photo_group({
                janCode,
                variantId,
                groupKey: newPhotoKey,
              }),
            );
            nextState = {
              ...nextState,
              listingCreation: listingCreation(
                nextState.listingCreation,
                creationAction,
              ),
            };
            logger(creationAction, nextState, action._timestamp);
          }
        }
      }
    }
  }

  // Order Import Interceptor (Event Sourcing Logic)
  if (action.type === "orderImport/import_batch") {
    const { filter, options } = action.payload;
    console.log(
      `[RootReducer] Intercepting Order Import Batch { filter: '${filter}' }`,
    );

    const { updates, indices } = computeOrderImportBatch(
      nextState.orderImport,
      nextState.inventory.idToItem,
      filter,
    );

    const orderId =
      nextState.orderImport.activeFile?.id ||
      nextState.orderImport.activeFile?.name ||
      "unknown-stock-order";
    const usesZeroedQuantities = nextState.orderImport.rows.some((row: any) => {
      const parsed = row.parsed;
      if (!parsed) return false;
      return !(Number(parsed.qty) > 0) && Number(parsed.orderedQty) > 0;
    });
    // Auto-register the stock order so the exceptions UI can enumerate
    // it without scanning the action log. Idempotent; metadata only.
    const existingOrderMeta = nextState.inventory.stockOrderRegistry?.[orderId];
    if (
      !existingOrderMeta ||
      existingOrderMeta.usesZeroedQuantities !== usesZeroedQuantities
    ) {
      const registerAction = inheritTimestamp({
        ...set_stock_order_meta({
          orderId,
          meta: {
            name: nextState.orderImport.activeFile?.name || orderId,
            usesZeroedQuantities,
          },
        }),
        _ephemeral: true,
      });
      nextState = {
        ...nextState,
        inventory: inventory(nextState.inventory, registerAction),
      };
      logger(registerAction, nextState, action._timestamp);
    }
    const bulkUpdates: BulkImportItem[] = updates.map((u) => {
      const item = u.type === "new" ? mapOrderToInventory(u.item) : u.item;
      return {
        type: u.type,
        id: u.id,
        item,
        stockOrder: {
          orderId,
          orderedQty:
            Number((u as any).orderedQty ?? (u.item as any).orderedQty) > 0
              ? Number((u as any).orderedQty ?? (u.item as any).orderedQty)
              : undefined,
        },
      };
    });

    if (bulkUpdates.length > 0) {
      const internalAction = inheritTimestamp({
        ...bulk_import_items({ items: bulkUpdates }),
        _ephemeral: true,
      });

      nextState = {
        ...nextState,
        inventory: inventory(nextState.inventory, internalAction),
      };
      logger(internalAction, nextState, action._timestamp); // LOG SUB-ACTION
      nextState = reconcileImportItemRekeys(
        nextState,
        bulkUpdates,
        logger,
        action._timestamp,
      );
    }

    if (indices.length > 0) {
      const markAction = inheritTimestamp(markOrderDone({ indices }));
      nextState = {
        ...nextState,
        orderImport: orderImport(nextState.orderImport, markAction),
      };
      logger(markAction, nextState, action._timestamp); // LOG SUB-ACTION
    }
  }

  // Intercept update_field for cross-domain orchestration (Sync Titles/Descriptions)
  if (action.type === "update_field") {
    const { id, field, to } = action.payload;

    // A) If HANDLE changed on an ITEM, sync its description to the listing title
    if (field === "handle" && to) {
      const listing = nextState.listings.handleToListing[to as string];
      if (listing) {
        const item = nextState.inventory.idToItem[id];
        if (item && item.description !== listing.title) {
          const syncAction = inheritTimestamp({
            ...update_field({
              id,
              field: "description",
              from: item.description,
              to: listing.title,
            }),
            _ephemeral: true,
          });
          nextState = {
            ...nextState,
            inventory: inventory(nextState.inventory, syncAction),
          };
          logger(syncAction, nextState, action._timestamp);
        }
      }
    }

    // B) If DESCRIPTION changed on an ITEM, sync it to the listing title (and siblings)
    if (field === "description") {
      const handle = nextState.listings.idToHandle[id];
      if (handle) {
        const listing = nextState.listings.handleToListing[handle];
        if (listing) {
          // 1. Sync Listing Title (if not already synced by slice reducer)
          if (listing.title !== to) {
            const syncListingAction = inheritTimestamp({
              ...update_listing({ handle, changes: { title: to as string } }),
              _ephemeral: true,
            });
            nextState = {
              ...nextState,
              listings: listings(nextState.listings, syncListingAction),
            };
            logger(syncListingAction, nextState, action._timestamp);
          }

          // 2. Sync ALL Sibling Items (including original if needed, but here id is excluded for safety)
          Object.entries(nextState.inventory.idToItem).forEach(
            ([itemId, item]: any) => {
              if (itemId !== id && item.handle === handle) {
                if (item.description !== to) {
                  const syncItemAction = inheritTimestamp({
                    ...update_field({
                      id: itemId,
                      field: "description",
                      from: item.description,
                      to: to as string,
                    }),
                    _ephemeral: true,
                  });
                  nextState = {
                    ...nextState,
                    inventory: inventory(nextState.inventory, syncItemAction),
                  };
                  logger(syncItemAction, nextState, action._timestamp);
                }
              }
            },
          );
        }
      }
    }
  }

  // Intercept update_listing for cross-domain orchestration (Sync Titles to Items)
  if (action.type === "update_listing") {
    const { handle, changes } = action.payload;
    const title = changes.title;

    if (title) {
      // Find all items linked to this handle
      Object.entries(nextState.inventory.idToItem).forEach(
        ([id, item]: any) => {
          if (item.handle === handle) {
            if (item.description !== title) {
              const syncAction = inheritTimestamp({
                ...update_field({
                  id,
                  field: "description",
                  from: item.description,
                  to: title,
                }),
                _ephemeral: true,
              });
              nextState = {
                ...nextState,
                inventory: inventory(nextState.inventory, syncAction),
              };
              logger(syncAction, nextState, action._timestamp);
            }
          }
        },
      );
    }
  }

  // Shopify Import Batch
  if (action.type === "shopifyImport/import_batch" && state.shopifyImport) {
    const { filter, options } = action.payload;
    console.log(
      `[RootReducer] Intercepting Shopify Import Batch { filter: '${filter}' }`,
    );

    const { updates, listingUpdates, indices } = computeShopifyImportBatch(
      state.shopifyImport,
      state.inventory.idToItem,
      state.listings.handleToListing,
      filter,
      options,
      action._timestamp,
    );

    const bulkUpdates: BulkImportItem[] = updates.map((u) => ({
      type: u.type,
      id: u.id,
      item: u.type === "new" ? mapShopifyToInventory(u.item) : u.item,
    }));

    if (bulkUpdates.length > 0) {
      const internalAction = inheritTimestamp({
        ...bulk_import_items({ items: bulkUpdates }),
        _ephemeral: true,
      });

      nextState = {
        ...nextState,
        inventory: inventory(nextState.inventory, internalAction),
        listings: listings(nextState.listings, internalAction),
      };
      logger(internalAction, nextState, action._timestamp); // LOG SUB-ACTION
      nextState = reconcileImportItemRekeys(
        nextState,
        bulkUpdates,
        logger,
        action._timestamp,
      );
    }

    if (listingUpdates && listingUpdates.length > 0) {
      let nextListings = nextState.listings;
      listingUpdates.forEach((u: any) => {
        if (u.type === "add_image") {
          const internalAction = inheritTimestamp({
            ...add_listing_image({ handle: u.handle, image: u.image }),
            _ephemeral: true,
          });
          nextListings = listings(nextListings, internalAction);
          // We must update nextState.listings locally to pass to next iteration
          // but we also want to capture the full state for the log.
          const intermediateState = { ...nextState, listings: nextListings };
          logger(internalAction, intermediateState, action._timestamp); // LOG SUB-ACTION
        } else if (u.type === "create_listing") {
          const internalAction = inheritTimestamp({
            ...create_listing({ listing: u.listing }),
            _ephemeral: true,
          });
          nextListings = listings(nextListings, internalAction);
          const intermediateState = { ...nextState, listings: nextListings };
          logger(internalAction, intermediateState, action._timestamp); // LOG SUB-ACTION
        }
      });
      nextState = { ...nextState, listings: nextListings };
    }

    if (indices.length > 0) {
      const markAction = inheritTimestamp(markShopifyDone({ indices }));
      nextState = {
        ...nextState,
        shopifyImport: shopifyImport(nextState.shopifyImport, markAction),
      };
      logger(markAction, nextState, action._timestamp); // LOG SUB-ACTION
    }
  }

  // Live Event Sales Import
  if (
    action.type === "liveEventImport/commit_import" &&
    nextState.liveEventImport
  ) {
    const { lines, indices } = computeLiveEventImportCommit(
      nextState.liveEventImport,
      nextState.inventory.idToItem,
    );

    if (lines.length > 0) {
      const eventName =
        String(nextState.liveEventImport.eventName || "").trim() ||
        "Live Event";
      const eventSlug = eventName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const orderID = `live-event:${eventSlug || "manual"}:${action.id || action._timestamp}`;
      const enteredMs =
        action._timestamp || nextState.liveEventImport.pasteTimestampMs || 0;
      const enteredDate = new Date(enteredMs);
      const eventDate = nextState.liveEventImport.eventDate
        ? new Date(`${nextState.liveEventImport.eventDate}T00:00:00`)
        : undefined;

      const orderAction = inheritTimestamp({
        ...new_order({
          orderID,
          email: "live-event",
          product: eventName,
          date: enteredDate,
          eventDate,
        }),
        _ephemeral: true,
      });
      nextState = {
        ...nextState,
        inventory: inventory(nextState.inventory, orderAction),
      };
      logger(orderAction, nextState, action._timestamp);

      lines.forEach((line) => {
        const packageAction = inheritTimestamp({
          ...package_item({
            orderID,
            itemKey: line.itemKey as any,
            qty: line.qty,
          }),
          _ephemeral: true,
        });
        nextState = {
          ...nextState,
          inventory: inventory(nextState.inventory, packageAction),
        };
        logger(packageAction, nextState, action._timestamp);
      });
    }

    if (indices.length > 0) {
      const markAction = inheritTimestamp(markLiveEventRowsDone({ indices }));
      nextState = {
        ...nextState,
        liveEventImport: liveEventImport(nextState.liveEventImport, markAction),
      };
      logger(markAction, nextState, action._timestamp);
    }
  }

  // One atomic order-exceptions fix: receipt date + money facts + the
  // reconciling cost TSV, applied in a single log entry. Meta is set
  // first so the TSV reconciles against the just-set value-of-goods —
  // the user need not order the fields.
  if (action.type === "fix_stock_order") {
    const {
      orderId,
      meta,
      costTsv,
      costInterpretation,
      overrideExisting,
      approveDiscrepancy,
      ignoreUnmatchedRows,
      fixCountryOfOrigin,
      fixWeights,
    } = action.payload;

    if (meta && Object.values(meta).some((v) => v !== undefined)) {
      const metaAction = inheritTimestamp({
        ...set_stock_order_meta({ orderId, meta }),
        _ephemeral: true,
      });
      nextState = {
        ...nextState,
        inventory: inventory(nextState.inventory, metaAction),
      };
      logger(metaAction, nextState, action._timestamp);
    }

    if (typeof costTsv === "string" && costTsv.trim()) {
      const preview = computeStockOrderCostCommit({
        rawPaste: costTsv,
        orderId,
        overrideExisting,
        interpretation: costInterpretation,
        inventory: nextState.inventory, // reflects the meta just set
      });
      const r = preview.reconciliation;
      const blocked =
        !r.chosen ||
        r.rows.length === 0 ||
        (!r.reconciled && r.discrepancy != null && !approveDiscrepancy) ||
        (r.itemCountDiscrepancy != null &&
          r.itemCountDiscrepancy !== 0 &&
          !approveDiscrepancy) ||
        (preview.unmatchedJans.length > 0 && !ignoreUnmatchedRows) ||
        (preview.matched.some((m) => m.isOverride) && !overrideExisting);
      if (!blocked) {
        const applyAction = inheritTimestamp({
          ...apply_stock_order_costs({
            orderId,
            rows: r.rows.map((x) => ({
              jan: x.jan,
              unitCostJpy: x.unitCostJpy,
              qty: x.qty,
            })),
            overrideExisting,
          }),
          _ephemeral: true,
        });
        nextState = {
          ...nextState,
          inventory: inventory(nextState.inventory, applyAction),
        };
        logger(applyAction, nextState, action._timestamp);

        for (const row of preview.matchRows) {
          if (!row.key) continue;
          const fields: Array<{
            field: keyof Item;
            from: string | number;
            to: string | number;
          }> = [];
          if (
            fixCountryOfOrigin &&
            row.canFixCountryOfOrigin &&
            row.incomingCountryOfOrigin
          ) {
            fields.push({
              field: "countryOfOrigin",
              from: row.item?.countryOfOrigin || "",
              to: row.incomingCountryOfOrigin,
            });
          }
          if (fixWeights && row.canFixWeight && row.incomingWeight != null) {
            fields.push({
              field: "weight",
              from: row.item?.weight || "",
              to: row.incomingWeight,
            });
          }
          if (fields.length === 0) continue;
          const updateAction = inheritTimestamp({
            ...update_fields({ id: row.key, fields }),
            _ephemeral: true,
          });
          nextState = {
            ...nextState,
            inventory: inventory(nextState.inventory, updateAction),
          };
          logger(updateAction, nextState, action._timestamp);
        }
      }
    }
  }

  // Add Proposals (Interception & Enrichment)
  if (action.type === "listingCreation/add_proposals") {
    const cleanProposals = action.payload;

    const enrichedProposals = cleanProposals.map((p: any) => {
      // Find matching inventory items
      const inventoryItems: { id: string; item: any }[] = [];
      for (const [id, val] of Object.entries(state.inventory.idToItem)) {
        const item = val as any;
        if (item.janCode === p.janCode && !item.handle && item.qty > 0) {
          inventoryItems.push({ id, item });
        }
      }
      const inventoryItemIds = inventoryItems.map((x) => x.id);
      // Default to empty string if no inventory items found (shouldn't happen if scan logic was correct)
      const baseItemId = inventoryItemIds.length > 0 ? inventoryItemIds[0] : "";
      const sourceQty =
        inventoryItems.length > 0
          ? Number(inventoryItems[0].item?.qty || 0)
          : 0;

      // Bind each variant to the pre-existing handle-less inventory item
      // whose subtype matches the variant's option1Value.  This avoids the
      // bug where every variant got pinned to inventoryItems[0] and
      // approve_proposal then emitted a single split_inventory_item that
      // redistributed qty across already-separate items.
      const subtypeToItem = new Map<string, { id: string; item: any }>();
      for (const entry of inventoryItems) {
        const subtype = String((entry.item as any)?.subtype || "");
        if (subtype && !subtypeToItem.has(subtype)) {
          subtypeToItem.set(subtype, entry);
        }
      }

      const variantsWithItem = p.variants.map((v: any) => {
        const subtype = String(v.option1Value || "");
        const match = subtype ? subtypeToItem.get(subtype) : null;
        return {
          ...v,
          itemId: match?.id || baseItemId,
        };
      });

      // Persist initial allocations for split variants so UI/state agree and approval is deterministic.
      const explicitQtyTotal = variantsWithItem.reduce(
        (sum: number, v: any) =>
          sum + (v.qty !== undefined ? Number(v.qty) || 0 : 0),
        0,
      );
      const missingQtyIndices = variantsWithItem
        .map((v: any, index: number) => ({ v, index }))
        .filter(({ v }: any) => v.qty === undefined)
        .map(({ index }: any) => index);

      if (missingQtyIndices.length > 0) {
        const remainingQty = Math.max(sourceQty - explicitQtyTotal, 0);
        const base = Math.floor(remainingQty / missingQtyIndices.length);
        const remainder = remainingQty % missingQtyIndices.length;

        missingQtyIndices.forEach((variantIndex: number, i: number) => {
          variantsWithItem[variantIndex] = {
            ...variantsWithItem[variantIndex],
            qty: base + (i < remainder ? 1 : 0),
          };
        });
      }

      return {
        ...p,
        inventoryItemIds,
        variants: variantsWithItem,
      };
    });

    const internalAction = inheritTimestamp({
      ...add_proposals_internal(enrichedProposals),
      _ephemeral: true,
    });

    nextState = {
      ...nextState,
      listingCreation: listingCreation(
        nextState.listingCreation,
        internalAction,
      ),
    };
    logger(internalAction, nextState, action._timestamp);
  }

  // Import Existing Variants (Listing Creation)
  if (
    action.type === "listingCreation/import_existing_variants" &&
    state.inventory
  ) {
    const { janCode, handle } = action.payload;
    console.log(
      `[RootReducer] Importing variants for ${janCode} from handle ${handle}`,
    );

    const matchedItems: { id: string; item: Item }[] = [];
    Object.entries(state.inventory.idToItem).forEach(([id, item]) => {
      if ((item as Item).handle === handle) {
        matchedItems.push({ id, item: item as Item });
      }
    });

    console.log(
      `[RootReducer] Found ${matchedItems.length} existing items for handle ${handle}`,
    );

    if (matchedItems.length > 0) {
      // 0. Ensure Photos Exist in Photos Slice (for Image Picker)
      const photosState = nextState.photos;
      let nextJanCodeToPhotos = { ...photosState.janCodeToPhotos };
      let photosUpdated = false;

      matchedItems.forEach(({ item }) => {
        if (!item.image) return;

        const photoKey = item.subtype
          ? `${item.janCode}:${item.subtype}`
          : item.janCode;
        const group = nextJanCodeToPhotos[photoKey] || [];

        // Check if image already exists in group
        const exists = group.some(
          (p: any) => p.baseUrl === item.image || p.productUrl === item.image,
        );

        if (!exists) {
          console.log(
            `[RootReducer] Backfilling photo for ${photoKey}: ${item.image}`,
          );
          if (!nextJanCodeToPhotos[photoKey])
            nextJanCodeToPhotos[photoKey] = [];

          const syntheticPhoto = {
            id: `synthetic-${crypto.randomUUID()}`,
            baseUrl: item.image,
            productUrl: item.image,
            mimeType: "image/jpeg",
            filename: "imported.jpg",
            mediaMetadata: {
              creationTime: new Date().toISOString(),
              width: "0",
              height: "0",
            },
          };

          nextJanCodeToPhotos[photoKey] = [
            ...nextJanCodeToPhotos[photoKey],
            syntheticPhoto,
          ];
          photosUpdated = true;

          // Log synthetic action
          logger(
            inheritTimestamp({
              type: "photos/categorize_photo (synthetic)",
              payload: { janCode: photoKey, photo: syntheticPhoto },
              _ephemeral: true,
            }),
            nextState,
            action._timestamp,
          );
        }
      });

      if (photosUpdated) {
        nextState = {
          ...nextState,
          photos: {
            ...photosState,
            janCodeToPhotos: nextJanCodeToPhotos,
          },
        };
      }

      // 1. Add Variants
      const variants = matchedItems.map(({ id, item }) => {
        console.log(
          `[RootReducer] Mapping existing item ${id}. Image: ${item.image}`,
        );
        const photoGroupKey = item.subtype
          ? `${item.janCode}:${item.subtype}`
          : item.janCode;
        return {
          id: `${item.janCode}:${item.subtype || "Default"}:${crypto.randomUUID().slice(0, 8)}`,
          itemId: id,
          option1Value: item.subtype || "Default",
          image: item.image, // Preserve existing photo
          photoGroupKey, // Link to photo group
          qty: item.qty, // Initialize allocation to match current inventory
        };
      });

      const addVariantsAction = inheritTimestamp({
        ...add_variants_internal({ janCode, variants }),
        _ephemeral: true,
      });

      nextState = {
        ...nextState,
        listingCreation: listingCreation(
          nextState.listingCreation,
          addVariantsAction,
        ),
      };
      logger(addVariantsAction, nextState, action._timestamp);

      // 2. Sync Price & Gallery Images (Logic moved from Thunk to Reducer for Event Sourcing/Replay)
      const existingPrice = matchedItems[0].item.price;
      console.log(
        `[RootReducer] Existing Price from first item: ${existingPrice}`,
      );

      const currentProposal = nextState.listingCreation.proposals[janCode];

      if (currentProposal) {
        // Sync Price if proposal doesn't have one set (or if we trust the merge target more?)
        // Generally, if we are merging into an existing listing, that listing's price is the truth.
        if (
          existingPrice !== undefined &&
          currentProposal.price === undefined
        ) {
          console.log(
            `[RootReducer] Syncing price to proposal: ${existingPrice}`,
          );
          const syncPriceAction = inheritTimestamp({
            type: "listingCreation/update_proposal_field",
            payload: { janCode, field: "price", value: existingPrice },
            _ephemeral: true,
          });
          nextState = {
            ...nextState,
            listingCreation: listingCreation(
              nextState.listingCreation,
              syncPriceAction,
            ),
          };
          logger(syncPriceAction, nextState, action._timestamp);
        }

        // Sync Gallery Images
        // Need to look up the listing from `nextState.listings`
        const existingListing = nextState.listings.handleToListing[handle];
        console.log(
          `[RootReducer] Looking up existing listing for handle '${handle}': ${!!existingListing}`,
        );

        if (
          existingListing &&
          existingListing.images &&
          existingListing.images.length > 0
        ) {
          console.log(
            `[RootReducer] Existing listing has ${existingListing.images.length} images.`,
          );
          // Identify Gallery Images (Not used by variants)
          // Use a frequency map to consume images 1-to-1.
          // If a URL is used by 1 variant but appears 2 times in the listing,
          // we only filter it out ONCE, preserving the second as a gallery image.
          const variantImageCounts = new Map<string, number>();
          matchedItems.forEach((m) => {
            if (m.item.image) {
              variantImageCounts.set(
                m.item.image,
                (variantImageCounts.get(m.item.image) || 0) + 1,
              );
            }
          });

          const galleryImages: any[] = [];
          existingListing.images.forEach((img: any) => {
            const count = variantImageCounts.get(img.url);
            if (count && count > 0) {
              // Claim this listing image for the variant
              variantImageCounts.set(img.url, count - 1);
            } else {
              // Not claimed (or surplus duplicate), keep as gallery image
              galleryImages.push(img);
            }
          });

          console.log(
            `[RootReducer] Found ${galleryImages.length} gallery images (not linked to variants).`,
          );

          if (galleryImages.length > 0) {
            const listingOnlyImages = galleryImages.map((img) => ({
              ...img,
              isListingOnly: true,
            }));

            // We need to set listingOnlyImages AND listingImageOrder
            // We can construct actions for `update_proposal_field`.

            const syncImagesAction = inheritTimestamp({
              type: "listingCreation/update_proposal_field",
              payload: {
                janCode,
                field: "listingOnlyImages",
                value: listingOnlyImages,
              },
              _ephemeral: true,
            });
            nextState = {
              ...nextState,
              listingCreation: listingCreation(
                nextState.listingCreation,
                syncImagesAction,
              ),
            };
            logger(syncImagesAction, nextState, action._timestamp);

            const syncOrderAction = inheritTimestamp({
              type: "listingCreation/update_proposal_field",
              payload: {
                janCode,
                field: "listingImageOrder",
                value: existingListing.images.map((img: any) => img.id),
              },
              _ephemeral: true,
            });
            nextState = {
              ...nextState,
              listingCreation: listingCreation(
                nextState.listingCreation,
                syncOrderAction,
              ),
            };
            logger(syncOrderAction, nextState, action._timestamp);
          }
        }
      }
    }
  }

  // Listing Creation Global Config & Proposal Persistence
  // We must log ALL actions that modify the proposal state to ensure replayability
  if (
    action.type.startsWith("listingCreation/") &&
    !action.type.includes("approve_proposal") && // Handled by interceptor
    !action.type.includes("remove_proposal") && // Handled by interceptor
    !action.type.includes("complete_batch") && // Handled by interceptor
    !action.type.includes("start_batch") && // Handled elsewhere or safe? start_batch resets state.
    !action.type.includes("import_existing_variants") // Handled by interceptor
  ) {
    // Handle Collision Orchestration (Draft Merging)
    // If a handle update or split creates a collision, orchestrate a merge.
    const isHandleUpdate =
      action.type === "listingCreation/update_proposal_field" &&
      action.payload.field === "handle";
    const isSplit = action.type === "listingCreation/split_variant";

    if (isHandleUpdate || isSplit) {
      const janCode = isHandleUpdate
        ? action.payload.janCode
        : action.payload.variantId; // split uses variantId as new JAN
      const newHandle = action.payload.value || action.payload.newHandle;

      const allProposals = Object.values(
        nextState.listingCreation.proposals,
      ) as any[];
      const matching = allProposals.filter((p) => {
        if (p.janCode === janCode) return false;
        const h = p.handle || generateHandle(p.title, p.janCode);
        return h === newHandle;
      });

      if (matching.length > 0) {
        const target = matching[0];
        console.log(
          `[RootReducer] Collision detected for handle '${newHandle}' (source: ${janCode}, target: ${target.janCode}). Orchestrating merge.`,
        );

        const mergeAction = inheritTimestamp({
          type: "listingCreation/merge_proposals",
          payload: {
            targetJan: target.janCode,
            sourceJans: [janCode],
          },
          _ephemeral: true,
        });

        nextState = {
          ...nextState,
          listingCreation: listingCreation(
            nextState.listingCreation,
            mergeAction,
          ),
        };
        logger(mergeAction, nextState, action._timestamp);
      }
    }

    // Add Variant Intent Handler
    if (action.type === "listingCreation/add_variant_requested") {
      const {
        targetJan,
        janCode,
        variantId,
        subtype: reqSubtype,
        qty: reqQty,
        sourceVariantId,
      } = action.payload;
      const targetProposal = nextState.listingCreation.proposals[targetJan];
      if (targetProposal) {
        const targetHandle =
          targetProposal.handle ||
          generateHandle(targetProposal.title, targetProposal.janCode);

        let itemId = "";
        let subtype = reqSubtype || "New Variant";
        let qty = reqQty || 0;

        // 1. Try to find a NEW item with this JAN (prefer unlisted, then listed elsewhere)
        const invItem = Object.entries(nextState.inventory.idToItem).find(
          ([id, item]: [string, any]) =>
            item.janCode === janCode &&
            item.handle !== targetHandle && // Not already in this listing
            !targetProposal.inventoryItemIds.includes(id), // Not already in this proposal
        );

        if (invItem) {
          itemId = invItem[0];
          subtype = reqSubtype || (invItem[1] as any).subtype || "Default";
          qty = reqQty !== undefined ? reqQty : (invItem[1] as any).qty || 0;
        } else {
          // 2. If no new item found, check if JAN is already present in proposal -> Split from existing
          // Prefer matching by sourceVariantId if provided
          const sourceVariant = sourceVariantId
            ? findListingVariantByIdentity(targetProposal, sourceVariantId)
            : targetProposal.variants.find((v: any) => {
                const item = nextState.inventory.idToItem[v.itemId];
                return item?.janCode === janCode;
              });

          if (sourceVariant) {
            itemId = sourceVariant.itemId;
            subtype = reqSubtype || "New Variant";
            qty = reqQty || 0;
          } else if (janCode === targetJan) {
            // Fallback for primary JAN if somehow not in variants yet
            const firstVariant = targetProposal.variants[0];
            itemId = firstVariant?.itemId || "";
          }
        }

        if (itemId) {
          // 1. Apply Draft Change (Slice Reducer)
          const sliceAction = inheritTimestamp({
            type: "listingCreation/add_variant",
            payload: { targetJan, janCode, itemId, subtype, qty, variantId },
            _ephemeral: true,
          });
          nextState = {
            ...nextState,
            listingCreation: listingCreation(
              nextState.listingCreation,
              sliceAction,
            ),
          };
          logger(sliceAction, nextState, action._timestamp);

          // NOTE: We DO NOT sync inventory handle here.
          // It will be synced during approve_proposal or if explicitly updated in live mode.
        }
      }
    }

    // Remove Variant Intent Handler
    if (action.type === "listingCreation/remove_variant_requested") {
      const { janCode, variantId } = action.payload;
      const proposal = state.listingCreation.proposals[janCode];
      if (proposal) {
        const variant = findListingVariantByIdentity(proposal, variantId);
        if (variant) {
          // 1. Apply Draft Change (Slice Reducer)
          const sliceAction = inheritTimestamp({
            type: "listingCreation/remove_variant",
            payload: { janCode, variantId },
            _ephemeral: true,
          });
          nextState = {
            ...nextState,
            listingCreation: listingCreation(
              nextState.listingCreation,
              sliceAction,
            ),
          };
          logger(sliceAction, nextState, action._timestamp);

          // NOTE: We DO NOT clear inventory handle here.
          // Draft items are un-linked automatically upon approval or cleanup.
        }
      }
    }
  }

  // Approve Proposal Interceptor (Event Sourcing Logic)
  if (action.type === "listingCreation/approve_proposal") {
    // The reducer has already marked it as approved in nextState.
    // Now we must apply the side effects (Inventory/Listings updates) deterministically.

    const { janCode } = action.payload;
    const proposal = nextState.listingCreation.proposals[janCode];

    if (proposal) {
      const finalHandle =
        proposal.handle || generateHandle(proposal.title, proposal.janCode);
      const allProposals = nextState.listingCreation.proposals;

      // 1. Identify Siblings (Merged Group)
      // Robustly match sibling proposals by Handle OR by janCode (if handle is implicit/missing)
      const mergedProposals = Object.values(allProposals).filter((p: any) => {
        const h = p.handle || generateHandle(p.title, p.janCode);
        if (h === finalHandle) return true;
        if (!p.handle && !proposal.handle && p.janCode === proposal.janCode)
          return true;
        return false;
      }) as any[]; // Type assertion for Proposal

      // 2. Aggregate Variants from ALL siblings for Inventory Operations
      const allVariants = mergedProposals.flatMap((p) => p.variants || []);

      // 3. Inventory Splits
      const itemsToSplit = new Map<string, any[]>();
      const variantIdToItemId = new Map<string, string>();

      allVariants.forEach((v: any) => {
        if (!itemsToSplit.has(v.itemId)) itemsToSplit.set(v.itemId, []);
        itemsToSplit.get(v.itemId)?.push(v);
        variantIdToItemId.set(v.id, v.itemId);
      });

      itemsToSplit.forEach((variants, sourceId) => {
        if (variants.length > 1) {
          const splits = variants.map((v: any) => {
            // Use Source Item's JAN for SKU generation (safe even if sourceId is item-1)
            const sourceItem = nextState.inventory.idToItem[sourceId];
            const baseJan = sourceItem ? sourceItem.janCode : proposal.janCode;
            const uniqueId = makeInventoryItemKey(
              baseJan,
              v.option1Value || "Default",
            );

            return {
              newId: uniqueId,
              qty: v.qty || 0,
              subtype: v.option1Value,
            };
          });

          const splitAction = inheritTimestamp({
            ...split_inventory_item({
              sourceId: canonicalizeInventoryItemKey(sourceId),
              splits,
            }),
            _ephemeral: true,
          });
          nextState = {
            ...nextState,
            inventory: inventory(nextState.inventory, splitAction),
          };
          logger(splitAction, nextState, action._timestamp);

          // Update variant references to new IDs locally
          variants.forEach((v: any, i: number) => {
            variantIdToItemId.set(v.id, splits[i].newId);
          });

          // Clear handle on source item to prevent it from appearing in the listing (ghost row)
          if (nextState.inventory.idToItem[sourceId]) {
            const sourceHandle =
              nextState.inventory.idToItem[sourceId]?.handle || "";
            const clearHandleAction = inheritTimestamp({
              ...update_field({
                id: sourceId,
                field: "handle",
                from: sourceHandle,
                to: "",
              }),
              _ephemeral: true,
            });
            nextState = {
              ...nextState,
              inventory: inventory(nextState.inventory, clearHandleAction),
            };
            logger(clearHandleAction, nextState, action._timestamp);
          }
        }
      });

      // 4. Inventory Updates (Price, Handle, Subtype, Image, Position)
      const processedItemIds = new Set<string>();

      allVariants.forEach((v: any, i: number) => {
        const fields: any[] = [];
        let currentItemId = variantIdToItemId.get(v.id) || v.itemId;

        // Resolve Image: Override > Photo Group > Skip
        let imageUrl = v.image;
        if (!imageUrl && v.photoGroupKey) {
          const group = nextState.photos.janCodeToPhotos[v.photoGroupKey];
          if (group && group.length > 0) {
            imageUrl =
              group[0].baseUrl ||
              group[0].productUrl ||
              (group[0] as any).thumbnailLink;
          }
        }

        // Find which proposal this variant belongs to (for shared fields like price/title)
        // Optimally we use the primary proposal's data for shared fields,
        // but variant-specific data (subtype) comes from v.

        if (proposal.price !== undefined)
          fields.push({ field: "price", value: proposal.price });
        fields.push({ field: "handle", value: finalHandle });
        // Explicitly sync Description from Proposal Title
        fields.push({ field: "description", value: proposal.title });
        if (imageUrl) fields.push({ field: "image", value: imageUrl });
        fields.push({ field: "imagePosition", value: i + 1 });

        // Update Subtype LAST because it triggers a rename (retype_item logic in update_field reducer),
        // which invalidates the currentItemId. All other updates must happen on the old ID first.
        if (v.option1Value)
          fields.push({ field: "subtype", value: v.option1Value });

        // Collapse the per-(variant×field) reducer fan-out (the dominant
        // approve_proposal cost — see docs/investigations/
        // REPLAY_PERFORMANCE.md): apply all non-subtype fields in ONE
        // inventory produce via update_fields. The listings reducer only
        // consumes handle/description (all other fields are no-ops there),
        // so dispatch just those to listings, in original field order, to
        // preserve applyHandleUpdate / title-sync behaviour exactly.
        // subtype stays a separate, last update_field because it re-keys.
        const nonSubtype = fields.filter((f) => f.field !== "subtype");
        const subtypeField = fields.find((f) => f.field === "subtype");

        if (nonSubtype.length > 0) {
          const batchAction = inheritTimestamp({
            ...update_fields({
              id: currentItemId,
              fields: nonSubtype.map((f) => ({
                field: f.field,
                from: "",
                to: f.value,
              })),
            }),
            _ephemeral: true,
          });
          nextState = {
            ...nextState,
            inventory: inventory(nextState.inventory, batchAction),
          };
          logger(batchAction, nextState, action._timestamp);

          for (const f of nonSubtype) {
            if (f.field !== "handle" && f.field !== "description") continue;
            const listingAction = inheritTimestamp({
              ...update_field({
                id: currentItemId,
                field: f.field,
                from: "",
                to: f.value,
              }),
              _ephemeral: true,
            });
            nextState = {
              ...nextState,
              listings: listings(nextState.listings, listingAction),
            };
            logger(listingAction, nextState, action._timestamp);
          }
        }

        if (subtypeField) {
          const f = subtypeField;
          const itemBeforeUpdate = nextState.inventory.idToItem[currentItemId];
          const janBeforeUpdate =
            itemBeforeUpdate?.janCode ||
            String(currentItemId).match(/^\d+/)?.[0] ||
            proposal.janCode;
          const updateAction = inheritTimestamp({
            ...update_field({
              id: currentItemId,
              field: f.field,
              from: "",
              to: f.value,
            }),
            _ephemeral: true,
          });

          nextState = {
            ...nextState,
            inventory: inventory(nextState.inventory, updateAction),
            listings: listings(nextState.listings, updateAction),
          };
          logger(updateAction, nextState, action._timestamp);

          // Subtype updates re-key inventory IDs (jan+subtype). Keep local
          // references in sync so downstream idToHandle aggregation
          // includes renamed keys (required for subtype pills).
          const subtype = (f.value as string)?.trim() || "";
          const baseJan = janBeforeUpdate;
          const renamedItemId = makeInventoryItemKey(baseJan, subtype);
          if (
            renamedItemId &&
            renamedItemId !== currentItemId &&
            nextState.inventory.idToItem[renamedItemId]
          ) {
            const listingState = nextState.listings;
            const nextIdToHandle = { ...listingState.idToHandle };
            const mappedHandle = nextIdToHandle[currentItemId] || finalHandle;
            nextIdToHandle[renamedItemId] = mappedHandle;
            delete nextIdToHandle[currentItemId];

            nextState = {
              ...nextState,
              listings: {
                ...listingState,
                idToHandle: nextIdToHandle,
              },
            };

            currentItemId = renamedItemId;
            variantIdToItemId.set(v.id, renamedItemId);
          }
        }
      });

      // 4.5 Ensure ALL merged items point to the final handle in listings state
      // (Avoid stale idToHandle entries from previous handles after merges)
      const mergedItemIds = new Set<string>();
      allVariants.forEach((v: any) => {
        const currentItemId = variantIdToItemId.get(v.id) || v.itemId;
        if (currentItemId) mergedItemIds.add(currentItemId);
      });
      if (mergedItemIds.size > 0) {
        const listingState = nextState.listings;
        const nextIdToHandle = { ...listingState.idToHandle };
        const nextHandleToListing = { ...listingState.handleToListing };
        const priorHandles = new Set<string>();

        mergedItemIds.forEach((id) => {
          const prior = nextIdToHandle[id];
          if (prior && prior !== finalHandle) priorHandles.add(prior);
          nextIdToHandle[id] = finalHandle;
        });

        // Clean up old handles if no longer used
        priorHandles.forEach((handle) => {
          if (handle === finalHandle) return;
          const stillUsed = Object.values(nextIdToHandle).includes(handle);
          if (!stillUsed) {
            delete nextHandleToListing[handle];
          }
        });

        nextState = {
          ...nextState,
          listings: {
            ...listingState,
            idToHandle: nextIdToHandle,
            handleToListing: nextHandleToListing,
          },
        };
      }

      // 5. Create/Update Listing with Aggregated Images
      // Ensure Approved Proposal is FIRST for image ordering priority
      const primaryIndex = mergedProposals.findIndex(
        (p) => p.janCode === proposal.janCode,
      );
      if (primaryIndex > 0) {
        mergedProposals.splice(primaryIndex, 1);
        mergedProposals.unshift(proposal);
      }

      const mergedImages = buildDraftListingImages(
        mergedProposals,
        nextState.photos,
        nextState.inventory,
      );

      const listingData = {
        handle: finalHandle,
        title: proposal.title,
        bodyHtml: proposal.bodyHtml,
        productCategory: proposal.productCategory,
        vendor: proposal.vendor,
        tags: proposal.tags,
        option1Name: proposal.option1Name || "Subtype",
        images: mergedImages,
        productType: "",
        status: "active" as const,
        lastUpdated: keepLatestTimestamp(
          nextState.listings.handleToListing[finalHandle]?.lastUpdated,
          action._timestamp,
        ),
      };

      const existingListing = nextState.listings.handleToListing[finalHandle];
      let finalListing = listingData;
      if (existingListing) {
        finalListing = { ...existingListing, ...listingData };
      }

      const createActionLocal = inheritTimestamp({
        ...create_listing({ listing: finalListing }),
        _ephemeral: true,
      });
      nextState = {
        ...nextState,
        listings: listings(nextState.listings, createActionLocal),
      };
      logger(createActionLocal, nextState, action._timestamp);

      // 6. Cleanup ALL Merged Proposals
      mergedProposals.forEach((p) => {
        const removeAction = inheritTimestamp({
          ...remove_proposal({ janCode: p.janCode }),
          _ephemeral: true,
        });
        nextState = {
          ...nextState,
          listingCreation: listingCreation(
            nextState.listingCreation,
            removeAction,
          ),
        };
        logger(removeAction, nextState, action._timestamp);
      });

      // 7. Complete Batch Check
      if (nextState.listingCreation.activeBatchJans.length === 0) {
        const completeAction = inheritTimestamp({
          ...complete_batch(),
          _ephemeral: true,
        });
        nextState = {
          ...nextState,
          listingCreation: listingCreation(
            nextState.listingCreation,
            completeAction,
          ),
        };
        logger(completeAction, nextState, action._timestamp);
      }
    }
  }

  // Critical Action Logging
  const criticalActions = [
    "listingCreation/set_global_prompts",
    "listingCreation/update_proposal_field",
    "listingCreation/exclude_proposal_photo",
    "listingCreation/include_proposal_photo",
    "listingCreation/add_listing_only_image",
    "listingCreation/remove_listing_only_image",
    "listingCreation/update_variant_value",
    "listingCreation/update_variant_qty",
    "listingCreation/update_variant_image",
    "listingCreation/set_variant_photo_group",
    "listingCreation/split_variant",
    "listingCreation/move_variant",
    "listingCreation/add_variant",
    "listingCreation/add_variant_requested",
    "listingCreation/remove_variant",
    "listingCreation/remove_variant_requested",
    "listingCreation/merge_proposal",
    "listingCreation/merge_proposals",
    "listingCreation/reorder_variants",
    "listingCreation/add_proposals",
    "listingCreation/start_batch",
    "listingCreation/set_current_step",
  ];

  if (criticalActions.includes(action.type)) {
    logger(action, nextState, action._timestamp);
  }

  return nextState;
};
