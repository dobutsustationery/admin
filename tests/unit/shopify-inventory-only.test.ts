import { afterEach, describe, expect, it, vi } from "vitest";
const core = require("../../functions/shared/shopify-sync-core.cjs");
const worker = require("../../functions/shared/shopify-sync-worker.cjs");

describe("Shopify inventory-only sync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  function setup(
    product: any = {
      id: 10,
      handle: "existing",
      variants: [{ id: 30, sku: "123", inventory_item_id: 22 }],
    },
  ) {
    const events: any[] = [];
    const db = {
      collection: (name: string) => ({
        add: async (event: any) => {
          events.push({ name, ...event });
        },
        doc: () => ({
          create: async (event: any) => {
            events.push({ name, ...event });
          },
        }),
      }),
    };
    vi.spyOn(core, "resolveLocationId").mockResolvedValue(44);
    const find = vi
      .spyOn(core, "findProductByHandle")
      .mockResolvedValue(product);
    const upsert = vi
      .spyOn(core, "upsertProductFromRequest")
      .mockRejectedValue(Error("Must never update product"));
    const publish = vi
      .spyOn(core, "ensureProductPublishedToOnlineStore")
      .mockRejectedValue(Error("Must never publish product"));
    const stock = vi
      .spyOn(core, "setInventoryLevel")
      .mockResolvedValue({ available: 3 });
    const config = {
      storeUrl: "test.myshopify.com",
      accessToken: "test",
      apiVersion: "2026-01",
    };
    const run = () =>
      worker.executeClaimedRequest({
        db,
        requestEventId: "r1",
        requestData: {
          requestId: "r1",
          handle: "existing",
          syncMode: "inventory",
          variants: [{ sku: "123", available: 3 }],
        },
        processor: "test",
        shopifyConfig: config,
        creator: "test",
        eventTypeNamespace: "shopify",
      });
    return { run, events, find, upsert, publish, stock, config };
  }
  it("sets only inventory levels and never updates or publishes the product", async () => {
    const s = setup();
    await s.run();
    expect(s.stock).toHaveBeenCalledWith(s.config, 44, 22, 3);
    expect(s.upsert).not.toHaveBeenCalled();
    expect(s.publish).not.toHaveBeenCalled();
    expect(
      s.events.find((e) => e.eventType === "shopify/sync_completed").payload
        .syncMode,
    ).toBe("inventory");
  });
  it("fails when the original product is absent, without creating a replacement", async () => {
    const s = setup(null);
    await expect(s.run()).rejects.toThrow("Existing Shopify product not found");
    expect(s.stock).not.toHaveBeenCalled();
    expect(s.upsert).not.toHaveBeenCalled();
    expect(s.publish).not.toHaveBeenCalled();
  });
  it("reports unmatched variants without setting inventory on another SKU", async () => {
    const s = setup({
      id: 10,
      handle: "existing",
      variants: [{ sku: "999", inventory_item_id: 99 }],
    });
    await s.run();
    expect(s.stock).not.toHaveBeenCalled();
    expect(
      s.events.some((e) => e.eventType === "shopify/sync_partial_failed"),
    ).toBe(true);
  });
});
