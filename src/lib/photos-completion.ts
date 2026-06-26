import type { Item } from "./inventory";
import type { Listing, ListingsState } from "./listings-slice";

interface InventoryLike {
  idToItem?: Record<string, Item>;
}

interface CompletionIndexes {
  exactListedKeys: Set<string>;
  listedBaseJans: Set<string>;
  inventorySubtypesByBaseJan: Map<string, Set<string>>;
  completedOptionKeys: Set<string>;
}

function splitPhotoGroupKey(key: string): { baseJan: string; suffix: string } {
  const [baseJan, ...rest] = String(key || "").split(":");
  return { baseJan, suffix: rest.join(":").trim() };
}

function addCompletedListingKeysForItem(
  indexes: CompletionIndexes,
  itemId: string,
  item: Item,
  listing: Listing | undefined,
) {
  if (!item?.janCode || !listing?.bodyHtml) return;

  indexes.listedBaseJans.add(item.janCode);
  indexes.exactListedKeys.add(item.janCode);

  const subtype = String(item.subtype || "").trim();
  if (subtype) {
    indexes.exactListedKeys.add(`${item.janCode}:${subtype}`);
  }

  const optionLabel = String(
    listing.variantOptionsByItemId?.[itemId] || "",
  ).trim();
  if (optionLabel) {
    indexes.completedOptionKeys.add(`${item.janCode}:${optionLabel}`);
  }
}

export function buildCompletedPhotoGroupIndexes(
  inventory: InventoryLike | undefined,
  listings: Pick<ListingsState, "idToHandle" | "handleToListing"> | undefined,
): CompletionIndexes {
  const indexes: CompletionIndexes = {
    exactListedKeys: new Set(),
    listedBaseJans: new Set(),
    inventorySubtypesByBaseJan: new Map(),
    completedOptionKeys: new Set(),
  };

  const idToItem = inventory?.idToItem || {};
  const idToHandle = listings?.idToHandle || {};
  const handleToListing = listings?.handleToListing || {};

  for (const [itemId, item] of Object.entries(idToItem)) {
    if (!item?.janCode) continue;

    const subtype = String(item.subtype || "").trim();
    if (subtype) {
      const subtypes =
        indexes.inventorySubtypesByBaseJan.get(item.janCode) || new Set();
      subtypes.add(subtype);
      indexes.inventorySubtypesByBaseJan.set(item.janCode, subtypes);
    }

    const handle = idToHandle[itemId];
    addCompletedListingKeysForItem(
      indexes,
      itemId,
      item,
      handle ? handleToListing[handle] : undefined,
    );
  }

  return indexes;
}

export function isCompletedPhotoGroupKey(
  photoGroupKey: string,
  indexes: CompletionIndexes,
): boolean {
  if (indexes.exactListedKeys.has(photoGroupKey)) return true;
  if (indexes.completedOptionKeys.has(photoGroupKey)) return true;

  const { baseJan, suffix } = splitPhotoGroupKey(photoGroupKey);
  if (!baseJan || !suffix || !indexes.listedBaseJans.has(baseJan)) {
    return false;
  }

  const inventorySubtypes = indexes.inventorySubtypesByBaseJan.get(baseJan);
  if (!inventorySubtypes || inventorySubtypes.size === 0) {
    return true;
  }

  return !inventorySubtypes.has(suffix);
}
