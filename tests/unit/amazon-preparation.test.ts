import { describe, it, expect } from "vitest";
import {
  initialPreparation,
  reducePreparation,
  projectPreparation,
  previewValid,
} from "../../src/lib/amazon-preparation";
import {
  initialAmazonAudit,
  projectAmazonAudit,
  auditScope,
  UK_MARKETPLACE,
} from "../../src/lib/amazon-audit";
const jan = "4542804151480";
function fixture(shared = false, existing = false) {
  const inventory = {
    idToItem: {
      [jan]: {
        janCode: jan,
        description: "Amifa cards",
        qty: 5,
        shipped: 1,
        pieces: 1,
        price: 9,
      },
      ...(shared
        ? { second: { janCode: jan, description: "Amifa other", qty: 3 } }
        : {}),
    },
  };
  const listings = {
    idToHandle: { [jan]: "cards" },
    handleToListing: { cards: { title: "Amifa cards" } },
  };
  const audit = {
    ...initialAmazonAudit,
    sellerId: "seller",
    observations: existing
      ? {
          [auditScope("seller", UK_MARKETPLACE, jan)]: {
            sellerId: "seller",
            marketplaceId: UK_MARKETPLACE,
            sku: jan,
            at: 1,
            id: "a",
            status: 200,
            raw: {
              summaries: [
                {
                  asin: "BTEST",
                  status: ["BUYABLE"],
                  productType: "GREETING_CARD",
                },
              ],
              offers: [{ price: { currencyCode: "GBP", amount: 6 } }],
              fulfillmentAvailability: [
                { fulfillmentChannelCode: "DEFAULT", quantity: 2 },
              ],
            },
          },
        }
      : {},
  };
  audit.rows = projectAmazonAudit(audit, inventory, listings);
  return { audit, inventory, listings };
}
const decision = (prep: any, d: any, sellerId = "seller") =>
  reducePreparation(prep, {
    type: "amazonPrepare/decision",
    payload: { sellerId, itemKey: jan, decision: d },
  });
describe("Amazon preparation from durable inputs", () => {
  it("requires explicit GBP prices; never relabels local EUR", () => {
    const f = fixture();
    let prep = decision(initialPreparation, { productType: "GREETING_CARD" });
    expect(
      projectPreparation(prep, f.audit, f.inventory, f.listings)[0].reason,
    ).toContain("GBP price");
    prep = reducePreparation(prep, {
      type: "amazonPrepare/policy",
      payload: { sellerId: "seller", gbpPerEur: "0.8" },
    });
    const r = projectPreparation(prep, f.audit, f.inventory, f.listings)[0];
    expect(r.price).toBe(7.2);
    expect(r.entry?.method).toBe("PUT");
    expect(r.entry?.body.attributes.fulfillment_availability[0].quantity).toBe(
      4,
    );
    expect(
      r.entry?.body.attributes
        .supplier_declared_has_product_identifier_exemption,
    ).toBeUndefined();
    expect(r.entry?.body.attributes.safety_warning).toBeUndefined();
    expect(r.entry?.body.attributes.list_price).toBeUndefined();
    prep = decision(prep, { priceGBP: "8.50" });
    expect(
      projectPreparation(prep, f.audit, f.inventory, f.listings)[0].price,
    ).toBe(8.5);
  });
  it("leaves shared-JAN creations blocked while allowing verified existing offers", () => {
    const prep = decision(initialPreparation, {
      priceGBP: "8",
      productType: "GREETING_CARD",
    });
    let f = fixture(true);
    expect(
      projectPreparation(prep, f.audit, f.inventory, f.listings).find(
        (r) => r.row.key === jan,
      )?.reason,
    ).toContain("Shared JAN");
    f = fixture(true, true);
    expect(
      projectPreparation(prep, f.audit, f.inventory, f.listings).find(
        (r) => r.row.key === jan,
      )?.entry?.method,
    ).toBe("PATCH");
  });
  it("patches only changed offer fields and skips no-op updates", () => {
    const f = fixture(false, true);
    const r = projectPreparation(
      initialPreparation,
      f.audit,
      f.inventory,
      f.listings,
    )[0];
    expect(r.entry?.body.patches.map((p: any) => p.path)).toEqual([
      "/attributes/fulfillment_availability",
    ]);
    f.inventory.idToItem[jan].qty = 3;
    f.audit.rows = projectAmazonAudit(f.audit, f.inventory, f.listings);
    expect(
      projectPreparation(
        initialPreparation,
        f.audit,
        f.inventory,
        f.listings,
      )[0].entry,
    ).toBeNull();
  });
  it("persists later/resume decisions independently, scoped to seller", () => {
    const f = fixture(false, true);
    let prep = decision(initialPreparation, { deferred: true });
    expect(
      projectPreparation(prep, f.audit, f.inventory, f.listings)[0].reason,
    ).toBe("Set aside for later.");
    prep = decision(prep, { deferred: false });
    expect(
      projectPreparation(prep, f.audit, f.inventory, f.listings)[0].entry,
    ).not.toBeNull();
    prep = decision(prep, { deferred: true }, "other-seller");
    expect(
      projectPreparation(prep, f.audit, f.inventory, f.listings)[0].entry,
    ).not.toBeNull();
  });
  it("retains the newest raw result through out-of-order replay", () => {
    const job = {
      id: "job",
      updatedAt: 10,
      revision: 2,
      validation: {
        status: 200,
        data: { status: "VALID", issues: [{ severity: "WARNING" }] },
      },
    };
    let prep = reducePreparation(initialPreparation, {
      type: "amazonPrepare/job",
      payload: job,
    });
    prep = reducePreparation(prep, {
      type: "amazonPrepare/job",
      payload: { ...job, revision: 1, validation: null },
    });
    expect(previewValid(prep.jobs.job)).toBe(true);
    expect(
      previewValid({
        validation: { status: 200, data: { status: "ACCEPTED" } },
      }),
    ).toBe(false);
  });
});

import {
  preparationDraftScope,
  draftHasChanges,
} from "../../src/lib/amazon-preparation";
describe("incremental preparation draft actions", () => {
  const event = (kind: string, revision: number, fields = {}) => ({
    type: `amazonPrepare/${kind}`,
    payload: {
      sellerId: "seller",
      owner: "user",
      revision,
      token: String(revision),
      ...fields,
    },
  });
  const edit = (
    revision: number,
    field: string,
    value: unknown,
    itemKey = jan,
  ) => event("draftDecisionChanged", revision, { itemKey, field, value });
  const draftOf = (prep: any) =>
    prep.drafts[preparationDraftScope("seller", "user")];
  it("reconstructs edits from small actions without repeating earlier input", () => {
    let prep = reducePreparation(
      initialPreparation,
      edit(1, "priceGBP", "7.50"),
    );
    const second = edit(2, "included", false, "second");
    expect(second.payload).not.toHaveProperty("draft");
    expect(JSON.stringify(second)).not.toContain("7.50");
    prep = reducePreparation(prep, second);
    prep = reducePreparation(
      prep,
      event("draftPricingChanged", 3, { value: "0.8" }),
    );
    prep = reducePreparation(
      prep,
      event("draftViewChanged", 4, {
        changes: { active: true, query: "cards", tab: "issues" },
      }),
    );
    expect(draftOf(prep).decisions).toEqual({
      [jan]: { priceGBP: "7.50" },
      second: { included: false },
    });
    expect(draftOf(prep).gbpPerEur).toBe("0.8");
    expect(draftOf(prep).view.query).toBe("cards");
    expect(prep.decisions).toEqual({});
    expect(prep.jobs).toEqual({});
  });
  it("apply is a marker that commits the reconstructed draft, and ignores duplicate delivery", () => {
    let prep = reducePreparation(
      initialPreparation,
      edit(1, "priceGBP", "7.50"),
    );
    prep = reducePreparation(
      prep,
      event("draftPricingChanged", 2, { value: "0.8" }),
    );
    const apply = event("draftApplied", 3);
    expect(Object.keys(apply.payload).sort()).toEqual([
      "owner",
      "revision",
      "sellerId",
      "token",
    ]);
    prep = reducePreparation(prep, apply);
    expect(Object.values(prep.decisions)[0].priceGBP).toBe("7.50");
    expect(Object.values(prep.policies)[0].gbpPerEur).toBe("0.8");
    expect(draftHasChanges(draftOf(prep))).toBe(false);
    expect(reducePreparation(prep, apply)).toBe(prep);
  });
  it("discard resets only draft work; later edits start afresh", () => {
    let prep = decision(initialPreparation, { priceGBP: "6" });
    prep = reducePreparation(prep, edit(1, "priceGBP", "7.50"));
    prep = reducePreparation(prep, event("draftDiscarded", 2));
    expect(draftHasChanges(draftOf(prep))).toBe(false);
    expect(Object.values(prep.decisions)[0].priceGBP).toBe("6");
    prep = reducePreparation(prep, edit(3, "deferred", true));
    expect(draftOf(prep).decisions[jan]).toEqual({ deferred: true });
  });
  it("keeps user drafts separate and invalidates stock approval on an edit", () => {
    let prep = reducePreparation(
      initialPreparation,
      event("draftViewChanged", 1, { changes: { reviewedJobIds: ["job"] } }),
    );
    prep = reducePreparation(prep, edit(2, "included", false));
    expect(draftOf(prep).view.reviewedJobIds).toEqual([]);
    const other = edit(3, "priceGBP", "8");
    other.payload.owner = "sister";
    prep = reducePreparation(prep, other);
    expect(draftOf(prep).decisions[jan]).toEqual({ included: false });
  });
});
