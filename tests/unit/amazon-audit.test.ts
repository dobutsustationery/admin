import { describe, expect, it } from "vitest";
import {
  initialAmazonAudit,
  reduceAmazonAudit,
  projectAmazonAudit,
  listingHealth,
  auditScope,
  UK_MARKETPLACE as market,
} from "$lib/amazon-audit";
import { rootReducer } from "$lib/root-reducer";
const inventory = {
  idToItem: {
    blue: {
      janCode: "123",
      subtype: "Blue",
      description: "Amifa letter set",
      qty: 9,
      shipped: 2,
    },
    green: {
      janCode: "123",
      subtype: "Green",
      description: "Amifa letter set",
      qty: 8,
      shipped: 0,
    },
    other: { janCode: "999", description: "Zebra pen", qty: 3 },
  },
};
const job = (sellerId = "seller", startedAt = 10) => ({
  type: "amazonAudit/job",
  payload: {
    id: String(startedAt),
    sellerId,
    marketplaceId: market,
    startedAt,
    updatedAt: startedAt,
    mode: "catalogue",
    status: "waiting",
    pages: 0,
    count: 0,
  },
});
const item = {
  sku: "blue",
  summaries: [{ asin: "B000", status: ["BUYABLE"] }],
  offers: [
    { marketplaceId: market, price: { amount: 4, currencyCode: "GBP" } },
  ],
  fulfillmentAvailability: [{ fulfillmentChannelCode: "DEFAULT", quantity: 7 }],
};
function page(
  state: any,
  raw: any,
  at = 100,
  sellerId = "seller",
  reverse = false,
) {
  const responseId = `${sellerId}-${at}`;
  const events = [
    {
      type: "amazonAudit/chunk",
      payload: { responseId, index: 0, json: JSON.stringify(raw) },
    },
    {
      type: "amazonAudit/response",
      payload: {
        responseId,
        chunks: 1,
        sellerId,
        marketplaceId: market,
        at,
        status: 200,
      },
    },
  ];
  for (const e of reverse ? events.reverse() : events)
    state = reduceAmazonAudit(state, e);
  return state;
}
describe("Amifa audit replay", () => {
  it("reassembles response-before-chunk input, scopes sellers and refuses stale observations", () => {
    let s = reduceAmazonAudit(undefined, job());
    s = page(s, { items: [item] }, 100, "seller", true);
    s = page(s, { items: [{ ...item, summaries: [] }] }, 50);
    s = page(s, { items: [{ ...item, summaries: [] }] }, 200, "other-seller");
    const rows = projectAmazonAudit(s, inventory, {});
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.key === "blue")).toMatchObject({
      health: "Active",
      price: "GBP 4",
      quantity: 7,
      onHand: 7,
      sharedJan: true,
      checkedAt: 100,
    });
    expect(rows.find((r) => r.key === "green")).toMatchObject({
      health: "Not linked",
      sku: "",
    });
    expect(s.chunks).toEqual({});
  });
  it("does not confuse acceptance, zero stock, parents, or explicit blocking errors", () => {
    expect(listingHealth({ status: "ACCEPTED" }).health).toBe("Processing");
    expect(
      listingHealth({
        issues: [
          { severity: "ERROR", code: "8560", message: "Identifier missing" },
        ],
      }),
    ).toMatchObject({
      health: "Needs attention",
      detail: expect.stringContaining("8560"),
    });
    expect(
      listingHealth({
        fulfillmentAvailability: [
          { fulfillmentChannelCode: "DEFAULT", quantity: 0 },
        ],
      }).health,
    ).toBe("No offer");
    expect(listingHealth({}, 403).health).toBe("Needs attention");
    let s = reduceAmazonAudit(undefined, job());
    s = page(s, {
      items: [
        { ...item, attributes: { parentage_level: [{ value: "parent" }] } },
      ],
    });
    expect(projectAmazonAudit(s, inventory, {})[0].detail).toContain("parent");
  });
  it("keeps explicit SKU mappings through renames and surfaces duplicate mappings", () => {
    let s = reduceAmazonAudit(undefined, job());
    s = page(s, { items: [{ ...item, sku: "stable-remote" }] });
    for (const itemKey of ["blue", "green"])
      s = reduceAmazonAudit(s, {
        type: "amazonAudit/map",
        payload: {
          itemKey,
          sku: "stable-remote",
          sellerId: "seller",
          marketplaceId: market,
        },
      });
    expect(
      projectAmazonAudit(s, inventory, {}).every((r) =>
        r.detail.includes("Multiple inventory"),
      ),
    ).toBe(true);
    s = reduceAmazonAudit(s, {
      type: "amazonAudit/map",
      payload: {
        itemKey: "green",
        sku: "",
        sellerId: "seller",
        marketplaceId: market,
      },
    });
    const renamed = {
      idToItem: {
        ...inventory.idToItem,
        blue: {
          ...inventory.idToItem.blue,
          description: "Amifa new title",
          handle: "new-handle",
        },
      },
    };
    expect(
      projectAmazonAudit(s, renamed, {}).find((r) => r.key === "blue")?.sku,
    ).toBe("stable-remote");
  });
  it("retains observed SKUs after an incomplete or empty audit", () => {
    let s = reduceAmazonAudit(undefined, job());
    s = page(s, { items: [item] });
    s = page(s, { items: [] }, 200);
    expect(s.observations[auditScope("seller", market, "blue")].raw.sku).toBe(
      "blue",
    );
    s = reduceAmazonAudit(s, job("new-seller", 500));
    s = reduceAmazonAudit(s, job("seller", 20));
    expect(s.sellerId).toBe("new-seller");
  });
  it("projects inside the root reducer and replays deterministically", () => {
    let state = rootReducer(undefined, { type: "@@INIT" });
    state = { ...state, inventory: { ...state.inventory, ...inventory } };
    state = rootReducer(state, job());
    expect(state.amazonAudit.rows).toHaveLength(2);
    expect(
      JSON.stringify(rootReducer(state, { type: "unrelated" }).amazonAudit),
    ).toBe(JSON.stringify(state.amazonAudit));
  });
});
