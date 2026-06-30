import { toGoogleDrivePublicImageUrl } from "$lib/drive-url";
import type { Item } from "$lib/inventory";
import type { Listing } from "$lib/listings-slice";
import { generateSku } from "$lib/sku";

type ItemLike = Partial<Item> & { id?: string };
type ListingLike = Partial<Listing>;

type AmazonRequirements =
  | "LISTING"
  | "LISTING_PRODUCT_ONLY"
  | "LISTING_OFFER_ONLY";

export interface AmazonListingSubmission {
  role: "standalone" | "parent" | "child";
  itemKey: string;
  sku: string;
  productType: string;
  requirements: AmazonRequirements;
  payload: {
    attributes: Record<string, unknown[]>;
  };
}

export interface AmazonListingCreateDraft {
  handle: string;
  itemKey: string;
  sku: string;
  productType: string;
  requirements: AmazonRequirements;
  submissions: AmazonListingSubmission[];
  payload: {
    handle: string;
    submissions: AmazonListingSubmission[];
  };
}

function trimString(value: unknown): string {
  return String(value || "").trim();
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stripHtml(value: unknown): string {
  return trimString(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function marketplaceValue(
  marketplaceId: string,
  extra: Record<string, unknown>,
) {
  return {
    marketplace_id: marketplaceId,
    ...extra,
  };
}

function languageValue(
  marketplaceId: string,
  value: string,
  languageTag = "en_GB",
) {
  return marketplaceValue(marketplaceId, {
    value,
    language_tag: languageTag,
  });
}

function compactSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildBulletPoints(listing: ListingLike, item: ItemLike): string[] {
  const candidates = [
    trimString(item.description),
    ...compactSentences(stripHtml(listing.bodyHtml)),
    trimString(listing.title),
  ];
  return candidates
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .filter((entry) => entry.length >= 8)
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .slice(0, 5);
}

function inferPackCount(...values: unknown[]): number {
  for (const value of values) {
    const text = trimString(value);
    const match =
      text.match(/\((\d{1,4})\)/) ||
      text.match(
        /\b(\d{1,4})\s*(?:pcs?|pieces?|sheets?|stickers?|decals?|枚|個)\b/i,
      );
    if (match) {
      const count = Number(match[1]);
      if (Number.isInteger(count) && count > 0) return count;
    }
  }
  return 1;
}

function amazonCountryCode(value: unknown): string {
  const normalized = trimString(value);
  if (!normalized) return "";
  const upper = normalized.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;

  const knownCountries: Record<string, string> = {
    china: "CN",
    japan: "JP",
    "united kingdom": "GB",
    uk: "GB",
    "great britain": "GB",
    "united states": "US",
    usa: "US",
    "united states of america": "US",
    taiwan: "TW",
    korea: "KR",
    "south korea": "KR",
  };
  return knownCountries[normalized.toLowerCase()] || "";
}

function imageUrls(listing: ListingLike, item: ItemLike): string[] {
  const urls = new Set<string>();
  const add = (value: unknown) => {
    const url = toGoogleDrivePublicImageUrl(trimString(value));
    if (url) urls.add(url);
  };

  add(item.image);
  (Array.isArray(listing.images) ? listing.images : [])
    .slice()
    .sort((a, b) => finiteNumber(a?.position) - finiteNumber(b?.position))
    .forEach((image) => add(image?.url));

  return Array.from(urls).slice(0, 9);
}

function inferProductMaker(listing: ListingLike, item: ItemLike): string {
  const candidates = [
    trimString(listing.title),
    trimString(item.description),
    trimString(listing.handle),
  ].filter(Boolean);

  const knownMakers = [
    "Amifa",
    "Furukawa",
    "Zebra",
    "Uni",
    "PLUS",
    "Kobaru",
    "Kyowa",
    "Kalita",
  ];

  for (const maker of knownMakers) {
    const pattern = new RegExp(
      `(^|[^a-z0-9])${maker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
      "i",
    );
    if (candidates.some((candidate) => pattern.test(candidate))) {
      return maker;
    }
  }

  return "";
}

function fnv1aBase36(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function parentSkuForHandle(handle: string): string {
  const safe = trimString(handle)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = fnv1aBase36(safe).slice(0, 8);
  return `P-${safe.slice(0, 28).replace(/-+$/g, "")}-${suffix}`.slice(0, 40);
}

function variationOptionLabel(
  listing: ListingLike,
  itemKey: string,
  item: ItemLike,
): string {
  return (
    trimString(listing.variantOptionsByItemId?.[itemKey]) ||
    trimString(item.subtype) ||
    trimString(item.description) ||
    itemKey
  );
}

function commonProductAttributes(params: {
  marketplaceId: string;
  listing: ListingLike;
  item: ItemLike;
  title: string;
  description: string;
  productMaker: string;
  brand: string;
  includeImages: boolean;
}): Record<string, unknown[]> {
  const {
    marketplaceId,
    listing,
    item,
    title,
    description,
    productMaker,
    brand,
    includeImages,
  } = params;
  const attributes: Record<string, unknown[]> = {
    item_name: [languageValue(marketplaceId, title)],
    brand: [languageValue(marketplaceId, brand)],
    product_description: [languageValue(marketplaceId, description)],
    batteries_required: [marketplaceValue(marketplaceId, { value: false })],
    supplier_declared_dg_hz_regulation: [
      marketplaceValue(marketplaceId, { value: "not_applicable" }),
    ],
  };

  const bulletPoints = buildBulletPoints(listing, item);
  if (bulletPoints.length > 0) {
    attributes.bullet_point = bulletPoints.map((value) =>
      languageValue(marketplaceId, value),
    );
  }

  const countryOfOrigin = amazonCountryCode(item.countryOfOrigin);
  if (countryOfOrigin) {
    attributes.country_of_origin = [
      marketplaceValue(marketplaceId, { value: countryOfOrigin }),
    ];
  }

  if (productMaker) {
    attributes.manufacturer = [languageValue(marketplaceId, productMaker)];
  }

  if (includeImages) {
    const images = imageUrls(listing, item);
    if (images[0]) {
      attributes.main_product_image_locator = [
        marketplaceValue(marketplaceId, { media_location: images[0] }),
      ];
    }
    images.slice(1, 9).forEach((url, index) => {
      attributes[`other_product_image_locator_${index + 1}`] = [
        marketplaceValue(marketplaceId, { media_location: url }),
      ];
    });
  }

  return attributes;
}

function buyableAttributes(params: {
  marketplaceId: string;
  item: ItemLike;
  listing: ListingLike;
  janCode: string;
  sku: string;
  optionLabel?: string;
  productType: string;
  currencyCode: string;
  useProductIdentifierExemption?: boolean;
}): Record<string, unknown[]> {
  const {
    marketplaceId,
    item,
    listing,
    janCode,
    sku,
    optionLabel,
    productType,
    currencyCode,
    useProductIdentifierExemption,
  } = params;
  const price = finiteNumber(item.price);
  const available = Math.max(
    0,
    finiteNumber(item.qty) - finiteNumber(item.shipped),
  );
  const weightGrams = finiteNumber(item.weight);
  const packCount = inferPackCount(
    item.description,
    listing.title,
    listing.bodyHtml,
  );
  const attributes: Record<string, unknown[]> = {
    condition_type: [marketplaceValue(marketplaceId, { value: "new_new" })],
    skip_offer: [marketplaceValue(marketplaceId, { value: false })],
    fulfillment_availability: [
      {
        fulfillment_channel_code: "DEFAULT",
        quantity: available,
      },
    ],
    part_number: [marketplaceValue(marketplaceId, { value: sku })],
    unit_count: [
      marketplaceValue(marketplaceId, {
        value: packCount,
        type: {
          value: "count",
          language_tag: "en_GB",
        },
      }),
    ],
  };

  if (useProductIdentifierExemption) {
    attributes.supplier_declared_has_product_identifier_exemption = [
      marketplaceValue(marketplaceId, { value: true }),
    ];
  } else {
    attributes.externally_assigned_product_identifier = [
      marketplaceValue(marketplaceId, {
        type: "ean",
        value: janCode,
      }),
    ];
  }

  if (productType === "STICKER_DECAL") {
    attributes.model_number = [marketplaceValue(marketplaceId, { value: sku })];
    attributes.size = [languageValue(marketplaceId, "One Size")];
    attributes.color = [
      languageValue(marketplaceId, trimString(optionLabel) || "Multicoloured"),
    ];
    attributes.number_of_items = [
      marketplaceValue(marketplaceId, { value: packCount }),
    ];
    attributes.safety_warning = [
      languageValue(
        marketplaceId,
        "Not suitable for children under 3 years. Small parts may present a choking hazard.",
      ),
    ];
  }

  if (price > 0) {
    attributes.list_price = [
      marketplaceValue(marketplaceId, {
        currency: currencyCode,
        value_with_tax: price,
      }),
    ];
    attributes.purchasable_offer = [
      marketplaceValue(marketplaceId, {
        currency: currencyCode,
        our_price: [
          {
            schedule: [
              {
                value_with_tax: price,
              },
            ],
          },
        ],
      }),
    ];
  }

  if (weightGrams > 0) {
    attributes.item_package_weight = [
      marketplaceValue(marketplaceId, {
        value: Math.round(weightGrams * 1000) / 1000,
        unit: "grams",
      }),
    ];
  }

  return attributes;
}

function variationAttributes(params: {
  marketplaceId: string;
  role: "parent" | "child";
  optionLabel?: string;
  parentSku?: string;
}): Record<string, unknown[]> {
  const { marketplaceId, role, optionLabel, parentSku } = params;
  const attributes: Record<string, unknown[]> = {
    parentage_level: [marketplaceValue(marketplaceId, { value: role })],
    variation_theme: [marketplaceValue(marketplaceId, { name: "COLOR" })],
  };
  if (role === "child" && parentSku) {
    attributes.child_parent_sku_relationship = [
      marketplaceValue(marketplaceId, {
        child_relationship_type: "variation",
        parent_sku: parentSku,
      }),
    ];
    if (optionLabel) {
      attributes.color = [languageValue(marketplaceId, optionLabel)];
    }
  }
  return attributes;
}

function buildSubmission(params: {
  role: AmazonListingSubmission["role"];
  handle: string;
  itemKey: string;
  item: ItemLike;
  listing: ListingLike;
  marketplaceId: string;
  productType: string;
  requirements: AmazonRequirements;
  currencyCode: string;
  parentSku?: string;
  optionLabel?: string;
  useProductIdentifierExemption?: boolean;
}): AmazonListingSubmission | null {
  const {
    role,
    itemKey,
    item,
    listing,
    marketplaceId,
    productType,
    requirements,
    currencyCode,
    parentSku,
    optionLabel,
    useProductIdentifierExemption,
  } = params;
  const janCode = trimString(item.janCode);
  const sku =
    role === "parent"
      ? parentSkuForHandle(params.handle)
      : generateSku(janCode, trimString(item.subtype));
  if (!sku || (role !== "parent" && !janCode)) return null;

  const optionSuffix =
    role === "child" && optionLabel ? ` - ${optionLabel}` : "";
  const title = `${trimString(listing.title || item.description || sku)}${optionSuffix}`;
  const description =
    stripHtml(listing.bodyHtml) || trimString(item.description) || title;
  const productMaker = inferProductMaker(listing, item);
  const brand = productMaker || "Generic";
  const attributes = commonProductAttributes({
    marketplaceId,
    listing,
    item,
    title,
    description,
    productMaker,
    brand,
    includeImages: role !== "parent",
  });

  if (role === "standalone" || role === "child") {
    Object.assign(
      attributes,
      buyableAttributes({
        marketplaceId,
        item,
        listing,
        janCode,
        sku,
        optionLabel,
        productType,
        currencyCode,
        useProductIdentifierExemption,
      }),
    );
  }

  if (role === "parent" || role === "child") {
    Object.assign(
      attributes,
      variationAttributes({
        marketplaceId,
        role,
        optionLabel,
        parentSku,
      }),
    );
  }

  return {
    role,
    itemKey,
    sku,
    productType,
    requirements,
    payload: { attributes },
  };
}

export function buildAmazonListingCreateDraft(params: {
  handle: string;
  itemKey: string;
  listing: ListingLike | null | undefined;
  item: ItemLike | null | undefined;
  items?: { itemKey: string; item: ItemLike }[];
  marketplaceId: string;
  productType?: string;
  requirements?: AmazonRequirements;
  currencyCode?: string;
}): AmazonListingCreateDraft | null {
  const handle = trimString(params.handle);
  const selectedItemKey = trimString(params.itemKey);
  const listing = params.listing;
  const selectedItem = params.item;
  const marketplaceId = trimString(params.marketplaceId) || "A1F83G8C2ARO7P";
  if (!handle || !selectedItemKey || !listing || !selectedItem) return null;

  const productType = trimString(params.productType || "PRODUCT").toUpperCase();
  const requirements = params.requirements || "LISTING";
  const currencyCode = trimString(params.currencyCode || "GBP") || "GBP";
  const rawItems = (
    Array.isArray(params.items) && params.items.length
      ? params.items
      : [{ itemKey: selectedItemKey, item: selectedItem }]
  )
    .map(({ itemKey, item }) => ({
      itemKey: trimString(itemKey),
      item,
      optionLabel: variationOptionLabel(listing, trimString(itemKey), item),
    }))
    .filter(({ itemKey, item }) => itemKey && trimString(item?.janCode));

  if (!rawItems.length) return null;

  rawItems.sort((a, b) => {
    const optionCompare = a.optionLabel.localeCompare(b.optionLabel);
    return optionCompare || a.itemKey.localeCompare(b.itemKey);
  });

  const janCounts = rawItems.reduce<Record<string, number>>((acc, entry) => {
    const janCode = trimString(entry.item?.janCode);
    if (janCode) acc[janCode] = (acc[janCode] || 0) + 1;
    return acc;
  }, {});
  const duplicateJanCodes = new Set(
    Object.entries(janCounts)
      .filter(([, count]) => count > 1)
      .map(([janCode]) => janCode),
  );

  const parentSku = parentSkuForHandle(handle);
  const submissions =
    rawItems.length === 1
      ? [
          buildSubmission({
            role: "standalone",
            handle,
            itemKey: rawItems[0].itemKey,
            item: rawItems[0].item,
            listing,
            marketplaceId,
            productType,
            requirements,
            currencyCode,
          }),
        ]
      : [
          buildSubmission({
            role: "parent",
            handle,
            itemKey: handle,
            item: selectedItem,
            listing,
            marketplaceId,
            productType,
            requirements,
            currencyCode,
            parentSku,
          }),
          ...rawItems.map(({ itemKey, item, optionLabel }) =>
            buildSubmission({
              role: "child",
              handle,
              itemKey,
              item,
              listing,
              marketplaceId,
              productType,
              requirements,
              currencyCode,
              parentSku,
              optionLabel,
              useProductIdentifierExemption: duplicateJanCodes.has(
                trimString(item?.janCode),
              ),
            }),
          ),
        ];

  const safeSubmissions = submissions.filter(
    (entry): entry is AmazonListingSubmission => !!entry,
  );
  if (!safeSubmissions.length) return null;

  return {
    handle,
    itemKey: selectedItemKey,
    sku: safeSubmissions[0].sku,
    productType,
    requirements,
    submissions: safeSubmissions,
    payload: {
      handle,
      submissions: safeSubmissions,
    },
  };
}

export function buildAmazonListingCreateDraftFromState(params: {
  state: any;
  handle: string;
  itemKey: string;
  marketplaceId: string;
  productType?: string;
  requirements?: AmazonRequirements;
  currencyCode?: string;
}): AmazonListingCreateDraft | null {
  const listing = params.state?.listings?.handleToListing?.[params.handle];
  const selectedItem = params.state?.inventory?.idToItem?.[params.itemKey];
  const idToHandle = params.state?.listings?.idToHandle || {};
  const idToItem = params.state?.inventory?.idToItem || {};
  const items = Object.entries(idToHandle)
    .filter(([, handle]) => handle === params.handle)
    .map(([itemKey]) => ({ itemKey, item: idToItem[itemKey] }))
    .filter(({ item }) => !!item);
  if (
    selectedItem &&
    !items.some(({ itemKey }) => itemKey === params.itemKey)
  ) {
    items.push({ itemKey: params.itemKey, item: selectedItem });
  }

  return buildAmazonListingCreateDraft({
    handle: params.handle,
    itemKey: params.itemKey,
    listing,
    item: selectedItem,
    items,
    marketplaceId: params.marketplaceId,
    productType: params.productType,
    requirements: params.requirements,
    currencyCode: params.currencyCode,
  });
}
