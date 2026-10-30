import { buildAmazonListingCreateDraft } from "./amazon-listing-projection";
import {
  preparationScope,
  type PreparationDecision,
  type PreparationEntry,
  type PreparationRow,
  type PreparationState,
} from "./amazon-preparation";
import { UK_MARKETPLACE } from "./amazon-audit";

export const variationThemes = {
  COLOR: { label: "Colour", attribute: "color" },
  STYLE_NAME: { label: "Style / design", attribute: "style_name" },
  PATTERN_NAME: { label: "Pattern", attribute: "pattern_name" },
  SIZE_NAME: { label: "Size", attribute: "size_name" },
};
export const familyDecisionKey = (handle: string) => `@family:${handle}`;
export function familyDecision(
  prep: PreparationState,
  seller: string,
  handle: string,
  drafts: Record<string, PreparationDecision> = {},
): PreparationDecision {
  const key = familyDecisionKey(handle);
  return { ...prep.decisions[preparationScope(seller, key)], ...drafts[key] };
}
export function buildAmazonVariationFamily(params: {
  handle: string;
  rows: PreparationRow[];
  inventory: any;
  listings: any;
  decision: PreparationDecision;
}): { reason: string; entries: PreparationEntry[]; parentSku: string } {
  const { handle, inventory, listings, decision } = params;
  const rows = params.rows.filter((r) => r.row.family === handle);
  const listing = listings?.handleToListing?.[handle];
  const fail = (reason: string) => ({ reason, entries: [], parentSku: "" });
  if (!listing || rows.length < 2)
    return fail("Choose a local listing with at least two variants.");
  if (!/^amifa\b/i.test(listing.title || ""))
    return fail(
      "New variation families are currently supported for Amifa products.",
    );
  if (rows.length > 99)
    return fail("A family can contain up to 99 children per action.");
  const productType = String(decision.productType || "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(productType))
    return fail("Choose the Amazon product type for this family.");
  const theme = decision.variationTheme as keyof typeof variationThemes;
  if (!variationThemes[theme])
    return fail(
      "Choose how the variants differ. Amazon will check whether this theme is supported for the product type.",
    );
  const values = rows.map((r) =>
    String(
      r.decision.variationValue ||
        listing.variantOptionsByItemId?.[r.row.key] ||
        r.row.subtype ||
        "",
    ).trim(),
  );
  if (
    values.some((v) => !v) ||
    new Set(values.map((v) => v.toLowerCase())).size !== values.length
  )
    return fail("Each variant needs a different, non-empty variation value.");
  if (!rows.some((r) => r.row.onHand > 0))
    return fail("This family has no stock to offer.");
  for (const r of rows) {
    if (
      !Number.isInteger(r.row.onHand) ||
      r.row.onHand < 0 ||
      Number(inventory.idToItem[r.row.key]?.pieces || 1) !== 1
    )
      return fail(`Resolve the stock unit for ${r.row.subtype || r.row.key}.`);
    if (
      !(r.price > 0) ||
      !Number.isFinite(r.price) ||
      Math.abs(r.price * 100 - Math.round(r.price * 100)) > 0.000001
    )
      return fail(`Enter a GBP price for ${r.row.subtype || r.row.key}.`);
    if (r.decision.asin)
      return fail(
        "This family contains an existing-ASIN offer selection. Use the offer workflow for that product.",
      );
  }
  const identifiers = rows.map((r) =>
    String(r.decision.identifierEAN || r.row.jan).trim(),
  );
  const counts = identifiers.reduce<Record<string, number>>(
    (m, id) => ({ ...m, [id]: (m[id] || 0) + 1 }),
    {},
  );
  const exempt = rows.map(
    (r, i) =>
      counts[identifiers[i]] > 1 ||
      (r.row.sharedJan && !r.decision.identifierEAN),
  );
  if (exempt.some(Boolean) && !decision.identifierExemption)
    return fail(
      "Shared JANs cannot identify different Amazon children. Enter distinct child EAN/JANs, or choose the approved Amifa GTIN exemption.",
    );
  if (identifiers.some((id, i) => !exempt[i] && !/^\d{13}$/.test(id)))
    return fail("Each non-exempt child needs a 13-digit manufacturer EAN/JAN.");
  const items = rows.map((r) => ({
    itemKey: r.row.key,
    item: inventory.idToItem[r.row.key],
  }));
  const draft = buildAmazonListingCreateDraft({
    handle,
    itemKey: items[0].itemKey,
    item: items[0].item,
    items,
    listing,
    marketplaceId: UK_MARKETPLACE,
    productType,
  });
  if (!draft)
    return fail("Could not build this family from the local listing.");
  const parentSku = draft.submissions[0].sku;
  const entries = draft.submissions.map((s): PreparationEntry => {
    const index = rows.findIndex((r) => r.row.key === s.itemKey);
    const attributes: any = { ...s.payload.attributes };
    // Preserve catalogue defaults and product counts from the shared projection.
    attributes.brand = [
      { value: "Amifa", language_tag: "en_GB", marketplace_id: UK_MARKETPLACE },
    ];
    attributes.variation_theme = [
      { name: theme, marketplace_id: UK_MARKETPLACE },
    ];
    if (s.role === "parent") {
      attributes.skip_offer = [{ value: true, marketplace_id: UK_MARKETPLACE }];
    } else {
      const r = rows[index];
      // The legacy builder assumes colour. Supply the chosen dimension explicitly.
      if (theme !== "COLOR") delete attributes.color;
      attributes[variationThemes[theme].attribute] = [
        {
          value: values[index],
          language_tag: "en_GB",
          marketplace_id: UK_MARKETPLACE,
        },
      ];
      delete attributes.externally_assigned_product_identifier;
      delete attributes.supplier_declared_has_product_identifier_exemption;
      if (exempt[index])
        attributes.supplier_declared_has_product_identifier_exemption = [
          { value: true, marketplace_id: UK_MARKETPLACE },
        ];
      else
        attributes.externally_assigned_product_identifier = [
          {
            type: "ean",
            value: identifiers[index],
            marketplace_id: UK_MARKETPLACE,
          },
        ];
      attributes.purchasable_offer = [
        {
          marketplace_id: UK_MARKETPLACE,
          currency: "GBP",
          our_price: [{ schedule: [{ value_with_tax: r.price }] }],
        },
      ];
      attributes.fulfillment_availability = [
        { fulfillment_channel_code: "DEFAULT", quantity: r.row.onHand },
      ];
    }
    return {
      itemKey: s.role === "parent" ? familyDecisionKey(handle) : s.itemKey,
      sku:
        s.role === "parent"
          ? parentSku
          : rows[index].row.sku || rows[index].row.key,
      method: "PUT",
      body: { productType, requirements: "LISTING", attributes },
      family: {
        handle,
        role: s.role as "parent" | "child",
        parentSku,
        theme,
        attribute: variationThemes[theme].attribute,
        ...(exempt[index]
          ? {
              exemptionApproved: true,
              exemptionReference:
                decision.exemptionReference?.trim() ||
                `Operator selected the approved Amifa GTIN exemption for ${productType} in the UK.`,
            }
          : {}),
      },
    };
  });
  return { reason: "", entries, parentSku };
}
