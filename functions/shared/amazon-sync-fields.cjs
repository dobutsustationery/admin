const fields = {
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
function validateSyncEntry(e) {
  if (e.method === "PUT") {
    if (
      !["presence", "category", "variant_structure"].includes(e.syncIssue) ||
      e.body.requirements !== "LISTING" ||
      String(e.body.attributes?.brand?.[0]?.value || "").toLowerCase() !==
        "amifa"
    )
      throw Error("Full Amazon sync submissions must be Amifa listings.");
    return;
  }
  const allowed = fields[e.syncIssue];
  if (
    !allowed ||
    !e.body.patches?.length ||
    e.body.patches.some(
      (p) =>
        !allowed.includes(p.path?.replace(/^\/attributes\//, "")) ||
        !p.path.startsWith("/attributes/") ||
        !Array.isArray(p.value) ||
        (p.op !== "replace" &&
          !(e.syncIssue === "gallery" && p.op === "delete")) ||
        (p.op === "replace" && !p.value.length),
    )
  )
    throw Error(
      "Amazon sync may change only fields belonging to the selected issue category.",
    );
}
module.exports = { fields, comparable, validateSyncEntry };
