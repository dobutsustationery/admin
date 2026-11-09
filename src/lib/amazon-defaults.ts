import { auditScope, UK_MARKETPLACE } from "./amazon-audit";

export interface AmazonCategoryMapping {
  productType: string;
  variationTheme: string;
}
export const amazonCategoryScope = (seller: string, category: string) =>
  auditScope(seller, UK_MARKETPLACE, category);
export function isAmifa(listing: any, item: any = {}) {
  return [
    item.brand,
    item.manufacturer,
    listing?.vendor,
    listing?.title,
    item.description,
  ].some((v) => /^amifa\b/i.test(String(v || "").trim()));
}
// Suggestions are editable defaults. Specific leaves precede broader categories.
const suggestions: [RegExp, string, string?][] = [
  [/Decorative Stickers$/i, "STICKER_DECAL"],
  [/(Origami Paper|Scrapbooking Paper)$/i, "SHEET_PAPER"],
  [/Sticky Notes$/i, "SELF_STICK_NOTE"],
  [/(Pocket Notebooks|Notebooks|Spiral.*Notebook)$/i, "BLANK_BOOK"],
  [/(Notepads|Notebooks & Notepads)$/i, "BLANK_BOOK"],
  [/Decorative Tape$/i, "ADHESIVE_TAPES"],
  [/(Greeting Cards|Post Cards)$/i, "GREETING_CARD"],
  [/Envelopes$/i, "ENVELOPE"],
  [/Stationery$/i, "WRITING_PAPER"],
  [
    /(Pen & Pencil Cases|Travel Organizer Bags|Travel Pouches)$/i,
    "CARRIER_BAG_CASE",
  ],
  [/(File Folders|Folders & Report Covers)$/i, "FILE_FOLDER"],
  [/Decorative Stamps$/i, "RUBBER_STAMP"],
  [/Paper Clips$/i, "PAPER_CLIP_CLAMP"],
  [/(Wax Paper|Food Wraps)$/i, "FOOD_WRAP"],
  [/Paper Napkins$/i, "DISPOSABLE_NAPKIN"],
  [/(Desk Calendars|Wall Calendars)$/i, "CALENDAR"],
  [/Planners$/i, "PLANNER"],
  [/Gift Bags$/i, "GIFT_WRAP"],
  [/Gift Tags & Labels$/i, "LABEL"],
  [/Bookmarks$/i, "BOOKMARK"],
  [/Craft Magnets$/i, "DECORATIVE_MAGNET"],
  [/Hair Pins, Claws & Clips$/i, "HAIR_CLIP"],
  [/Eyewear Cleaning Cloths$/i, "CLEANING_PRODUCT"],
  [/Clipboards$/i, "CLIPBOARD"],
  [/Magnifiers$/i, "MAGNIFIER"],
  [/Decorative Trays$/i, "TRAY"],
  [/Ballpoint Pens$/i, "WRITING_INSTRUMENT"],
  [/Markers$/i, "WRITING_INSTRUMENT"],
  [/Holiday Ornaments$/i, "HANGING_ORNAMENT"],
  [/Card Cases$/i, "CARD_DOCUMENT_SLEEVE"],
  [/Freezer Accessories$/i, "FOOD_STORAGE_BAG"],
];
export function suggestAmazonCategory(category: string): AmazonCategoryMapping {
  const match = suggestions.find(([test]) => test.test(category));
  return {
    productType: match?.[1] || "",
    variationTheme: match?.[2] || "COLOR",
  };
}
export function categoryMapping(
  prep: any,
  seller: string,
  category: string,
): AmazonCategoryMapping {
  return (
    prep?.categoryMappings?.[amazonCategoryScope(seller, category)] ||
    suggestAmazonCategory(category)
  );
}
export function amazonExchangeRate(prep: any, seller: string) {
  const value =
    prep?.policies?.[auditScope(seller, UK_MARKETPLACE, "")]?.gbpPerEur;
  return value === undefined || value === "" ? 1 : Number(value);
}
export function amazonPrice(eur: unknown, rate: number) {
  return Math.round((Number(eur) * rate + Number.EPSILON) * 100) / 100;
}
export function amazonCategoryRows(state: any, seller: string) {
  const counts = new Map<
    string,
    { category: string; products: number; example: string }
  >();
  for (const listing of Object.values(
    state.listings.handleToListing || {},
  ) as any[]) {
    if (!isAmifa(listing)) continue;
    const category = String(listing.productCategory || "");
    const old = counts.get(category) || {
      category,
      products: 0,
      example: listing.title,
    };
    counts.set(category, { ...old, products: old.products + 1 });
  }
  return [...counts.values()]
    .map((r) => ({
      ...r,
      ...categoryMapping(state.amazonPreparation, seller, r.category),
      saved:
        !!state.amazonPreparation?.categoryMappings?.[
          amazonCategoryScope(seller, r.category)
        ],
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}
