export type InventoryItemKey = string & {
  readonly __inventoryItemKey: unique symbol;
};

export const canonicalizeJanCode = (janCode: string): string =>
  (janCode || "").trim().replace(/\s+/g, "");

export const isDefaultSubtype = (subtype?: string): boolean => {
  const normalized = (subtype || "").trim().toLowerCase();
  return normalized === "default" || normalized === "default title";
};

export const canonicalizeSubtype = (subtype?: string): string =>
  isDefaultSubtype(subtype) ? "" : (subtype || "").trim();

export const makeInventoryItemKey = (
  janCode: string,
  subtype?: string,
): InventoryItemKey =>
  `${canonicalizeJanCode(janCode)}${canonicalizeSubtype(subtype)}` as InventoryItemKey;

// Shopify SKU format intentionally matches our inventory item key format.
export const generateSku = (janCode: string, subtype?: string): string =>
  makeInventoryItemKey(janCode, subtype);

export const canonicalizeInventoryItemKey = (
  rawKey: string,
): InventoryItemKey => {
  const normalized = (rawKey || "").trim();
  const match = normalized.match(/^(\d+)(.*)$/);
  if (match) {
    return makeInventoryItemKey(match[1], match[2] || "");
  }
  return makeInventoryItemKey(normalized, "");
};
