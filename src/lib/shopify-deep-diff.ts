import { generateSku } from "$lib/sku";
import type { Item } from "$lib/inventory";
import type { Listing } from "$lib/listings-slice";
import type {
  ShopifyCatalogListing,
  ShopifyCatalogVariant,
} from "$lib/shopify-catalog-slice";

export interface ComparableImage {
  url: string;
  altText: string;
}

export interface ComparableVariant {
  sku: string;
  subtype: string;
  price: number;
  janCode: string;
  weight: number;
  inventoryQuantity: number;
  image: string;
}

export interface ComparableShopifyListing {
  handle: string;
  title: string;
  bodyHtml: string;
  vendor: string;
  productType: string;
  productCategory: string;
  tags: string[];
  status: "active" | "archived" | "draft";
  option1Name: string;
  galleryImages: ComparableImage[];
  variants: ComparableVariant[];
}

export interface DeepDiffResult {
  matches: boolean;
  mismatchKeys: string[];
}

function trimString(value: unknown): string {
  return String(value || "").trim();
}

function normalizeStatus(value: unknown): "active" | "archived" | "draft" {
  const normalized = trimString(value).toLowerCase();
  if (normalized === "archived") return "archived";
  if (normalized === "draft") return "draft";
  return "active";
}

function normalizeNumber(value: unknown): number {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 1000) / 1000;
}

function canonicalizeBodyHtml(value: unknown): string {
  const raw = trimString(value);
  if (!raw) return "";

  const normalizedEntities = raw.replace(/&nbsp;|&#160;/gi, " ");

  if (typeof DOMParser === "undefined") {
    return normalizedEntities
      .replace(/\u00a0/g, " ")
      .replace(/>\s+</g, "><")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  const doc = new DOMParser().parseFromString(
    `<body>${normalizedEntities}</body>`,
    "text/html",
  );

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    current.textContent = String(current.textContent || "").replace(
      /\u00a0/g,
      " ",
    );
    current = walker.nextNode();
  }

  return doc.body.innerHTML
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\u00a0/g, " ")
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .trim();
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

function normalizeImageUrl(rawUrl: unknown): string {
  const value = trimString(rawUrl);
  if (!value) return "";
  const driveId = extractGoogleDriveFileId(value);
  if (driveId) return `drive:${driveId}`;
  return value.replace(/[#?].*$/, "");
}

function normalizeTags(tags: unknown): string[] {
  const values = Array.isArray(tags) ? tags : [];
  return Array.from(
    new Set(values.map((tag) => trimString(tag).toLowerCase()).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b));
}

function isDefaultishSubtype(value: unknown): boolean {
  const normalized = trimString(value).toLowerCase();
  return (
    !normalized || normalized === "default" || normalized === "default title"
  );
}

function toComparableOption1Name(
  option1Name: unknown,
  variants: Array<{ subtype?: unknown }>,
): string {
  if (variants.length === 1 && isDefaultishSubtype(variants[0]?.subtype)) {
    return "";
  }
  return trimString(option1Name || "Subtype") || "Subtype";
}

function toComparableSubtype(
  subtype: unknown,
  variants: Array<{ subtype?: unknown }>,
): string {
  if (variants.length === 1 && isDefaultishSubtype(variants[0]?.subtype)) {
    return "Default Title";
  }
  return trimString(subtype || "Default") || "Default";
}

function normalizeGalleryImages(
  images: Array<{ url?: unknown; altText?: unknown; position?: unknown }>,
): ComparableImage[] {
  const ordered = (Array.isArray(images) ? images : [])
    .slice()
    .sort((a, b) => Number(a?.position || 0) - Number(b?.position || 0));
  const seen = new Set<string>();
  const result: ComparableImage[] = [];

  ordered.forEach((image) => {
    const url = normalizeImageUrl(image?.url);
    if (!url || seen.has(url)) return;
    seen.add(url);
    result.push({
      url,
      altText: trimString(image?.altText),
    });
  });

  return result;
}

function toComparableVariant(
  variant: {
    sku?: unknown;
    subtype?: unknown;
    price?: unknown;
    janCode?: unknown;
    weight?: unknown;
    inventoryQuantity?: unknown;
    image?: unknown;
  },
  allVariants: Array<{ subtype?: unknown }>,
): ComparableVariant {
  return {
    sku: trimString(variant?.sku),
    subtype: toComparableSubtype(variant?.subtype, allVariants),
    price: normalizeNumber(variant?.price),
    janCode: trimString(variant?.janCode),
    weight: normalizeNumber(variant?.weight),
    inventoryQuantity: normalizeNumber(variant?.inventoryQuantity),
    image: normalizeImageUrl(variant?.image),
  };
}

function isDriveImageIdentity(value: string): boolean {
  return value.startsWith("drive:");
}

function isShopifyCdnImageIdentity(value: string): boolean {
  return value.includes("cdn.shopify.com");
}

function isEquivalentHostedImage(left: string, right: string): boolean {
  if (!left || !right) return left === right;
  return (
    (isDriveImageIdentity(left) && isShopifyCdnImageIdentity(right)) ||
    (isShopifyCdnImageIdentity(left) && isDriveImageIdentity(right))
  );
}

function variantsEqual(
  left: ComparableVariant[],
  right: ComparableVariant[],
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const l = left[i];
    const r = right[i];
    if (l.sku !== r.sku) return false;
    if (l.subtype !== r.subtype) return false;
    if (l.price !== r.price) return false;
    if (l.janCode !== r.janCode) return false;
    if (l.weight !== r.weight) return false;
    if (l.inventoryQuantity !== r.inventoryQuantity) return false;
    if (l.image !== r.image && !isEquivalentHostedImage(l.image, r.image)) {
      return false;
    }
  }
  return true;
}

function imagesEqual(
  left: ComparableImage[],
  right: ComparableImage[],
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const l = left[i];
    const r = right[i];
    if (l.altText !== r.altText) return false;
    if (l.url !== r.url && !isEquivalentHostedImage(l.url, r.url)) {
      return false;
    }
  }
  return true;
}

export function buildComparableLocalListing(params: {
  handle: string;
  listing: Listing;
  items: Item[];
}): ComparableShopifyListing {
  const items = (Array.isArray(params.items) ? params.items : [])
    .map((item) => ({
      sku: generateSku(item.janCode, item.subtype),
      subtype: trimString(item.subtype),
      price: normalizeNumber(item.price),
      janCode: trimString(item.janCode),
      weight: normalizeNumber(item.weight),
      inventoryQuantity: normalizeNumber(item.qty),
      image: trimString(item.image),
    }))
    .sort((a, b) => a.sku.localeCompare(b.sku));

  return {
    handle: trimString(params.handle),
    title: trimString(params.listing?.title),
    bodyHtml: canonicalizeBodyHtml(params.listing?.bodyHtml),
    vendor: trimString(params.listing?.vendor || "SPNSS Ltd."),
    productType: trimString(params.listing?.productType),
    productCategory: trimString(params.listing?.productCategory),
    tags: normalizeTags(params.listing?.tags),
    status: normalizeStatus(params.listing?.status),
    option1Name: toComparableOption1Name(params.listing?.option1Name, items),
    galleryImages: normalizeGalleryImages(params.listing?.images || []),
    variants: items.map((item) => toComparableVariant(item, items)),
  };
}

export function buildComparableRemoteListing(
  listing: ShopifyCatalogListing,
): ComparableShopifyListing {
  const variants = (Array.isArray(listing?.variants) ? listing.variants : [])
    .map((variant) => ({
      sku: trimString(variant?.sku),
      subtype: trimString(variant?.subtype),
      price: normalizeNumber(variant?.price),
      janCode: trimString(variant?.janCode),
      weight: normalizeNumber(variant?.weight),
      inventoryQuantity: normalizeNumber(variant?.inventoryQuantity),
      image: trimString(variant?.image),
    }))
    .sort((a, b) => a.sku.localeCompare(b.sku));

  const variantImageKeys = new Set(
    variants.map((variant) => normalizeImageUrl(variant.image)).filter(Boolean),
  );

  const galleryImages = normalizeGalleryImages(
    (listing?.images || []).filter((image) => {
      const key = normalizeImageUrl(image?.url);
      return !key || !variantImageKeys.has(key);
    }),
  );

  return {
    handle: trimString(listing?.handle),
    title: trimString(listing?.title),
    bodyHtml: canonicalizeBodyHtml(listing?.bodyHtml),
    vendor: trimString(listing?.vendor),
    productType: trimString(listing?.productType),
    productCategory: trimString(listing?.productCategory),
    tags: normalizeTags(listing?.tags),
    status: normalizeStatus(listing?.status),
    option1Name: toComparableOption1Name(listing?.option1Name, variants),
    galleryImages,
    variants: variants.map((variant) => toComparableVariant(variant, variants)),
  };
}

export function diffComparableShopifyListings(
  localListing: ComparableShopifyListing,
  remoteListing: ComparableShopifyListing,
): DeepDiffResult {
  const mismatchKeys: string[] = [];

  if (localListing.handle !== remoteListing.handle) mismatchKeys.push("handle");
  if (localListing.title !== remoteListing.title) mismatchKeys.push("title");
  if (localListing.bodyHtml !== remoteListing.bodyHtml)
    mismatchKeys.push("bodyHtml");
  if (localListing.productType !== remoteListing.productType)
    mismatchKeys.push("productType");
  if (localListing.productCategory !== remoteListing.productCategory)
    mismatchKeys.push("productCategory");
  if (localListing.status !== remoteListing.status) mismatchKeys.push("status");
  if (localListing.option1Name !== remoteListing.option1Name)
    mismatchKeys.push("option1Name");
  if (!imagesEqual(localListing.galleryImages, remoteListing.galleryImages))
    mismatchKeys.push("galleryImages");
  if (!variantsEqual(localListing.variants, remoteListing.variants))
    mismatchKeys.push("variants");

  return {
    matches: mismatchKeys.length === 0,
    mismatchKeys,
  };
}

export function diffLocalListingAgainstShopifyCatalog(params: {
  handle: string;
  listing: Listing;
  items: Item[];
  remoteListing: ShopifyCatalogListing;
}): DeepDiffResult {
  return diffComparableShopifyListings(
    buildComparableLocalListing(params),
    buildComparableRemoteListing(params.remoteListing),
  );
}

export function summarizeRemoteVariants(
  variants: ShopifyCatalogVariant[],
): ComparableVariant[] {
  const safeVariants = Array.isArray(variants) ? variants : [];
  return safeVariants
    .map((variant) =>
      toComparableVariant(
        {
          sku: variant.sku,
          subtype: variant.subtype,
          price: variant.price,
          janCode: variant.janCode,
          weight: variant.weight,
          inventoryQuantity: variant.inventoryQuantity,
          image: variant.image,
        },
        safeVariants,
      ),
    )
    .sort((a, b) => a.sku.localeCompare(b.sku));
}
