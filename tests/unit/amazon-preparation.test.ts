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
  emptyPreparationDraft,
  preparationDraftScope,
  draftHasChanges,
} from "../../src/lib/amazon-preparation";
describe("durable preparation drafts", () => {
  const event = (type: string, draft: any, owner = "user") => ({
    type: `amazonPrepare/${type}`,
    payload: { sellerId: "seller", owner, draft },
  });
  const draft = {
    ...emptyPreparationDraft(),
    revision: 1,
    token: "one",
    decisions: { [jan]: { priceGBP: "7.50", included: false, deferred: true } },
    gbpPerEur: "0.80",
    view: {
      active: true,
      query: "cards",
      tab: "issues",
      pricingOpen: true,
      reviewedJobIds: [],
    },
  };
  it("replays all work without applying choices or making Amazon requests", () => {
    const prep = reducePreparation(
      initialPreparation,
      event("draftSaved", draft),
    );
    expect(prep.drafts[preparationDraftScope("seller", "user")]).toEqual(draft);
    expect(prep.decisions).toEqual({});
    expect(prep.policies).toEqual({});
    expect(prep.jobs).toEqual({});
    expect(draftHasChanges(draft)).toBe(true);
  });
  it("applies choices together and keeps the user's place", () => {
    const prep = reducePreparation(
      initialPreparation,
      event("draftApplied", draft),
    );
    expect(Object.values(prep.decisions)[0]).toEqual(draft.decisions[jan]);
    expect(Object.values(prep.policies)[0]).toEqual({ gbpPerEur: "0.80" });
    const saved = prep.drafts[preparationDraftScope("seller", "user")];
    expect(draftHasChanges(saved)).toBe(false);
    expect(saved.view.query).toBe("cards");
    expect(prep.jobs).toEqual({});
  });
  it("discards only draft work, preserves applied choices, and rejects stale recovery events", () => {
    let prep = decision(initialPreparation, { priceGBP: "6" });
    prep = reducePreparation(prep, event("draftSaved", draft));
    prep = reducePreparation(
      prep,
      event("draftDiscarded", { ...draft, revision: 2, token: "two" }),
    );
    prep = reducePreparation(prep, event("draftSaved", draft));
    expect(Object.values(prep.decisions)[0].priceGBP).toBe("6");
    const saved = prep.drafts[preparationDraftScope("seller", "user")];
    expect(draftHasChanges(saved)).toBe(false);
    expect(saved.view.active).toBe(false);
    expect(saved.view.query).toBe("");
  });
  it("keeps drafts separate for each user", () => {
    let prep = reducePreparation(
      initialPreparation,
      event("draftSaved", draft),
    );
    prep = reducePreparation(
      prep,
      event(
        "draftSaved",
        { ...draft, decisions: {}, view: { ...draft.view, query: "other" } },
        "sister",
      ),
    );
    expect(
      prep.drafts[preparationDraftScope("seller", "user")].view.query,
    ).toBe("cards");
    expect(
      prep.drafts[preparationDraftScope("seller", "sister")].view.query,
    ).toBe("other");
  });
});
it("replays an applied choice even if a newer draft view arrived first", () => {
  const make = (type: string, revision: number, decisions: any) => ({
    type: `amazonPrepare/${type}`,
    payload: {
      sellerId: "seller",
      owner: "user",
      draft: {
        ...emptyPreparationDraft(),
        revision,
        token: String(revision),
        decisions,
      },
    },
  });
  let prep = reducePreparation(initialPreparation, make("draftSaved", 3, {}));
  prep = reducePreparation(
    prep,
    make("draftApplied", 2, { [jan]: { priceGBP: "7" } }),
  );
  expect(Object.values(prep.decisions)[0].priceGBP).toBe("7");
  expect(prep.drafts[preparationDraftScope("seller", "user")].revision).toBe(3);
  prep = decision(prep, { priceGBP: "8" });
  prep = reducePreparation(
    prep,
    make("draftApplied", 2, { [jan]: { priceGBP: "7" } }),
  );
  expect(Object.values(prep.decisions)[0].priceGBP).toBe("8");
});
