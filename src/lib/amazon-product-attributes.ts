import definitions from "./amazon-product-requirements.json";
import supplierSpecs from "./amazon-supplier-specs.json";

// Values entered here are product facts, not inventory quantities. They are saved
// in the existing amazonPrepare/decision event and never change stock or photos.
export interface AmazonProductFacts {
  material?: string;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  lengthMetres?: number;
  areaSquareMetres?: number;
  inkBase?: string;
  warranty?: string;
}
export function amazonProductFacts(
  item: any,
  listing: any,
  override: AmazonProductFacts = {},
): AmazonProductFacts {
  const source = (
    supplierSpecs as Record<string, { material: string; specification: string }>
  )[item.janCode];
  const text = `${listing.title || ""} ${listing.bodyHtml || ""}`;
  const spec = (source?.specification || "").normalize("NFKC");
  const measures = [
    ...spec.matchAll(/\b([WHDL])\s*(\d+(?:\.\d+)?)\s*(mm|cm|m)\b/gi),
  ].map((m) => ({
    axis: m[1].toUpperCase(),
    cm: Number(m[2]) * ({ mm: 0.1, cm: 1, m: 100 }[m[3].toLowerCase()] || 1),
    unit: m[3].toLowerCase(),
  }));
  const sizes = measures
    .filter((m) => m.unit !== "m")
    .map((m) => m.cm)
    .sort((a, b) => b - a);
  const metres = measures.find((m) => m.unit === "m")?.cm;
  const sheetCount =
    text.match(/\((\d+)\)/)?.[1] ||
    text.match(/\b(\d+)\s*(?:sheets?|pieces?)\b/i)?.[1];
  const material =
    source?.material ||
    (/^(48|49)/.test(item.hsCode || "")
      ? "Paper"
      : /^39/.test(item.hsCode || "")
        ? "Plastic"
        : "");
  return {
    material,
    ...(sizes.length >= 2 ? { lengthCm: sizes[0], widthCm: sizes[1] } : {}),
    ...(sizes.length >= 3 ? { heightCm: sizes[2] } : {}),
    ...(metres ? { lengthMetres: metres / 100 } : {}),
    ...(!metres && sizes.length >= 2 && sheetCount && /wax paper/i.test(text)
      ? {
          areaSquareMetres: Number(
            ((sizes[0] * sizes[1] * Number(sheetCount)) / 10000).toFixed(6),
          ),
        }
      : {}),
    ...(/water[ -]based/i.test(text)
      ? { inkBase: "water" }
      : /(?:wooden|clear)\b[^.]*\bstamps?/i.test(text) &&
          !/self[ -]inking/i.test(text)
        ? { inkBase: "no_ink" }
        : {}),
    warranty: "No additional manufacturer's warranty is specified.",
    ...override,
  };
}
export const amazonFactLabels: Record<keyof AmazonProductFacts, string> = {
  material: "Material",
  lengthCm: "Length (cm)",
  widthCm: "Width (cm)",
  heightCm: "Height / depth (cm)",
  lengthMetres: "Total tape / roll length (metres)",
  areaSquareMetres: "Total sheet area (square metres)",
  inkBase: "Ink base",
  warranty: "Product warranty",
};
export function amazonFactFields(
  productType: string,
): (keyof AmazonProductFacts)[] {
  const def = (
    definitions as Record<string, { required: string[]; unitTypes: string[] }>
  )[productType];
  if (!def) return [];
  const out: (keyof AmazonProductFacts)[] = [];
  if (def.required.includes("material") || def.required.includes("ingredients"))
    out.push("material");
  if (def.required.includes("item_length_width_height"))
    out.push("lengthCm", "widthCm", "heightCm");
  else if (def.required.includes("item_length")) out.push("lengthCm");
  if (def.required.includes("ink")) out.push("inkBase");
  if (!def.unitTypes.includes("count"))
    out.push(productType === "FOOD_WRAP" ? "areaSquareMetres" : "lengthMetres");
  if (def.required.includes("warranty_description")) out.push("warranty");
  return out;
}
export function missingAmazonProductFacts(
  productType: string,
  item: any,
  listing: any,
  override: AmazonProductFacts = {},
): string[] {
  const facts = amazonProductFacts(item, listing, override);
  return amazonFactFields(productType)
    .filter((k) => {
      // FOOD_WRAP can be sold by roll length or total sheet area.
      if (k === "areaSquareMetres" && Number(facts.lengthMetres) > 0)
        return false;
      const value = facts[k];
      return typeof value === "number"
        ? !Number.isFinite(value) || value <= 0
        : !String(value || "").trim();
    })
    .map((k) => amazonFactLabels[k]);
}
export function amazonCategoryAttributes(params: {
  productType: string;
  item: any;
  listing: any;
  sku: string;
  marketplaceId: string;
  optionLabel?: string;
  packCount: number;
}): Record<string, any[]> {
  const {
    productType,
    item,
    listing,
    sku,
    marketplaceId,
    optionLabel,
    packCount,
  } = params;
  const def = (
    definitions as Record<
      string,
      { fields: string[]; required: string[]; unitTypes: string[] }
    >
  )[productType];
  if (!def) return {};
  const f = amazonProductFacts(item, listing, item.amazonFacts);
  const text = (value: string) => [
    { value, language_tag: "en_GB", marketplace_id: marketplaceId },
  ];
  const value = (value: any) => [{ value, marketplace_id: marketplaceId }];
  const title = String(listing.title || item.description || sku);
  const out: Record<string, any[]> = {
    model_number: value(sku),
    model_name: text(title.replace(/^amifa\s+/i, "").slice(0, 200)),
    number_of_items: value(packCount),
    included_components: text(title.replace(/^amifa\s+/i, "").slice(0, 80)),
    color: text(optionLabel || "Multicoloured"),
    size: text("One Size"),
    style: text(optionLabel || title.replace(/^amifa\s+/i, "").slice(0, 100)),
    department: text("Unisex"),
    warranty_description: text(f.warranty!),
    safety_warning: text(
      "Not suitable for children under 3 years. Small parts may present a choking hazard.",
    ),
    is_fragile: value(/glass|ceramic|porcelain/i.test(f.material || "")),
    hair_type: text("All"),
    lifestyle: text("Mass Beauty"),
    target_audience_keyword: text("Unisex Adult"),
    generic_keyword: text(title.slice(0, 200)),
    item_form: text(
      /bags?/i.test(title) ? "Bag" : /roll/i.test(title) ? "Roll" : "Sheet",
    ),
  };
  if (f.material) out.material = text(f.material);
  if (productType === "CLEANING_PRODUCT" && /cloth/i.test(title)) {
    out.contains_liquid_contents = value(false);
    if (f.material) out.ingredients = text(f.material);
  }
  if (f.inkBase)
    out.ink = [{ marketplace_id: marketplaceId, base: [{ value: f.inkBase }] }];
  const cm = (n: number) => ({ value: n, unit: "centimeters" });
  if (f.lengthCm && f.widthCm && f.heightCm)
    out.item_length_width_height = [
      {
        marketplace_id: marketplaceId,
        length: cm(f.lengthCm),
        width: cm(f.widthCm),
        height: cm(f.heightCm),
      },
    ];
  if (f.lengthCm && f.widthCm)
    out.item_width_height = [
      {
        marketplace_id: marketplaceId,
        width: cm(f.widthCm),
        height: cm(f.lengthCm),
      },
    ];
  if (f.lengthCm)
    out.item_length = [{ marketplace_id: marketplaceId, ...cm(f.lengthCm) }];
  if (!def.unitTypes.includes("count")) {
    const unit =
      productType === "FOOD_WRAP" && !f.lengthMetres ? "square meter" : "meter";
    const amount = unit === "meter" ? f.lengthMetres : f.areaSquareMetres;
    // Never relabel a piece count as a length or an area.
    out.unit_count = amount
      ? [
          {
            marketplace_id: marketplaceId,
            value: amount,
            type: { value: unit, language_tag: "en_GB" },
          },
        ]
      : [];
  }
  return Object.fromEntries(
    Object.entries(out).filter(
      ([field, values]) =>
        def.fields.includes(field) &&
        (def.required.includes(field) || field === "unit_count") &&
        values.length,
    ),
  );
}
