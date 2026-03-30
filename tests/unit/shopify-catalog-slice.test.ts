import { describe, expect, it } from "vitest";
import {
  apply_shopify_catalog_sync_chunk,
  begin_shopify_catalog_sync,
  complete_shopify_catalog_sync,
  fail_shopify_catalog_sync,
  shopifyCatalog,
} from "$lib/shopify-catalog-slice";

describe("shopifyCatalog slice", () => {
  it("stages and replaces the catalog on full sync completion", () => {
    let state = shopifyCatalog(undefined, { type: "@@INIT" });

    state = shopifyCatalog(
      state,
      begin_shopify_catalog_sync({
        requestId: "full-1",
        mode: "full",
        requestedAtMs: 100,
      }),
    );

    state = shopifyCatalog(
      state,
      apply_shopify_catalog_sync_chunk({
        requestId: "full-1",
        mode: "full",
        listings: [
          {
            productId: "1",
            handle: "first-product",
            title: "First Product",
            bodyHtml: "",
            vendor: "SPNSS Ltd.",
            productType: "",
            productCategory: "Stationery",
            tags: ["new"],
            status: "active",
            option1Name: "Color",
            updatedAtIso: "2026-03-29T10:00:00.000Z",
            updatedAtMs: 1000,
            images: [],
            variants: [],
          },
        ],
      }),
    );

    expect(state.handleToListing["first-product"]).toBeUndefined();
    expect(state.stagingHandleToListing?.["first-product"]).toBeDefined();

    state = shopifyCatalog(
      state,
      complete_shopify_catalog_sync({
        requestId: "full-1",
        mode: "full",
        syncedAtMs: 200,
        maxUpdatedAtMs: 1000,
      }),
    );

    expect(state.handleToListing["first-product"]?.title).toBe("First Product");
    expect(state.stagingHandleToListing).toBeNull();
    expect(state.hasCompletedFullSync).toBe(true);
    expect(state.lastAppliedRequestId).toBe("full-1");
    expect(state.maxUpdatedAtMs).toBe(1000);
  });

  it("upserts incremental chunks directly into the live catalog", () => {
    let state = shopifyCatalog(undefined, { type: "@@INIT" });

    state = shopifyCatalog(
      state,
      apply_shopify_catalog_sync_chunk({
        requestId: "inc-1",
        mode: "incremental",
        listings: [
          {
            productId: "2",
            handle: "updated-product",
            title: "Updated Product",
            bodyHtml: "",
            vendor: "SPNSS Ltd.",
            productType: "",
            productCategory: "",
            tags: [],
            status: "draft",
            option1Name: "",
            updatedAtIso: "2026-03-29T11:00:00.000Z",
            updatedAtMs: 2000,
            images: [],
            variants: [],
          },
        ],
      }),
    );

    state = shopifyCatalog(
      state,
      complete_shopify_catalog_sync({
        requestId: "inc-1",
        mode: "incremental",
        syncedAtMs: 300,
        maxUpdatedAtMs: 2000,
      }),
    );

    expect(state.handleToListing["updated-product"]?.status).toBe("draft");
    expect(state.lastAppliedRequestId).toBe("inc-1");
    expect(state.maxUpdatedAtMs).toBe(2000);
  });

  it("clears staged full sync state and stores the error on failure", () => {
    let state = shopifyCatalog(undefined, { type: "@@INIT" });

    state = shopifyCatalog(
      state,
      begin_shopify_catalog_sync({
        requestId: "full-2",
        mode: "full",
        requestedAtMs: 500,
      }),
    );

    state = shopifyCatalog(
      state,
      fail_shopify_catalog_sync({
        requestId: "full-2",
        mode: "full",
        failedAtMs: 550,
        errorMessage: "boom",
      }),
    );

    expect(state.stagingHandleToListing).toBeNull();
    expect(state.stagingRequestId).toBe("");
    expect(state.lastFailedRequestId).toBe("full-2");
    expect(state.lastSyncError).toBe("boom");
  });
});
