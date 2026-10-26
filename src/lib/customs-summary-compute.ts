import { HS_CODE_DESCRIPTIONS } from "./hscodes";
import { CUSTOMS_BG } from "./customs-summary-descriptions";
import type {
  Cell,
  CustomsProduct,
  CustomsProjection,
  CustomsReport,
  CustomsSource,
} from "./customs-summary-model";

const text = (v: unknown) =>
  String(v ?? "")
    .normalize("NFKC")
    .trim();
const header = (v: unknown) => text(v).toLowerCase().replace(/\s+/g, " ");
export const identifier = (v: unknown) => {
  const s = text(v).replace(/\s/g, "");
  if (/^\d+$/.test(s)) return s;
  if (/^\d+(\.\d+)?(e\+?\d+)?$/i.test(s) && Number.isSafeInteger(Number(s)))
    return String(Number(s));
  return s;
};
const num = (v: unknown) => {
  // Sheets formula results can contain normal floating-point tails.
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : NaN;
  const s = text(v);
  return /^\d+(\.\d+)?$/.test(s) && Number.isFinite(Number(s))
    ? Number(s)
    : NaN;
};
const compare = (a: string, b: string) =>
  a.localeCompare(b, "en", { numeric: true });
const originName = (s: string) =>
  ({ jp: "Japan", japan: "Japan", cn: "China", china: "China" })[
    s.toLowerCase()
  ] || s;
// Integer millionths retain supplier decimal precision before group rounding.
const units = (n: number) => Math.round(n * 1e6);
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
function apportioned(values: number[], total: number, scale: number): number[] {
  const base = values.map((v) => Math.floor(v * scale + 1e-9));
  const remainder = Math.round(total * scale) - sum(base);
  const order = values
    .map((v, i) => ({ i, r: v * scale - base[i] }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let j = 0; j < remainder; j++) base[order[j % order.length].i]++;
  return base.map((v) => v / scale);
}

function mapping(source: CustomsSource, shipping: boolean) {
  const label = `${shipping ? "Shipping" : "Order"} source "${source.name}", tab "${source.tab}" (gid ${source.sheetId})`;
  const janHeader = shipping
    ? /^(jan[ _-]?code|bar-code no\.|item no\.)$/
    : /^(jan[ _-]?code|bar-code no\.)$/;
  const h = source.rows.findIndex((r) =>
    r.some((v) => janHeader.test(header(v))),
  );
  if (h < 0)
    throw new Error(
      `${label}: JAN header not found. Expected "JAN code" or "Bar-Code No.".`,
    );
  const first = source.rows[h].map(header);
  const senshu =
    first.includes("description") &&
    first.includes("materials") &&
    first.includes("ex-factory") &&
    first.includes("unit");
  const twoRows =
    senshu &&
    !shipping &&
    !text(source.rows[h + 1]?.[first.findIndex((v) => janHeader.test(v))]) &&
    source.rows[h + 1]?.some((v) => /weight.*gr/i.test(text(v)));
  const columns = first.map((v, i) =>
    twoRows ? header(`${v} ${text(source.rows[h + 1]?.[i])}`) : v,
  );

  const find = (re: RegExp) => columns.findIndex((v) => re.test(v));
  const m = {
    jan: find(janHeader),
    qty: find(
      shipping
        ? /delivery quantity|shipped.*pcs|^packing \(unit\)$/
        : /order.*q.*pcs|^total pcs$/,
    ),
    description: find(/product name|product description|^description$/),
    manufacturer: find(/manufacturer/),
    material: find(/^materials?$/),
    origin: find(/country of origin|place of origin|^origin$/),
    weight: find(
      /weight in grams|per piece.*\(g\)|^unit weight \(\s*gr?\s*\)$/,
    ),
    // Amifa UNIT Price is the pack price; PCS Price must take precedence.
    price:
      find(/^pcs price jpy$/) >= 0
        ? find(/^pcs price jpy$/)
        : find(/wholesale price|unit price/),
    piecesPerPack: find(/^q'ty per unit$/),
    total: find(/total wholesale|^amount$/),
    totalWeight: find(/^total weight/),
    carton: find(/box number|carton|^ctn no\.$/),
    hs: find(/hs[ -]?code/),
  };
  if (senshu) {
    m.qty = shipping
      ? columns.findIndex(
          (v, i) => v === "total" && columns[i + 1] === "ex-factory",
        )
      : find(/^total pcs$/);
    if (!shipping) {
      m.price = find(/^ex-factory jpy$/);
      m.total = find(/^total amount jpy$/);
    }
  }
  const required = shipping
    ? [
        { index: m.qty, name: "shipped quantity in pieces" },
        { index: m.carton, name: "carton number" },
      ]
    : [
        { index: m.qty, name: "ordered quantity in pieces" },
        { index: m.price, name: "price per piece" },
        { index: m.origin, name: "country of origin" },
        { index: m.weight, name: "weight per piece in grams" },
      ];
  const missing = required
    .filter((field) => field.index < 0)
    .map((field) => field.name);
  if (missing.length)
    throw new Error(
      `${label}, header row ${h + 1}: unrecognized or missing ${missing.join(", ")}. Found headers: ${source.rows[
        h
      ]
        .filter((v) => text(v))
        .map((v) => text(v).replace(/\s+/g, " "))
        .join("; ")}.`,
    );
  const packingUnits = shipping && columns[m.qty] === "packing (unit)";
  return { h: h + (twoRows ? 1 : 0), m, packingUnits, senshu };
}
function invoice(s: CustomsSource, headerRow: number): string {
  for (const r of s.rows.slice(0, headerRow)) {
    const i = r.findIndex((v) => /invoice\s*no/i.test(text(v)));
    if (i >= 0) {
      const inline = text(r[i])
        .replace(/^.*?invoice\s*no\.?\s*:?\s*/i, "")
        .trim();
      return inline || text(r.slice(i + 1).find((v) => text(v)));
    }
  }
  return "";
}

export function computeCustoms(report: CustomsReport): CustomsProjection {
  const p: CustomsProjection = {
    invoice: "",
    products: [],
    allocations: [],
    groups: [],
    cartons: [],
    issues: [],
    excluded: [],
    totals: { pieces: 0, yen: 0, netKg: 0, grossKg: null },
    ready: false,
    tables: {},
  };
  if (!report.input) {
    p.issues.push("Choose and read both source spreadsheets.");
    return p;
  }
  const { order, shipping, dictionary } = report.input;
  try {
    const om = mapping(order, false),
      sm = mapping(shipping, true);
    p.invoice = invoice(order, om.h);
    if (!p.invoice || p.invoice !== invoice(shipping, sm.h))
      p.issues.push(
        "Invoice numbers are missing or do not match. Correct the sources and read them again.",
      );
    const descriptions: Record<string, { en: string; bg: string }> = {};
    for (const [code, en] of Object.entries(HS_CODE_DESCRIPTIONS))
      descriptions[code] = { en, bg: CUSTOMS_BG[code] || "" };
    for (const r of dictionary?.rows.slice(1) || []) {
      const code = identifier(r[0]);
      if (/^\d{8}$/.test(code))
        descriptions[code] = {
          en: text(r[3]) || text(r[1]),
          bg: CUSTOMS_BG[code] || text(r[4]) || text(r[2]),
        };
    }
    const index = new Map<string, CustomsProduct>();
    const footerTotals: {
      row: number;
      qty: number;
      yen: number;
      grams: number;
    }[] = [];
    let senshuFooter = false;
    let senshuCharges = 0;
    let senshuGrandTotal: number | null = null;
    for (let i = om.h + 1; i < order.rows.length; i++) {
      const row = order.rows[i],
        m = om.m,
        jan = identifier(row[m.jan]);
      if (om.senshu && senshuFooter) {
        if (/^\d{8,14}$/.test(jan) && num(row[m.qty]) > 0)
          p.issues.push(
            `Order row ${i + 1}: product appears after the subtotal; review source layout`,
          );
        if (/^domestic\s+logistic\s+charge/i.test(text(row[m.description]))) {
          const charge = num(row[m.total]);
          if (!Number.isFinite(charge))
            p.issues.push(`Order row ${i + 1}: invalid logistics charge`);
          else senshuCharges += charge;
        }
        if (row.some((v) => /^grand total$/i.test(text(v))))
          senshuGrandTotal = num(row[m.total]);
        if (row.some((v) => text(v)))
          p.excluded.push(
            `Order row ${i + 1}: non-product charges/payment/footer`,
          );
        continue;
      }
      if (om.senshu && row.some((v) => /^sub total$/i.test(text(v))))
        senshuFooter = true;
      if (!jan && !text(row[m.description])) {
        if (
          (Number.isFinite(num(row[m.qty])) &&
            Number.isFinite(num(row[m.total]))) ||
          num(row[m.totalWeight]) > 0
        ) {
          footerTotals.push({
            row: i + 1,
            qty: num(row[m.qty]),
            yen: num(row[m.total]),
            grams: num(row[m.totalWeight]),
          });
        }
        if (row.some((v) => text(v)))
          p.excluded.push(`Order row ${i + 1}: blank/product-free footer`);
        continue;
      }
      // Supplier terms below the table are not product rows. Never skip a
      // numeric product ID or a row with quantity, cost or weight data.
      if (
        jan &&
        !/^\d+$/.test(jan) &&
        !text(row[m.description]) &&
        [m.qty, m.price, m.total, m.weight, m.totalWeight, m.origin].every(
          (col) => !text(row[col]),
        )
      ) {
        p.excluded.push(`Order row ${i + 1}: supplier notes/terms`);
        continue;
      }
      const qty = num(row[m.qty]);
      if (!/^\d{8,14}$/.test(jan) || !Number.isSafeInteger(qty) || qty < 0) {
        p.issues.push(
          `Order row ${i + 1}: invalid JAN or whole-piece quantity`,
        );
        continue;
      }
      if (qty === 0) {
        p.excluded.push(`Order row ${i + 1}: zero quantity`);
        continue;
      }
      if (index.has(jan)) {
        p.issues.push(
          `Order row ${i + 1}: duplicate JAN ${jan}; consolidate or disambiguate in the source`,
        );
        continue;
      }
      const d = report.decisions[jan] || {};
      const facts = Object.values(report.inventoryFacts).filter(
        (v) => identifier(v.janCode) === jan,
      );
      const codes = [...new Set(facts.map((v) => v.hsCode))];
      const sourceCode = identifier(row[m.hs]);
      const established = codes.length === 1 ? codes[0] : "";
      const code = d.code ?? (sourceCode || established);
      if (
        !d.code &&
        sourceCode &&
        facts.some((v) => v.hsCode && v.hsCode !== sourceCode)
      )
        p.issues.push(
          `${jan}: source and inventory HS codes disagree; choose a code`,
        );
      const product: CustomsProduct = {
        jan,
        qty,
        row: i + 1,
        description: text(row[m.description]),
        manufacturer: text(row[m.manufacturer]),
        material: text(row[m.material]),
        origin: originName(d.origin ?? text(row[m.origin])),
        grams: num(d.grams ?? row[m.weight]),
        price: num(row[m.price]),
        code,
        en: d.en || descriptions[code]?.en || "",
        bg: d.bg || descriptions[code]?.bg || "",
        basis: d.code
          ? "User accepted / entered"
          : sourceCode
            ? "Source spreadsheet"
            : established
              ? "Existing inventory"
              : "Needs review",
        suggestions: [],
      };
      if (
        !Number.isFinite(product.grams) ||
        product.grams <= 0 ||
        !Number.isFinite(product.price) ||
        product.price < 0 ||
        !product.origin
      )
        p.issues.push(
          `${jan}: valid unit grams, price and origin are required`,
        );
      if (
        m.total >= 0 &&
        text(row[m.total]) &&
        (!Number.isFinite(num(row[m.total])) ||
          Math.abs(num(row[m.total]) - qty * product.price) > 0.000001)
      )
        p.issues.push(
          `${jan}: invoice line total differs from quantity × wholesale price; resolve in source`,
        );
      if (
        m.totalWeight >= 0 &&
        text(row[m.totalWeight]) &&
        (!Number.isFinite(num(row[m.totalWeight])) ||
          Math.abs(num(row[m.totalWeight]) - qty * num(row[m.weight])) >
            0.000001)
      )
        p.issues.push(
          `${jan}: supplier total grams differs from quantity × unit grams; resolve in source`,
        );
      if (!code) {
        for (const prior of report.previousClassifications || []) {
          if (
            prior.jan === jan &&
            header(prior.description) === header(product.description) &&
            header(prior.material) === header(product.material) &&
            !product.suggestions.some((s) => s.code === prior.code)
          )
            product.suggestions.push({
              code: prior.code,
              en: prior.en,
              bg: prior.bg,
              reason: `Previously accepted for this product in ${prior.reportName}`,
            });
        }
        const tokens = new Set(
          header(product.description)
            .split(/[^\p{L}\p{N}]+/u)
            .filter((s) => s.length > 3),
        );
        const similar = Object.values(report.inventoryFacts).filter(
          (v) =>
            descriptions[v.hsCode] &&
            header(v.description)
              .split(/[^\p{L}\p{N}]+/u)
              .filter((s) => tokens.has(s)).length >= 3,
        );
        for (const v of similar)
          if (!product.suggestions.some((s) => s.code === v.hsCode))
            product.suggestions.push({
              code: v.hsCode,
              reason: `Similar classified inventory: ${v.description}`,
            });
        const rules: [RegExp, string][] = [
          [/notebook|memo pad|sticky note/i, "48201030"],
          [/sticker/i, "48211010"],
          [/postcard|greeting card/i, "49090000"],
          [/scissors/i, "82130000"],
          [/ball.?point/i, "96081010"],
          [/marker|felt.?tip/i, "96082000"],
          [/mechanical pencil/i, "96084000"],
          [/fountain pen/i, "96083000"],
          [/ink pad/i, "96122000"],
          [/stamp(?!.*sticker)/i, "96110000"],
          [/envelope/i, "48171000"],
          [/masking tape|washi tape/i, "48114190"],
        ];
        for (const [rule, candidate] of rules)
          if (
            rule.test(product.description) &&
            !product.suggestions.some((s) => s.code === candidate)
          )
            product.suggestions.push({
              code: candidate,
              reason: "Description match — check material and intended use",
            });
        product.suggestions = product.suggestions.slice(0, 3);
      }
      index.set(jan, product);
      p.products.push(product);
    }
    for (const f of footerTotals) {
      if (
        (Number.isFinite(f.qty) &&
          f.qty !== sum(p.products.map((v) => v.qty))) ||
        (Number.isFinite(f.yen) &&
          Math.abs(
            f.yen - sum(p.products.map((v) => v.qty * units(v.price))) / 1e6,
          ) > 0.000001)
      )
        p.issues.push(
          `Order totals row ${f.row} disagrees with product quantities/value; resolve source totals`,
        );
      if (
        Number.isFinite(f.grams) &&
        Math.abs(
          f.grams -
            sum(
              p.products.map(
                (v) => v.qty * num(order.rows[v.row - 1][om.m.weight]),
              ),
            ),
        ) > 0.000001
      )
        p.issues.push(
          `Order totals row ${f.row} disagrees with supplier product weights`,
        );
    }
    if (
      senshuGrandTotal !== null &&
      (!Number.isFinite(senshuGrandTotal) ||
        Math.abs(
          senshuGrandTotal -
            sum(p.products.map((v) => v.qty * v.price)) -
            senshuCharges,
        ) > 0.000001)
    )
      p.issues.push(
        "Invoice grand total disagrees with goods plus logistics charges",
      );
    const shipped = new Map<string, number>();
    const seenShipping = new Set<string>();
    let carriedCarton = "";
    let shippingFooter = false;
    for (let i = sm.h + 1; i < shipping.rows.length; i++) {
      const row = shipping.rows[i],
        m = sm.m,
        jan = identifier(row[m.jan]);
      if (sm.senshu && shippingFooter) {
        if (/^\d{8,14}$/.test(jan) && num(row[m.qty]) > 0)
          p.issues.push(
            `Shipping row ${i + 1}: product appears after the subtotal; review source layout`,
          );
        if (row.some((v) => text(v)))
          p.excluded.push(
            `Shipping row ${i + 1}: non-product charges/payment/footer`,
          );
        continue;
      }
      if (sm.senshu && !jan && num(row[m.qty]) > 0) shippingFooter = true;
      if (!jan && !text(row[m.description])) {
        if (row.some((v) => text(v)))
          p.excluded.push(`Shipping row ${i + 1}: blank/product-free footer`);
        continue;
      }
      let qty = num(row[m.qty]);
      let carton = identifier(row[m.carton]);
      if (sm.packingUnits || sm.senshu) {
        // These supplier layouts leave repeated carton cells blank within a group.
        if (carton) carriedCarton = carton;
        else carton = carriedCarton;
      }
      if (sm.packingUnits) {
        const product = index.get(jan);
        const packSize = product
          ? num(order.rows[product.row - 1][om.m.piecesPerPack])
          : NaN;
        if (
          !Number.isSafeInteger(packSize) ||
          packSize <= 0 ||
          !Number.isSafeInteger(qty) ||
          qty < 0
        ) {
          p.issues.push(
            `Shipping source "${shipping.name}", tab "${shipping.tab}", row ${i + 1}: packing units require a whole-pack quantity and a positive whole-number Q'ty per UNIT on the matching invoice row (${jan}).`,
          );
          continue;
        }
        qty *= packSize;
      }
      if (qty === 0) {
        p.excluded.push(`Shipping row ${i + 1}: zero quantity`);
        continue;
      }
      if (
        !/^\d{8,14}$/.test(jan) ||
        !Number.isSafeInteger(qty) ||
        qty <= 0 ||
        !/^[\p{L}\p{N}]+$/u.test(carton)
      ) {
        p.issues.push(
          `Shipping row ${i + 1}: valid JAN, positive pieces and a single carton ID required (expand continuation/split rows in source)`,
        );
        continue;
      }
      const key = `${jan}/${qty}/${carton}`;
      if (seenShipping.has(key))
        p.issues.push(
          `Shipping row ${i + 1}: duplicate allocation; verify source`,
        );
      seenShipping.add(key);
      const product = index.get(jan);
      if (!product) {
        p.issues.push(
          `Shipping row ${i + 1}: ${jan} is absent from valid order rows`,
        );
        continue;
      }
      shipped.set(jan, (shipped.get(jan) || 0) + qty);
      const yenUnits = qty * units(product.price),
        weightUnits = qty * units(product.grams);
      if (
        !Number.isSafeInteger(yenUnits) ||
        !Number.isSafeInteger(weightUnits)
      ) {
        p.issues.push(`${jan}: invalid or excessively large amount/weight`);
        continue;
      }
      p.allocations.push({
        jan,
        orderRow: product.row,
        shippingRow: i + 1,
        carton,
        qty,
        yen: yenUnits / 1e6,
        netKg: weightUnits / 1e9,
      });
    }
    for (const product of p.products) {
      if (shipped.get(product.jan) !== product.qty)
        p.issues.push(
          `${product.jan}: ordered ${product.qty}, shipped ${shipped.get(product.jan) || 0}; resolve shipment scope in the sources`,
        );
      if (!/^\d{8}$/.test(product.code) || !product.en || !product.bg)
        p.issues.push(
          `${product.jan}: accept/enter an eight-digit HS code with English and Bulgarian descriptions`,
        );
    }
    for (const a of p.allocations) {
      let c = p.cartons.find((v) => v.id === a.carton);
      if (!c) {
        c = { id: a.carton, pieces: 0, yen: 0, netKg: 0 };
        p.cartons.push(c);
      }
      c.pieces += a.qty;
      c.yen += a.yen;
      c.netKg += a.netKg;
      const product = index.get(a.jan)!;
      const key = JSON.stringify([product.code, product.origin]);
      let g = p.groups.find((v) => v.key === key);
      if (!g) {
        g = {
          key,
          code: product.code,
          en: product.en,
          bg: product.bg,
          origin: product.origin,
          pieces: 0,
          yen: 0,
          netKg: 0,
          grossKg: null,
          cartons: [],
        };
        p.groups.push(g);
      }
      if (g.en !== product.en || g.bg !== product.bg)
        p.issues.push(
          `${product.code}: conflicting descriptions within the same HS/origin group`,
        );
      g.pieces += a.qty;
      g.yen += a.yen;
      g.netKg += a.netKg;
      if (!g.cartons.includes(a.carton)) g.cartons.push(a.carton);
    }
    p.groups.sort(
      (a, b) => compare(a.code, b.code) || compare(a.origin, b.origin),
    );
    p.cartons.sort((a, b) => compare(a.id, b.id));
    p.groups.forEach((g) => g.cartons.sort(compare));
    p.totals.pieces = sum(p.allocations.map((a) => a.qty));
    p.totals.yen = Math.round(
      sum(p.allocations.map((a) => units(a.yen))) / 1e6,
    );
    const net = sum(p.allocations.map((a) => a.netKg));
    p.totals.netKg = Math.round(net * 1000) / 1000;
    if (!p.allocations.length) p.issues.push("No valid shipped products.");
    if (!report.settingsConfirmed)
      p.issues.push(
        "Save measurements and the package convention for the current source data.",
      );
    let gross = num(report.settings.grossKg);
    if (report.settings.grossMethod === "carton") {
      const measurements = p.cartons.map((c) =>
        num(report.settings.cartonGross[c.id]),
      );
      gross = sum(measurements);
      if (
        p.cartons.some(
          (c, i) =>
            !Number.isFinite(measurements[i]) ||
            measurements[i] < c.netKg - 1e-9,
        )
      )
        gross = NaN;
    }
    if (
      !Number.isFinite(gross) ||
      gross < net - 1e-9 ||
      gross <= 0 ||
      !report.settings.grossSource.trim()
    )
      p.issues.push(
        "Provide measured gross weight (at least net weight) and its source; per-carton mode requires every carton.",
      );
    else if (net > 0) {
      p.totals.grossKg = Math.round(gross * 1000) / 1000;
      for (const g of p.groups) {
        g.grossKg =
          report.settings.grossMethod === "shipment"
            ? (g.netKg * gross) / net
            : sum(
                p.allocations
                  .filter(
                    (a) =>
                      JSON.stringify([
                        index.get(a.jan)!.code,
                        index.get(a.jan)!.origin,
                      ]) === g.key,
                  )
                  .map(
                    (a) =>
                      (a.netKg * num(report.settings.cartonGross[a.carton])) /
                      p.cartons.find((c) => c.id === a.carton)!.netKg,
                  ),
              );
      }
      const rounded = apportioned(
        p.groups.map((g) => g.grossKg!),
        p.totals.grossKg,
        1000,
      );
      p.groups.forEach((g, i) => (g.grossKg = rounded[i]));
    }
    if (report.settings.packagePolicy !== "cartons")
      p.issues.push(
        "Confirm the package convention: cartons containing each commodity (counts are non-additive).",
      );
    if (p.groups.length) {
      const weights = apportioned(
        p.groups.map((g) => g.netKg),
        p.totals.netKg,
        1000,
      );
      const values = apportioned(
        p.groups.map((g) => g.yen),
        p.totals.yen,
        1,
      );
      p.groups.forEach((g, i) => {
        g.netKg = weights[i];
        g.yen = values[i];
      });
    }
    p.issues = [...new Set(p.issues)];
    p.ready = !p.issues.length;
    const summary: Cell[][] = [
      [`Customs summary — ${p.invoice}`, p.ready ? "READY" : "DRAFT"],
      [
        "Unique cartons",
        p.cartons.length,
        "Gross method",
        report.settings.grossMethod,
      ],
      ["Gross measurement source", report.settings.grossSource],
      [
        "Packages count cartons containing each commodity; do not sum this column.",
      ],
      [],
      [
        "HS CODE",
        "Description of commodity in English",
        "Description of commodity in Bulgarian",
        "Origin Country",
        "Number of Pieces",
        "Number of Packages",
        "Net weight (kg)",
        "Gross weight (kg)",
        "Value as per invoice currency (YEN)",
      ],
    ];
    for (const g of p.groups)
      summary.push([
        g.code || "Unclassified — action required",
        g.en,
        g.bg,
        g.origin,
        g.pieces,
        report.settings.packagePolicy ? g.cartons.length : "Required",
        g.netKg,
        g.grossKg ?? "Required",
        g.yen,
      ]);
    summary.push([
      "TOTAL",
      "",
      "",
      "",
      p.totals.pieces,
      "Non-additive",
      p.totals.netKg,
      p.totals.grossKg ?? "Required",
      p.totals.yen,
    ]);
    while (summary.length < Math.max(34, p.groups.length + 11))
      summary.push([]);
    summary.push([
      "HS CODE",
      "English",
      "Bulgarian",
      "Origin Country",
      "Contained in Carton Number",
    ]);
    for (const g of p.groups)
      summary.push([
        g.code || "Unclassified",
        g.en,
        g.bg,
        g.origin,
        g.cartons.join(", "),
      ]);
    p.tables = {
      "Ognyan Summary": summary,
      "Normalised Data": [
        [
          "JAN",
          "Product",
          "HS",
          "Origin",
          "Carton",
          "Pieces",
          "JPY (unrounded)",
          "Net kg (unrounded)",
          "Order row",
          "Shipping row",
          "Classification source",
        ],
        ...p.allocations.map((a) => {
          const v = index.get(a.jan)!;
          return [
            a.jan,
            v.description,
            v.code,
            v.origin,
            a.carton,
            a.qty,
            a.yen,
            a.netKg,
            a.orderRow,
            a.shippingRow,
            v.basis,
          ];
        }),
      ],
      Cartons: [
        ["Carton", "Pieces", "JPY", "Net kg", "Measured gross kg"],
        ...p.cartons.map((c) => [
          c.id,
          c.pieces,
          c.yen,
          c.netKg,
          report.settings.cartonGross[c.id] || "",
        ]),
      ],
      "Sources and Checks": [
        ["Report", report.id],
        [
          "Order",
          `https://docs.google.com/spreadsheets/d/${order.id}/edit#gid=${order.sheetId}`,
          order.name,
          order.tab,
          order.modifiedTime || "",
        ],
        [
          "Shipping",
          `https://docs.google.com/spreadsheets/d/${shipping.id}/edit#gid=${shipping.sheetId}`,
          shipping.name,
          shipping.tab,
          shipping.modifiedTime || "",
        ],
        ["Revision", report.revision],
        ["Status", p.ready ? "READY" : "DRAFT"],
        ...p.issues.map((s) => ["Issue", s]),
        ...p.excluded.map((s) => ["Excluded", s]),
        ...Object.entries(report.decisions).map(([jan, d]) => [
          "User decision",
          jan,
          JSON.stringify(d),
        ]),
      ],
    };
  } catch (e) {
    p.issues.push(e instanceof Error ? e.message : String(e));
  }
  return p;
}
