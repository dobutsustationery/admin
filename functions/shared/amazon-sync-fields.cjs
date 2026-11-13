const fields = {
  attributes: [
    "batteries_required",
    "supplier_declared_dg_hz_regulation",
    "unit_count",
    "number_of_items",
    "model_number",
    "size",
    "safety_warning",
    "condition_type",
    "skip_offer",
    "list_price",
    "country_of_origin",
    "manufacturer",
    "warranty_description",
    "included_components",
    "model_name",
    "style",
    "department",
    "material",
    "ink",
    "item_length_width_height",
    "item_width_height",
    "item_length",
    "is_fragile",
    "contains_liquid_contents",
    "ingredients",
    "hair_type",
    "lifestyle",
    "target_audience_keyword",
    "generic_keyword",
    "item_form",
  ],
  quantity: ["fulfillment_availability"],
  price: ["purchasable_offer"],
  variant_image: ["main_product_image_locator"],
  gallery: Array.from(
    { length: 8 },
    (_, i) => `other_product_image_locator_${i + 1}`,
  ),
  metadata: ["item_name", "product_description", "bullet_point"],
  weight: ["item_package_weight"],
  variant_structure: [
    "parentage_level",
    "variation_theme",
    "child_parent_sku_relationship",
    "color",
    "style_name",
    "pattern_name",
    "size_name",
  ],
};
function comparable(v) {
  return JSON.stringify(v ?? [], (key, value) => {
    if (key === "marketplace_id" || key === "language_tag") return undefined;
    if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, value[k]]),
        )
      : value;
  });
}
const allFields = [...new Set(Object.values(fields).flat())];
function validateSyncEntry(e) {
  if (e.method === "PUT") {
    // The outer request validator checks the exact ASIN and offer-only field set.
    if (
      e.syncIssue === "offer" &&
      e.body.requirements === "LISTING_OFFER_ONLY" &&
      !e.family &&
      !e.updateExisting
    )
      return;
    if (
      !(
        ["presence", "category", "variant_structure"].includes(e.syncIssue) ||
        (e.syncIssue === "all" && e.updateExisting === true)
      ) ||
      e.body.requirements !== "LISTING" ||
      String(e.body.attributes?.brand?.[0]?.value || "").toLowerCase() !==
        "amifa"
    )
      throw Error("Full Amazon sync submissions must be Amifa listings.");
    if (e.updateExisting)
      validateSyncEntry({
        ...e,
        method: "PATCH",
        body: {
          patches: e.syncPatches?.length
            ? e.syncPatches
            : [
                {
                  op: "replace",
                  path: "/attributes/item_name",
                  value: e.body.attributes.item_name,
                },
              ],
        },
      });
    return;
  }
  const allowed = e.syncIssue === "all" ? allFields : fields[e.syncIssue];
  if (
    !allowed ||
    !e.body.patches?.length ||
    e.body.patches.some(
      (p) =>
        !allowed.includes(p.path?.replace(/^\/attributes\//, "")) ||
        !p.path.startsWith("/attributes/") ||
        !Array.isArray(p.value) ||
        (p.op !== "replace" &&
          !(
            ["gallery", "all"].includes(e.syncIssue) &&
            /^\/attributes\/other_product_image_locator_[1-8]$/.test(p.path) &&
            p.op === "delete"
          )) ||
        (p.op === "replace" && !p.value.length),
    )
  )
    throw Error(
      "Amazon sync may change only fields belonging to the selected issue category.",
    );
}
module.exports = { fields, comparable, validateSyncEntry };
