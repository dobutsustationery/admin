import { describe, expect, it } from "vitest";
import { rootReducer } from "$lib/root-reducer";
import {
  apply_amazon_catalog_probe_chunk,
  begin_amazon_catalog_probe,
  complete_amazon_catalog_probe,
  type AmazonRawApiResponseRecord,
} from "$lib/amazon-catalog-slice";

describe("amazon catalog replay state", () => {
  it("preserves raw SP-API responses and indexes latest observations", () => {
    const catalogResponse: AmazonRawApiResponseRecord = {
      id: "req-1:catalog_search_by_jan:4542804131499",
      requestId: "req-1",
      kind: "catalog_search_by_jan",
      key: "4542804131499",
      marketplaceId: "A1F83G8C2ARO7P",
      sellerId: "SELLER",
      endpoint: "https://sellingpartnerapi-eu.amazon.com",
      requestUrl: "https://example.test/catalog",
      status: 200,
      statusText: "OK",
      ok: true,
      rateLimit: "2.0",
      fetchedAtMs: 1000,
      raw: {
        numberOfResults: 1,
        items: [{ asin: "B0G4N6PGF6" }],
      },
    };
    const sellerResponse: AmazonRawApiResponseRecord = {
      ...catalogResponse,
      id: "req-1:seller_listings_search_by_jan:4542804131499",
      kind: "seller_listings_search_by_jan",
      requestUrl: "https://example.test/listings",
      rateLimit: "5.0",
      raw: {
        numberOfResults: 1,
        items: [{ sku: "4542804131499" }],
      },
    };

    let state = rootReducer(undefined, { type: "@@INIT" });
    state = rootReducer(
      state,
      begin_amazon_catalog_probe({
        requestId: "req-1",
        mode: "jan_probe",
        marketplaceId: "A1F83G8C2ARO7P",
        sellerId: "SELLER",
        requestedAtMs: 1000,
      }),
    );
    state = rootReducer(
      state,
      apply_amazon_catalog_probe_chunk({
        requestId: "req-1",
        mode: "jan_probe",
        marketplaceId: "A1F83G8C2ARO7P",
        sellerId: "SELLER",
        responses: [catalogResponse, sellerResponse],
      }),
    );
    state = rootReducer(
      state,
      complete_amazon_catalog_probe({
        requestId: "req-1",
        mode: "jan_probe",
        marketplaceId: "A1F83G8C2ARO7P",
        sellerId: "SELLER",
        completedAtMs: 2000,
      }),
    );

    expect(
      state.amazonCatalog.rawResponsesById[catalogResponse.id].raw,
    ).toEqual(catalogResponse.raw);
    expect(state.amazonCatalog.catalogRawResponseIdByJan["4542804131499"]).toBe(
      catalogResponse.id,
    );
    expect(
      state.amazonCatalog.sellerListingsRawResponseIdByJan["4542804131499"],
    ).toBe(sellerResponse.id);
    expect(state.amazonCatalog.lastAppliedRequestId).toBe("req-1");
    expect(state.amazonCatalog.lastProbeCompletedAtMs).toBe(2000);
  });
});
