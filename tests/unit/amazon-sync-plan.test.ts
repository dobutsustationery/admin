import { describe, it, expect } from "vitest";
import {
  initialAmazonAudit,
  auditScope,
  UK_MARKETPLACE,
} from "../../src/lib/amazon-audit";
import {
  initialPreparation,
  reducePreparation,
  preparationScope,
} from "../../src/lib/amazon-preparation";
import {
  projectAmazonSync,
  batchAmazonSync,
  comparableAmazonAttribute,
} from "../../src/lib/amazon-sync-plan";
import {
  amazonExchangeRate,
  amazonPrice,
  suggestAmazonCategory,
} from "../../src/lib/amazon-defaults";
const {
  validateRequest,
} = require("../../functions/shared/amazon-preparation-worker.cjs");
const {
  needsReadback,
} = require("../../functions/shared/amazon-audit-worker.cjs");
function fixture(shared = false): any {
  const keys = shared
    ? ["4542804115932White", "4542804115932Green"]
    : ["4542804151534"];
  return {
    inventory: {
      idToItem: Object.fromEntries(
        keys.map((key, i) => [
          key,
          {
            id: key,
            janCode: shared ? "4542804115932" : key,
            subtype: shared ? ["White", "Green"][i] : "",
            price: 4,
            qty: 8 + i,
            shipped: 0,
            pieces: 1,
            image: `https://example.com/${i}.png`,
          },
        ]),
      ),
    },
    listings: {
      idToHandle: Object.fromEntries(keys.map((k) => [k, "paper"])),
      handleToListing: {
        paper: {
          handle: "paper",
          title: "Amifa Design Paper (9)",
          bodyHtml: "<p>Japanese decorative paper.</p>",
          productCategory: "Arts & Crafts > Scrapbooking Paper",
          images: [{ url: "https://example.com/0.png", position: 0 }],
          variantOptionsByItemId: shared
            ? Object.fromEntries(keys.map((k, i) => [k, ["White", "Green"][i]]))
            : undefined,
        },
      },
    },
    amazonAudit: { ...structuredClone(initialAmazonAudit), sellerId: "seller" },
    amazonPreparation: structuredClone(initialPreparation),
  };
}
function observe(state: any, entry: any, overrides: any = {}) {
  const attributes = entry.body.attributes;
  state.amazonAudit.observations[
    auditScope("seller", UK_MARKETPLACE, entry.sku)
  ] = {
    sellerId: "seller",
    marketplaceId: UK_MARKETPLACE,
    sku: entry.sku,
    at: 1000,
    status: 200,
    raw: {
      attributes,
      summaries: [
        {
          asin: "B0TESTASIN",
          productType: entry.body.productType,
          status: ["BUYABLE"],
        },
      ],
      offers: [
        {
          price: {
            currencyCode: "GBP",
            amount:
              attributes.purchasable_offer?.[0]?.our_price?.[0]?.schedule?.[0]
                ?.value_with_tax,
          },
        },
      ],
      fulfillmentAvailability: [
        {
          fulfillmentChannelCode: "DEFAULT",
          quantity: attributes.fulfillment_availability?.[0]?.quantity,
        },
      ],
      ...overrides,
    },
  };
}
function request(entries: any[]) {
  return {
    creator: "user",
    sellerId: "seller",
    marketplaceId: UK_MARKETPLACE,
    mode: "sync",
    stockConfirmed: true,
    entries,
  };
}
describe("Amazon issue sync", () => {
  it("defaults to EUR × 1.0, ignores saved trial prices and keeps mappings shared and scoped", () => {
    const s = fixture();
    const key = Object.keys(s.inventory.idToItem)[0];
    s.amazonPreparation.decisions[preparationScope("seller", key)] = {
      priceGBP: "99",
      productType: "OTHER",
    };
    const plan = projectAmazonSync(s);
    expect(plan).toHaveLength(1);
    expect(
      plan[0].entries.presence![0].body.attributes.purchasable_offer[0]
        .our_price[0].schedule[0].value_with_tax,
    ).toBe(4);
    expect(amazonExchangeRate(s.amazonPreparation, "seller")).toBe(1);
    expect(amazonPrice(3.99, 1.2)).toBe(4.79);
    s.amazonPreparation = reducePreparation(s.amazonPreparation, {
      type: "amazonPrepare/categoryMapping",
      payload: {
        sellerId: "seller",
        category: s.listings.handleToListing.paper.productCategory,
        mapping: { productType: "sticker_decal", variationTheme: "STYLE_NAME" },
      },
    });
    expect(projectAmazonSync(s)[0].entries.presence![0].body.productType).toBe(
      "STICKER_DECAL",
    );
    expect(suggestAmazonCategory("Services").productType).toBe("");
  });
  it("bulk creates a complete shared-JAN family with approved exemption and stock defaults", () => {
    const s = fixture(true),
      plan = projectAmazonSync(s),
      batches = batchAmazonSync(plan, "presence");
    expect(batches[0]).toHaveLength(3);
    expect(() => validateRequest(request(batches[0]))).not.toThrow();
    expect(
      batches[0][1].body.attributes
        .supplier_declared_has_product_identifier_exemption[0].value,
    ).toBe(true);
    expect(
      batches[0].find((e) => e.itemKey.endsWith("White"))!.body.attributes
        .fulfillment_availability[0].quantity,
    ).toBe(8);
  });
  it("adds a missing child without re-creating the existing child", () => {
    const s = fixture(true),
      entries = projectAmazonSync(s)[0].entries.presence!;
    observe(s, entries[1]);
    const plan = projectAmazonSync(s),
      batch = batchAmazonSync(plan, "presence")[0];
    expect(batch).toHaveLength(2);
    expect(batch.map((e) => e.sku)).not.toContain(entries[1].sku);
    expect(() => validateRequest(request(batch))).not.toThrow();
  });
  it("reports stock and price differences separately and qty sync never sends images", () => {
    const s = fixture(),
      create = projectAmazonSync(s)[0].entries.presence![0];
    observe(s, create);
    const raw = Object.values(s.amazonAudit.observations)[0] as any;
    raw.raw.offers[0].price.amount = 99;
    raw.raw.fulfillmentAvailability[0].quantity = 2;
    const plan = projectAmazonSync(s);
    expect(plan[0].issues).toEqual(
      expect.arrayContaining(["quantity", "price"]),
    );
    for (const issue of ["quantity", "price"] as const) {
      const entries = batchAmazonSync(plan, issue)[0];
      expect(() => validateRequest(request(entries))).not.toThrow();
      expect(entries[0].body.patches).toHaveLength(1);
      expect(entries[0].body.patches[0].path).toBe(
        issue === "quantity"
          ? "/attributes/fulfillment_availability"
          : "/attributes/purchasable_offer",
      );
    }
  });
  it("shows in-sync after matching readback instead of leaving submitted jobs pending forever", () => {
    const s = fixture(),
      entry = projectAmazonSync(s)[0].entries.presence![0];
    observe(s, entry);
    s.amazonPreparation.jobs.job = {
      id: "job",
      sellerId: "seller",
      marketplaceId: UK_MARKETPLACE,
      entry,
      status: "submitted",
      submittedAt: 500,
      createdAt: 500,
      updatedAt: 600,
    };
    expect(projectAmazonSync(s)[0].issues).toEqual(["offer_unchecked"]);
  });
  it("keeps pending jobs out of subsequent sync requests, includes zero local stock on existing offers", () => {
    const s = fixture(),
      entry = projectAmazonSync(s)[0].entries.presence![0];
    observe(s, entry);
    s.inventory.idToItem[entry.itemKey].qty = 0;
    expect(
      projectAmazonSync(s)[0].entries.quantity![0].body.patches[0].value[0]
        .quantity,
    ).toBe(0);
    s.amazonPreparation.jobs.job = {
      id: "job",
      sellerId: "seller",
      marketplaceId: UK_MARKETPLACE,
      entry,
      status: "publish_queued",
      createdAt: 1000,
    };
    expect(projectAmazonSync(s)[0].issues).toEqual(["processing"]);
    expect(batchAmazonSync(projectAmazonSync(s), "quantity")).toEqual([]);
  });
  it("detects image/metadata differences despite API map ordering, checks them on readback", () => {
    const s = fixture(),
      entry = projectAmazonSync(s)[0].entries.presence![0];
    observe(s, entry);
    const o = Object.values(s.amazonAudit.observations)[0] as any;
    o.raw.attributes = {
      ...o.raw.attributes,
      main_product_image_locator: [
        { media_location: "https://example.com/old.png" },
      ],
    };
    const e = projectAmazonSync(s)[0].entries.variant_image![0];
    expect(() => validateRequest(request([e]))).not.toThrow();
    const expected = {
      attributes: { main_product_image_locator: e.body.patches[0].value },
    };
    // Source URL substitution itself is not evidence of bad images.
    expect(needsReadback(o.raw, 200, expected)).toBe(false);
    o.raw.attributes.main_product_image_locator = e.body.patches[0].value;
    expect(needsReadback(o.raw, 200, expected)).toBe(false);
    expect(
      comparableAmazonAttribute([
        { marketplace_id: "UK", value: "Hello  world", language_tag: "en_GB" },
      ]),
    ).toBe(comparableAmazonAttribute([{ value: "Hello world" }]));
  });
  it("rejects cross-category writes even if the client forges an entry", () => {
    const s = fixture(),
      entry = projectAmazonSync(s)[0].entries.presence![0];
    observe(s, entry);
    s.inventory.idToItem[entry.itemKey].qty = 4;
    const e = projectAmazonSync(s)[0].entries.quantity![0];
    e.body.patches.push({
      op: "replace",
      path: "/attributes/main_product_image_locator",
      value: [{ media_location: "https://example.com/x" }],
    });
    expect(() => validateRequest(request([e]))).toThrow(/only fields/);
  });
  it("keeps families together across batches", () => {
    const s = fixture(true),
      row = projectAmazonSync(s)[0];
    const batches = batchAmazonSync(
      Array.from({ length: 34 }, (_, i) => ({
        ...row,
        handle: String(i),
        entries: {
          presence: row.entries.presence!.map((e) => ({
            ...e,
            sku: e.sku + i,
          })),
        },
      })),
      "presence",
    );
    expect(batches.map((b) => b.length)).toEqual([99, 3]);
  });
});

it("allows existing stock sync with an unmapped category and a missing price", () => {
  const s = fixture(),
    entry = projectAmazonSync(s)[0].entries.presence![0];
  observe(s, entry);
  s.listings.handleToListing.paper.productCategory = "Unknown";
  s.inventory.idToItem[entry.itemKey].price = 0;
  s.inventory.idToItem[entry.itemKey].qty = 0;
  const row = projectAmazonSync(s)[0];
  expect(row.issues).toContain("category");
  expect(row.entries.quantity![0].body.patches[0].value[0].quantity).toBe(0);
  expect(() => validateRequest(request(row.entries.quantity!))).not.toThrow();
});
it("updates family relationships with scoped child PATCHes and an existing reusable parent", () => {
  const s = fixture(true),
    entries = projectAmazonSync(s)[0].entries.presence!;
  for (const e of entries.filter((e) => e.family?.role === "child")) {
    observe(s, e);
    const o =
      s.amazonAudit.observations[auditScope("seller", UK_MARKETPLACE, e.sku)];
    delete o.raw.attributes.child_parent_sku_relationship;
  }
  const batch = batchAmazonSync(projectAmazonSync(s), "variant_structure")[0];
  expect(batch).toHaveLength(3);
  expect(batch[0].family?.role).toBe("parent");
  expect(batch[1].method).toBe("PATCH");
  expect(() => validateRequest(request(batch))).not.toThrow();
  expect(batch[1].body.patches.map((p: any) => p.path)).not.toContain(
    "/attributes/fulfillment_availability",
  );
});

it("combines all supported differences into one SKU write", () => {
  const s = fixture(),
    created = projectAmazonSync(s)[0].entries.presence![0];
  observe(s, created);
  const o =
    s.amazonAudit.observations[
      auditScope("seller", UK_MARKETPLACE, created.sku)
    ];
  o.raw.fulfillmentAvailability[0].quantity = 1;
  o.raw.offers[0].price.amount = 99;
  o.raw.attributes.item_name = [{ value: "Old name" }];
  o.raw.attributes.unit_count = [{ value: 1, type: { value: "count" } }];
  const entries = batchAmazonSync(projectAmazonSync(s), "all")[0];
  expect(entries).toHaveLength(1);
  expect(entries[0].syncIssue).toBe("all");
  expect(entries[0].body.patches.map((p: any) => p.path)).toEqual(
    expect.arrayContaining([
      "/attributes/fulfillment_availability",
      "/attributes/purchasable_offer",
      "/attributes/item_name",
      "/attributes/unit_count",
    ]),
  );
  expect(() => validateRequest(request(entries))).not.toThrow();
});
it("detects non-featured offers separately from buyability and never promises to fix Amazon's decision", () => {
  const s = fixture(),
    created = projectAmazonSync(s)[0].entries.presence![0];
  observe(s, created);
  const key = auditScope("seller", UK_MARKETPLACE, created.sku);
  s.amazonAudit.pricing = {
    [key]: {
      at: 1200,
      status: 200,
      raw: { payload: { Offers: [{ MyOffer: true, IsBuyBoxWinner: false }] } },
    },
  };
  expect(projectAmazonSync(s)[0].issues).toContain("featured_offer");
  expect(projectAmazonSync(s)[0].entries.featured_offer).toBeUndefined();
  s.amazonAudit.pricing[key].raw.payload.Offers[0].IsBuyBoxWinner = true;
  expect(projectAmazonSync(s)[0].issues).toEqual(["synced"]);
});
it("ignores CDN replacement and detects later changes to the recorded source images", () => {
  const s = fixture(),
    created = projectAmazonSync(s)[0].entries.presence![0];
  observe(s, created);
  const key = auditScope("seller", UK_MARKETPLACE, created.sku),
    o = s.amazonAudit.observations[key];
  const source = structuredClone(created.body.attributes);
  o.raw.attributes.main_product_image_locator = [
    { media_location: "https://m.media-amazon.com/images/I/abc.jpg" },
  ];
  s.amazonAudit.imageBaselines = {
    [key]: {
      at: 1001,
      sku: created.sku,
      sources: source,
      remote: structuredClone(o.raw.attributes),
    },
  };
  expect(projectAmazonSync(s)[0].entries.variant_image).toBeUndefined();
  s.inventory.idToItem[created.itemKey].image =
    "https://example.com/replacement.png";
  expect(projectAmazonSync(s)[0].entries.variant_image).toHaveLength(1);
});

it("combines a category correction with other fields without dropping the existing identity", () => {
  const s = fixture(),
    created = projectAmazonSync(s)[0].entries.presence![0];
  observe(s, created);
  const o =
    s.amazonAudit.observations[
      auditScope("seller", UK_MARKETPLACE, created.sku)
    ];
  o.raw.summaries[0].productType = "STICKER_DECAL";
  o.raw.offers[0].price.amount = 99;
  o.raw.fulfillmentAvailability[0].quantity = 0;
  const entries = batchAmazonSync(projectAmazonSync(s), "all")[0];
  expect(entries).toHaveLength(1);
  const e = entries[0];
  expect(e.method).toBe("PUT");
  expect(e.updateExisting).toBe(true);
  expect(e.body.attributes.externally_assigned_product_identifier).toEqual(
    created.body.attributes.externally_assigned_product_identifier,
  );
  expect(e.syncPatches!.map((p: any) => p.path)).toContain(
    "/attributes/fulfillment_availability",
  );
  expect(() => validateRequest(request(entries))).not.toThrow();
});

it.each([false, true])(
  "resubmits a rejected main image even when its source is unchanged (CDN: %s)",
  (cdn) => {
    const s = fixture(),
      created = projectAmazonSync(s)[0].entries.presence![0];
    observe(s, created);
    const key = auditScope("seller", UK_MARKETPLACE, created.sku),
      o = s.amazonAudit.observations[key];
    const source = structuredClone(created.body.attributes);
    if (cdn)
      o.raw.attributes.main_product_image_locator = [
        { media_location: "https://m.media-amazon.com/images/I/rejected.jpg" },
      ];
    s.amazonAudit.imageBaselines = {
      [key]: {
        at: 1001,
        sku: created.sku,
        sources: source,
        remote: structuredClone(o.raw.attributes),
      },
    };
    o.raw.issues = [
      {
        code: "18320",
        severity: "ERROR",
        categories: ["INVALID_IMAGE"],
        message: "The main image is missing or incorrect.",
      },
    ];
    const row = projectAmazonSync(s)[0];
    expect(row.issues).toContain("variant_image");
    expect(row.entries.all![0].body.patches).toContainEqual({
      op: "replace",
      path: "/attributes/main_product_image_locator",
      value: source.main_product_image_locator,
    });
    o.raw.issues = [];
    expect(projectAmazonSync(s)[0].entries.variant_image).toBeUndefined();
  },
);
