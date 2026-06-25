import { toGoogleDrivePublicImageUrl } from "$lib/drive-url";
import type { Item } from "$lib/inventory";
import type { Listing } from "$lib/listings-slice";
import { generateSku } from "$lib/sku";
import type { ShopifyCatalogListing } from "$lib/shopify-catalog-slice";
import { buildComparableRemoteListing } from "$lib/shopify-deep-diff";
import type { ComparableShopifyListing } from "$lib/shopify-deep-diff";
import { SHOPIFY_SYNC_REQUEST_EVENT } from "$lib/sync-events";

export interface ShopifyListingProjectionVariant {
  itemId: string;
  sku: string;
  janCode: string;
  subtype: string;
  available: number;
  price: number;
  weight: number;
  image: string;
}

export interface ShopifyListingProjectionImage {
  id: string;
  url: string;
  position: number;
  altText: string;
}

export interface ShopifyListingProjection {
  handle: string;
  listing: {
    handle: string;
    title: string;
    bodyHtml: string;
    productCategory: string;
    option1Name: string;
    productType: string;
    vendor: string;
    tags: string[];
    status: string;
    images: ShopifyListingProjectionImage[];
  };
  variants: ShopifyListingProjectionVariant[];
}

export interface ShopifySyncRequestEvent extends ShopifyListingProjection {
  eventType: typeof SHOPIFY_SYNC_REQUEST_EVENT;
  requestId: string;
  source: string;
  creator: string;
  requestedBy: string;
  requestedAt: number;
  payloadVersion: 1;
  createdAtMs: number;
  createdAt: unknown;
  timestamp: unknown;
}

type ListingLike = Omit<Partial<Listing>, "images" | "status"> & {
  handle?: string;
  title?: string;
  bodyHtml?: string;
  productCategory?: string;
  productType?: string;
  vendor?: string;
  tags?: string[];
  status?: string;
  option1Name?: string;
  variantOptionsByItemId?: Record<string, string>;
  images?: Array<Partial<ShopifyListingProjectionImage>>;
};

type ItemLike = Partial<Item> & {
  id?: string;
  inventorySubtype?: string;
  listingOption1Value?: string;
};

function trimString(value: unknown): string {
  return String(value || "").trim();
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractGoogleDriveFileId(rawUrl: string): string {
  const value = trimString(rawUrl);
  if (!value) return "";
  if (/^[a-zA-Z0-9_-]{10,}$/.test(value)) return value;
  const apiMatch = /\/drive\/v3\/files\/([a-zA-Z0-9_-]+)/.exec(value);
  if (apiMatch?.[1]) return apiMatch[1];
  const fileMatch = /\/file\/d\/([a-zA-Z0-9_-]+)/.exec(value);
  if (fileMatch?.[1]) return fileMatch[1];
  const imageMatch = /\/d\/([a-zA-Z0-9_-]+)/.exec(value);
  if (imageMatch?.[1]) return imageMatch[1];
  const queryMatch = /[?&]id=([a-zA-Z0-9_-]+)/.exec(value);
  if (queryMatch?.[1]) return queryMatch[1];
  return "";
}

function normalizeImageKey(rawUrl: string): string {
  const value = trimString(rawUrl);
  if (!value) return "";
  const driveId = extractGoogleDriveFileId(value);
  if (driveId) return `drive:${driveId}`;
  return value.replace(/[#?].*$/, "");
}

function isDefaultishSubtype(value: unknown): boolean {
  const normalized = trimString(value).toLowerCase();
  return (
    !normalized || normalized === "default" || normalized === "default title"
  );
}

function buildPostSyncProductImages(
  projection: ShopifyListingProjection,
): ShopifyListingProjectionImage[] {
  const listingImages = (
    Array.isArray(projection.listing.images) ? projection.listing.images : []
  )
    .slice()
    .sort((a, b) => Number(a?.position || 0) - Number(b?.position || 0));

  const productImages: ShopifyListingProjectionImage[] = [];
  const galleryKeys = new Set<string>();

  listingImages.forEach((image) => {
    const url = toGoogleDrivePublicImageUrl(trimString(image?.url));
    const key = normalizeImageKey(url);
    if (!url || !key || galleryKeys.has(key)) return;
    galleryKeys.add(key);
    productImages.push({
      id: trimString(image?.id || url),
      url,
      position: productImages.length + 1,
      altText: trimString(image?.altText),
    });
  });

  projection.variants.forEach((variant) => {
    const url = toGoogleDrivePublicImageUrl(trimString(variant.image));
    if (!url || !normalizeImageKey(url)) return;
    productImages.push({
      id: `${variant.sku}:variant-image`,
      url,
      position: productImages.length + 1,
      altText: trimString(variant.subtype || variant.sku),
    });
  });

  return productImages;
}

export function buildAdminShopifyListingProjection(params: {
  handle: string;
  listing: ListingLike | null | undefined;
  items: ItemLike[];
}): ShopifyListingProjection | null {
  const handle = trimString(params.handle);
  const listing = params.listing;
  if (!handle || !listing) return null;

  const rawVariants = (Array.isArray(params.items) ? params.items : [])
    .map((item): ShopifyListingProjectionVariant | null => {
      const itemId = trimString(item?.id);
      const janCode = trimString(item?.janCode);
      const inventorySubtype = trimString(
        item?.inventorySubtype ?? item?.subtype,
      );
      const subtype = trimString(
        listing.variantOptionsByItemId?.[itemId] ??
          item?.listingOption1Value ??
          item?.subtype,
      );
      const sku = generateSku(janCode, inventorySubtype);
      const qty = finiteNumber(item?.qty);
      const shipped = finiteNumber(item?.shipped);

      if (!itemId || !sku || !janCode) return null;

      return {
        itemId,
        sku,
        janCode,
        subtype,
        available: Math.max(0, qty - shipped),
        price: finiteNumber(item?.price),
        weight: finiteNumber(item?.weight),
        image: toGoogleDrivePublicImageUrl(trimString(item?.image)),
      };
    })
    .filter((variant): variant is ShopifyListingProjectionVariant => !!variant);

  if (rawVariants.length === 0) return null;

  const isSingleDefaultVariant =
    rawVariants.length === 1 && isDefaultishSubtype(rawVariants[0].subtype);
  const variants = isSingleDefaultVariant
    ? [{ ...rawVariants[0], subtype: "", image: "" }]
    : rawVariants;

  return {
    handle,
    listing: {
      handle,
      title: trimString(listing.title),
      bodyHtml: String(listing.bodyHtml || ""),
      productCategory: trimString(listing.productCategory),
      option1Name: trimString(listing.option1Name || "Subtype") || "Subtype",
      productType: trimString(listing.productType),
      vendor: trimString(listing.vendor || "SPNSS Ltd.") || "SPNSS Ltd.",
      tags: Array.isArray(listing.tags) ? listing.tags : [],
      status: trimString(listing.status || "active") || "active",
      images: (Array.isArray(listing.images) ? listing.images : []).map(
        (img, idx) => ({
          id: trimString(img?.id),
          url: toGoogleDrivePublicImageUrl(trimString(img?.url)),
          position: Number.isFinite(Number(img?.position))
            ? Number(img?.position)
            : idx + 1,
          altText: trimString(img?.altText),
        }),
      ),
    },
    variants,
  };
}

export function buildAdminShopifyListingProjectionFromState(
  state: any,
  handle: string,
): ShopifyListingProjection | null {
  const listing = state?.listings?.handleToListing?.[handle];
  if (!listing) return null;

  const idToHandle = state?.listings?.idToHandle || {};
  const idToItem = state?.inventory?.idToItem || {};
  const items = Object.entries(idToHandle)
    .filter(
      ([_, listingHandle]) => trimString(listingHandle) === trimString(handle),
    )
    .map(([id]) => (idToItem[id] ? { ...idToItem[id], id } : null))
    .filter((item): item is ItemLike => !!item);

  return buildAdminShopifyListingProjection({ handle, listing, items });
}

export function buildShopifySyncRequestEvent(params: {
  projection: ShopifyListingProjection;
  requestId: string;
  uid: string;
  source: string;
  nowMs: number;
  serverTimestamp: unknown;
}): ShopifySyncRequestEvent {
  const { projection, requestId, uid, source, nowMs, serverTimestamp } = params;
  return {
    eventType: SHOPIFY_SYNC_REQUEST_EVENT,
    requestId,
    handle: projection.handle,
    listing: projection.listing,
    variants: projection.variants,
    source,
    creator: uid,
    requestedBy: uid,
    requestedAt: nowMs,
    payloadVersion: 1,
    createdAtMs: nowMs,
    createdAt: serverTimestamp,
    timestamp: serverTimestamp,
  };
}

export function buildComparableAdminShopifySyncProjection(
  projection: ShopifyListingProjection,
): ComparableShopifyListing {
  const pseudoCatalogListing: ShopifyCatalogListing = {
    productId: "",
    handle: projection.handle,
    title: projection.listing.title,
    bodyHtml: projection.listing.bodyHtml,
    vendor: projection.listing.vendor,
    productType: projection.listing.productType,
    productCategory: projection.listing.productCategory,
    tags: projection.listing.tags,
    status: projection.listing.status as ShopifyCatalogListing["status"],
    option1Name: projection.listing.option1Name,
    updatedAtIso: "",
    updatedAtMs: 0,
    images: buildPostSyncProductImages(projection),
    variants: projection.variants.map((variant) => ({
      id: "",
      sku: variant.sku,
      subtype: variant.subtype,
      price: variant.price,
      janCode: variant.janCode,
      weight: variant.weight,
      inventoryQuantity: variant.available,
      image: variant.image,
    })),
  };

  return buildComparableRemoteListing(pseudoCatalogListing);
}
