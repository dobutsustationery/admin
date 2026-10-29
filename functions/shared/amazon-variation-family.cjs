const UK = "A1F83G8C2ARO7P";
const themes = {
  COLOR: "color",
  STYLE_NAME: "style_name",
  PATTERN_NAME: "pattern_name",
  SIZE_NAME: "size_name",
};
function validateFamilyEntry(e, attributes) {
  const f = e.family;
  if (!f) return false;
  if (
    e.method !== "PUT" ||
    e.body.requirements !== "LISTING" ||
    !f.handle ||
    !["parent", "child"].includes(f.role) ||
    !f.parentSku ||
    f.attribute !== themes[f.theme] ||
    !themes[f.theme] ||
    attributes.parentage_level?.length !== 1 ||
    attributes.parentage_level[0].value !== f.role ||
    attributes.parentage_level[0].marketplace_id !== UK ||
    attributes.variation_theme?.length !== 1 ||
    attributes.variation_theme[0].name !== f.theme ||
    attributes.variation_theme[0].marketplace_id !== UK ||
    String(attributes.brand?.[0]?.value || "").toLowerCase() !== "amifa"
  )
    throw Error("Invalid Amifa variation family, theme or parentage.");
  if (f.role === "parent") {
    if (
      e.sku !== f.parentSku ||
      attributes.purchasable_offer ||
      attributes.fulfillment_availability ||
      attributes.externally_assigned_product_identifier ||
      attributes.supplier_declared_has_product_identifier_exemption ||
      attributes.child_parent_sku_relationship ||
      attributes.skip_offer?.[0]?.value !== true
    )
      throw Error(
        "A variation parent groups children; it must not contain an identifier, price, stock or parent link.",
      );
  } else {
    const link = attributes.child_parent_sku_relationship;
    if (
      e.sku === f.parentSku ||
      link?.length !== 1 ||
      link[0].parent_sku !== f.parentSku ||
      link[0].child_relationship_type !== "variation" ||
      link[0].marketplace_id !== UK ||
      !String(attributes[f.attribute]?.[0]?.value || "").trim()
    )
      throw Error(
        "Each child needs its variation value and the correct parent SKU.",
      );
    const exemption =
      attributes.supplier_declared_has_product_identifier_exemption;
    if (exemption) {
      if (
        exemption.length !== 1 ||
        exemption[0].value !== true ||
        exemption[0].marketplace_id !== UK ||
        !f.exemptionApproved ||
        !String(f.exemptionReference || "").trim() ||
        attributes.externally_assigned_product_identifier
      )
        throw Error(
          "Shared-JAN child creation needs an explicitly confirmed, referenced Amifa GTIN exemption.",
        );
    } else if (
      attributes.externally_assigned_product_identifier?.length !== 1 ||
      !/^\d{13}$/.test(
        attributes.externally_assigned_product_identifier[0]?.value || "",
      ) ||
      attributes.externally_assigned_product_identifier[0]?.type !== "ean" ||
      attributes.externally_assigned_product_identifier[0]?.marketplace_id !==
        UK
    )
      throw Error(
        "Each child needs a distinct manufacturer EAN/JAN or confirmed GTIN exemption.",
      );
  }
  return true;
}
function validateFamilyBatch(entries) {
  const groups = new Map();
  for (const e of entries)
    if (e.family) {
      const key = e.family.parentSku;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
  for (const group of groups.values()) {
    const parents = group.filter((e) => e.family.role === "parent");
    const children = group.filter((e) => e.family.role === "child");
    if (parents.length !== 1 || children.length < 2)
      throw Error(
        "Check the complete family: one parent and at least two children in the same request.",
      );
    const parent = parents[0],
      values = new Set(),
      identifiers = new Set();
    for (const c of children) {
      if (
        c.family.handle !== parent.family.handle ||
        c.family.theme !== parent.family.theme ||
        c.body.productType !== parent.body.productType
      )
        throw Error(
          "All family members must use the same product type and variation theme.",
        );
      const value = String(
        c.body.attributes[c.family.attribute]?.[0]?.value || "",
      )
        .trim()
        .toLowerCase();
      if (values.has(value))
        throw Error("Variation values must be different for each child.");
      values.add(value);
      const id =
        c.body.attributes.externally_assigned_product_identifier?.[0]?.value;
      if (id && identifiers.has(id))
        throw Error("Different Amazon children cannot share the same EAN/JAN.");
      if (id) identifiers.add(id);
    }
  }
}
function matchingParent(response, entry) {
  const a = response?.data?.attributes;
  return (
    response?.status === 200 &&
    a?.parentage_level?.[0]?.value === "parent" &&
    a?.variation_theme?.[0]?.name === entry.family.theme &&
    String(a?.brand?.[0]?.value || "").toLowerCase() === "amifa" &&
    (response.data.summaries || []).some(
      (s) => s.productType === entry.body.productType,
    ) &&
    !(response.data.issues || []).some((i) => i.severity === "ERROR")
  );
}
module.exports = { validateFamilyEntry, validateFamilyBatch, matchingParent };
