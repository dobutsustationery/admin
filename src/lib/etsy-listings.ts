import { canonicalizeInventoryItemKey, generateSku } from "./sku";
import { isListingSyncDisabled } from "./shopify-listing-projection";

export type EtsyIssue =
  | "quantity"
  | "price"
  | "title"
  | "description"
  | "mapping"
  | "presence"
  | "state"
  | "photos"
  | "error"
  | "synced";
export const etsyIssueLabels: Record<EtsyIssue, string> = {
  quantity: "Quantity",
  price: "Price",
  title: "Title",
  description: "Description",
  mapping: "Unmatched variations",
  presence: "No matched Etsy listing",
  state: "Inactive listings",
  photos: "Missing photos",
  error: "Read errors",
  synced: "No differences",
};
export type EtsyListing = {
  listingId: string;
  shopId: string;
  title: string;
  description: string;
  state: string;
  url: string;
  currency: string;
  images: { id: string; url: string; rank: number }[];
  inventory: any;
  inventoryError: string;
  observedAtMs: number;
};
export type EtsyMatch = {
  productId: string;
  sku: string;
  label: string;
  itemKey: string;
  item: any;
  handle: string;
  quantity: number;
  price: number;
  wantedQuantity: number;
  wantedPrice: number;
  error: string;
  enabled: boolean;
  excluded: boolean;
};
export type EtsyRow = {
  key: string;
  title: string;
  remote?: EtsyListing;
  matches: EtsyMatch[];
  handles: string[];
  issues: EtsyIssue[];
  localTitle: string;
  localDescription: string;
  localHandle?: string;
};
export function plainDescription(html: string): string {
  return String(html || "")
    .replace(/<\/(?:p|div|li|h[1-6])\s*>|<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(?:nbsp|amp|lt|gt|quot|apos|#39);/g,
      (e) =>
        ({
          "&nbsp;": " ",
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
          "&#39;": "'",
        })[e] || e,
    )
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
const text = (s: string) => plainDescription(s).replace(/\s+/g, " ").trim();
export function etsyZeroStockHeld(
  remote: EtsyListing,
  matches: EtsyMatch[],
): boolean {
  return (
    remote.state !== "active" &&
    matches.length > 0 &&
    matches.every((m) => !m.error && !m.excluded && m.wantedQuantity === 0)
  );
}
export function etsyQuantitySyncDeactivates(row: EtsyRow): boolean {
  return (
    row.matches.length > 0 &&
    row.matches.every(
      (m) => (!m.error && !m.excluded ? m.wantedQuantity : m.quantity) === 0,
    )
  );
}

export function etsyLatestListingResults(results: any[]): Record<string, any> {
  const latest: Record<string, any> = {};
  for (const result of [...results].sort(
    (a, b) => b.startedAtMs - a.startedAtMs,
  ))
    for (const entry of result.results || [])
      if (!latest[entry.listingId])
        latest[entry.listingId] = { ...entry, requestId: result.id };
  return latest;
}
export function etsyComparison(
  root: any,
  listings: EtsyListing[],
  mappings: Record<string, string> = {},
): EtsyRow[] {
  const items = root.inventory?.idToItem || {},
    localListings = root.listings?.handleToListing || {};
  const skuKeys = new Map<string, string[]>();
  for (const [key, item] of Object.entries(items) as [string, any][]) {
    for (const sku of new Set([
      canonicalizeInventoryItemKey(key),
      generateSku(item.janCode, item.subtype),
    ])) {
      if (!sku) continue;
      const keys = skuKeys.get(sku) || [];
      if (!keys.includes(key)) keys.push(key);
      skuKeys.set(sku, keys);
    }
  }
  const linked = new Set<string>();
  const rows: EtsyRow[] = listings.map((remote) => {
    const products = (remote.inventory?.products || []).filter(
      (p: any) => !p.is_deleted,
    );
    const matches: EtsyMatch[] = products.map((p: any) => {
      const explicit = mappings[`${remote.listingId}-${p.product_id}`];
      const keys = explicit
        ? items[explicit]
          ? [explicit]
          : []
        : skuKeys.get(canonicalizeInventoryItemKey(p.sku || "")) || [];
      const itemKey = keys.length === 1 ? keys[0] : "",
        item = items[itemKey];
      const offerings = (p.offerings || []).filter((o: any) => !o.is_deleted);
      const o = offerings[0];
      const quantity = Number(o?.quantity || 0),
        price =
          Number(o?.price?.amount || 0) / Number(o?.price?.divisor || 100);
      const handle = itemKey
        ? root.listings?.idToHandle?.[itemKey] || item?.handle || ""
        : "";
      if (handle) linked.add(handle);
      const error = !itemKey
        ? keys.length > 1
          ? "SKU matches multiple inventory items"
          : "No matching inventory SKU"
        : !offerings.length
          ? "No Etsy offering"
          : offerings.some(
                (v: any) =>
                  Number(v.quantity) !== quantity ||
                  Number(v.price.amount) / Number(v.price.divisor || 100) !==
                    price,
              )
            ? "Multiple offerings have different prices or stock; review on Etsy"
            : "";
      return {
        productId: String(p.product_id),
        sku: p.sku || "",
        label: (p.property_values || [])
          .flatMap((v: any) => v.values || [])
          .join(" / "),
        itemKey,
        item,
        handle,
        quantity,
        price,
        wantedQuantity: Math.max(
          0,
          Number(item?.qty || 0) - Number(item?.shipped || 0),
        ),
        wantedPrice: Number(item?.price || 0),
        error,
        enabled: o?.is_enabled !== false,
        excluded: isListingSyncDisabled(localListings[handle]),
      };
    });
    for (const match of matches) {
      if (
        match.itemKey &&
        matches.filter((m) => m.itemKey === match.itemKey).length > 1
      ) {
        match.error =
          "Several Etsy variations match this inventory item; review the match";
      }
    }
    const handles = [...new Set(matches.map((m) => m.handle).filter(Boolean))];
    const listing = handles.length === 1 ? localListings[handles[0]] : null;
    const comparableContent =
      listing &&
      matches.length > 0 &&
      matches.every((m) => !m.error && !m.excluded && m.handle === handles[0]);
    const localTitle = comparableContent ? listing.title || "" : "",
      localDescription = comparableContent
        ? plainDescription(listing.bodyHtml || "")
        : "";
    const issues: EtsyIssue[] = [];
    if (remote.inventoryError) issues.push("error");
    if (
      matches.some((m) => !!m.error) ||
      (!products.length && !remote.inventoryError)
    )
      issues.push("mapping");
    if (
      !etsyZeroStockHeld(remote, matches) &&
      matches.some(
        (m) => !m.error && !m.excluded && m.quantity !== m.wantedQuantity,
      )
    )
      issues.push("quantity");
    if (
      matches.some(
        (m) =>
          !m.error &&
          !m.excluded &&
          m.wantedPrice > 0 &&
          (remote.currency !== "EUR" ||
            Math.abs(m.price - m.wantedPrice) > 0.005),
      )
    )
      issues.push("price");
    if (localTitle && text(localTitle) !== text(remote.title))
      issues.push("title");
    if (localDescription && text(localDescription) !== text(remote.description))
      issues.push("description");
    if (
      remote.state !== "active" &&
      matches.some((m) => m.wantedQuantity > 0 && !m.excluded)
    )
      issues.push("state");
    if (!remote.images.length) issues.push("photos");
    if (!issues.length) issues.push("synced");
    return {
      key: remote.listingId,
      title: remote.title,
      remote,
      matches,
      handles,
      issues,
      localTitle,
      localDescription,
    };
  });
  for (const [handle, listing] of Object.entries(localListings) as [
    string,
    any,
  ][]) {
    if (
      linked.has(handle) ||
      isListingSyncDisabled(listing) ||
      !listing.title ||
      listing.title.toLowerCase() === "untitled"
    )
      continue;
    const keys = Object.entries(root.listings?.idToHandle || {})
      .filter(([, h]) => h === handle)
      .map(([k]) => k);
    if (
      !keys.some(
        (k) =>
          items[k] &&
          Number(items[k].qty || 0) - Number(items[k].shipped || 0) > 0 &&
          Number(items[k].price) > 0,
      )
    )
      continue;
    rows.push({
      key: `local:${handle}`,
      title: listing.title,
      localHandle: handle,
      matches: [],
      handles: [handle],
      issues: ["presence"],
      localTitle: listing.title,
      localDescription: plainDescription(listing.bodyHtml || ""),
    });
  }
  return rows.sort((a, b) => a.title.localeCompare(b.title));
}
export function etsySyncEntry(row: EtsyRow, field: string): any | null {
  if (!row.remote) return null;
  if (field === "quantity" || field === "price") {
    if (field === "quantity" && etsyZeroStockHeld(row.remote, row.matches))
      return null;
    if (field === "price" && row.remote.currency !== "EUR") return null;
    const targets = row.matches
      .filter(
        (m) =>
          !m.error &&
          !m.excluded &&
          (field === "quantity"
            ? Number.isInteger(m.wantedQuantity) &&
              m.quantity !== m.wantedQuantity
            : m.wantedPrice > 0 && Math.abs(m.price - m.wantedPrice) > 0.005),
      )
      .map((m) => ({
        productId: m.productId,
        sku: m.sku,
        itemKey: m.itemKey,
        beforeQuantity: m.quantity,
        beforePrice: m.price,
        value: field === "quantity" ? m.wantedQuantity : m.wantedPrice,
      }));
    return targets.length ? { listingId: row.remote.listingId, targets } : null;
  }
  const value =
    field === "title"
      ? row.localTitle
      : field === "description"
        ? row.localDescription
        : "";
  return value &&
    row.issues.includes(field as EtsyIssue) &&
    (field !== "title" || value.length <= 140)
    ? {
        listingId: row.remote.listingId,
        before: (row.remote as any)[field],
        value,
      }
    : null;
}
