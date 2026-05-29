import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  etsyReconcileBroadcastDocumentId,
  shopifyReconcileBroadcastDocumentId,
} = require("../../functions/shared/reconcile-broadcast-id.cjs");

describe("reconcile broadcast document ids", () => {
  it("builds a deterministic Shopify id from order id and updated_at", () => {
    expect(
      shopifyReconcileBroadcastDocumentId({
        id: 13291677483390,
        updated_at: "2026-05-14T22:23:53+03:00",
      }),
    ).toBe("shopify_order_reconciled:13291677483390:2026-05-14T22:23:53+03:00");
  });

  it("falls back to Shopify admin_graphql_api_id and makes it Firestore-safe", () => {
    expect(
      shopifyReconcileBroadcastDocumentId({
        admin_graphql_api_id: "gid://shopify/Order/123",
        updated_at: "2026-05-14T22:23:53+03:00",
      }),
    ).toBe(
      "shopify_order_reconciled:gid:__shopify_Order_123:2026-05-14T22:23:53+03:00",
    );
  });

  it("builds a deterministic Etsy id from receipt id and updated timestamp", () => {
    expect(
      etsyReconcileBroadcastDocumentId({
        receipt_id: 4000428781,
        updated_timestamp: 1773245056,
        create_timestamp: 1773000000,
      }),
    ).toBe("etsy_order_reconciled:4000428781:1773245056");
  });

  it("falls back to Etsy create timestamp when updated timestamp is missing", () => {
    expect(
      etsyReconcileBroadcastDocumentId({
        receipt_id: 4000428781,
        create_timestamp: 1773000000,
      }),
    ).toBe("etsy_order_reconciled:4000428781:1773000000");
  });

  it("returns an empty id when required version fields are missing", () => {
    expect(shopifyReconcileBroadcastDocumentId({ id: 1 })).toBe("");
    expect(etsyReconcileBroadcastDocumentId({ receipt_id: 1 })).toBe("");
  });
});
