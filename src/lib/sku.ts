export type InventoryItemKey = string & { readonly __inventoryItemKey: unique symbol };

export const canonicalizeJanCode = (janCode: string): string =>
  (janCode || "").trim().replace(/\s+/g, "");

export const canonicalizeSubtype = (subtype?: string): string =>
  (subtype || "").trim().replace(/[^a-zA-Z0-9-_]/g, "");

export const makeInventoryItemKey = (
  janCode: string,
  subtype?: string,
): InventoryItemKey =>
  `${canonicalizeJanCode(janCode)}${canonicalizeSubtype(subtype)}` as InventoryItemKey;

export const canonicalizeInventoryItemKey = (rawKey: string): InventoryItemKey => {
  const normalized = (rawKey || "").trim();
  const match = normalized.match(/^(\d+)(.*)$/);
  if (match) {
    return makeInventoryItemKey(match[1], match[2] || "");
  }
  return makeInventoryItemKey(normalized, "");
};
