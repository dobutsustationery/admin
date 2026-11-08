import { makeInventoryItemKey } from "./sku";

export const POOLED_LISTING_STOCK = "pooled-stock-v1";
export const availableListingStock = (item: any) =>
  Math.max(0, Number(item?.qty || 0) - Number(item?.shipped || 0));
const sourceIds = (p: any): string[] => [
  ...new Set<string>(
    [
      ...(p.inventoryItemIds || []),
      ...p.variants.map((v: any) => v.itemId),
    ].filter(Boolean),
  ),
];

// Splitting/moving a variant changes its draft, not its physical stock yet.
// Resolve the complete connected pool when any of those drafts is approved.
export function relatedStockProposals(
  selected: any[],
  all: any[],
  inventory: any,
) {
  const result = selected.filter(
    (p) => p.allocationMode === POOLED_LISTING_STOCK,
  );
  const jans = new Set<string>();
  for (let i = 0; i < result.length; i++) {
    for (const id of sourceIds(result[i])) {
      const jan = inventory.idToItem[id]?.janCode;
      if (jan) jans.add(jan);
    }
    for (const p of all) {
      if (
        p.allocationMode === POOLED_LISTING_STOCK &&
        !result.includes(p) &&
        sourceIds(p).some((id) => jans.has(inventory.idToItem[id]?.janCode))
      )
        result.push(p);
    }
  }
  return result;
}

// Historical proposals without allocationMode keep their original replay rules.
export function planListingStock(proposals: any[], inventory: any) {
  const groups = new Map<
    string,
    {
      sourceIds: string[];
      targets: { itemId: string; subtype: string; qty: number }[];
    }
  >();
  const bindings = new Map<string, string>();
  const pooled = proposals.filter(
    (p) => p.allocationMode === POOLED_LISTING_STOCK,
  );
  const ids = [...new Set(pooled.flatMap(sourceIds))];
  for (const id of ids) {
    const item = inventory.idToItem[id];
    if (!item || item.handle)
      throw Error(
        "The source stock changed. Regenerate this listing draft before approving it.",
      );
    if (!groups.has(item.janCode))
      groups.set(item.janCode, { sourceIds: [], targets: [] });
    groups.get(item.janCode)!.sourceIds.push(id);
  }
  const variants = pooled.flatMap((p) =>
    p.variants.map((v: any) => ({
      ...v,
      jan: inventory.idToItem[v.itemId]?.janCode || p.janCode,
    })),
  );
  const targetIds = new Set<string>();
  for (const variant of variants) {
    const { jan } = variant;
    const group = groups.get(jan);
    const subtype = String(variant.option1Value || "").trim();
    const matchedSource = group?.sourceIds.find(
      (id) => inventory.idToItem[id].subtype === subtype,
    );
    // One listing option labels the existing item; it does not rename its SKU.
    const itemId =
      matchedSource ||
      (group?.sourceIds.length === 1 &&
      variants.filter((v) => v.jan === jan).length === 1
        ? group.sourceIds[0]
        : makeInventoryItemKey(jan, subtype));
    if (!group || !subtype || targetIds.has(itemId))
      throw Error("Each listing variant needs a different subtype name.");
    if (!Number.isInteger(variant.qty) || variant.qty < 0)
      throw Error("Enter a whole-number stock quantity for every variant.");
    const existing = inventory.idToItem[itemId];
    if (
      existing &&
      !ids.includes(itemId) &&
      (existing.janCode !== jan ||
        existing.handle ||
        availableListingStock(existing) > 0)
    )
      throw Error(
        `Inventory ${itemId} already exists outside this draft. Regenerate the draft to include its stock.`,
      );
    targetIds.add(itemId);
    bindings.set(variant.id, itemId);
    group.targets.push({ itemId, subtype, qty: variant.qty });
  }
  for (const group of groups.values()) {
    const available = group.sourceIds.reduce(
      (sum, id) => sum + availableListingStock(inventory.idToItem[id]),
      0,
    );
    if (group.targets.reduce((sum, t) => sum + t.qty, 0) !== available)
      throw Error(
        `Allocate all ${available} available units across the variants before approving.`,
      );
  }
  return { plans: [...groups.values()], bindings };
}

export interface ListingStockReview {
  valid: boolean;
  error: string;
  pools: { jan: string; available: number; allocated: number }[];
}

// UI review uses the same complete pool and approval rules as the reducer,
// including variants in related drafts that have been split into other listings.
export function reviewListingStock(
  selected: any[],
  all: any[],
  inventory: any,
): ListingStockReview {
  const related = relatedStockProposals(selected, all, inventory);
  const pools = new Map<
    string,
    { jan: string; available: number; allocated: number }
  >();
  for (const id of new Set(related.flatMap(sourceIds))) {
    const item = inventory.idToItem[id];
    if (!item) continue;
    if (!pools.has(item.janCode))
      pools.set(item.janCode, {
        jan: item.janCode,
        available: 0,
        allocated: 0,
      });
    pools.get(item.janCode)!.available += availableListingStock(item);
  }
  for (const p of related)
    for (const v of p.variants) {
      const jan = inventory.idToItem[v.itemId]?.janCode || p.janCode;
      const pool = pools.get(jan);
      if (pool) pool.allocated += Number(v.qty) || 0;
    }
  try {
    planListingStock(related, inventory);
    return { valid: true, error: "", pools: [...pools.values()] };
  } catch (error) {
    return {
      valid: false,
      error: (error as Error).message,
      pools: [...pools.values()],
    };
  }
}
