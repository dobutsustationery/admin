import { describe, expect, it } from "vitest";
import { rootReducer } from "$lib/root-reducer";
import {
  apply_amazon_catalog_probe_chunk,
  apply_amazon_listing_write_result,
  apply_amazon_product_type_discovery_result,
  begin_amazon_catalog_probe,
  begin_amazon_listing_write,
  begin_amazon_product_type_discovery,
  complete_amazon_catalog_probe,
  complete_amazon_listing_write,
  complete_amazon_product_type_discovery,
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

  it("preserves raw listing write responses and indexes them by SKU", () => {
    const putResponse: AmazonRawApiResponseRecord = {
      id: "req-create:seller_listing_put:4542804131499",
      requestId: "req-create",
      kind: "seller_listing_put",
      key: "4542804131499",
      marketplaceId: "A1F83G8C2ARO7P",
      sellerId: "SELLER",
      endpoint: "https://sellingpartnerapi-eu.amazon.com",
      requestUrl: "https://example.test/listings/4542804131499",
      status: 200,
      statusText: "OK",
      ok: true,
      rateLimit: "5.0",
      fetchedAtMs: 3000,
      raw: {
        sku: "4542804131499",
        status: "ACCEPTED",
      },
    };
    const getResponse: AmazonRawApiResponseRecord = {
      ...putResponse,
      id: "req-create:seller_listing_get_by_sku:4542804131499",
      kind: "seller_listing_get_by_sku",
      raw: { sku: "4542804131499", summaries: [{ status: ["BUYABLE"] }] },
    };

    let state = rootReducer(undefined, { type: "@@INIT" });
    state = rootReducer(
      state,
      begin_amazon_listing_write({
        requestId: "req-create",
        mode: "listing_create",
        marketplaceId: "A1F83G8C2ARO7P",
        sellerId: "SELLER",
        sku: "4542804131499",
        requestedAtMs: 3000,
      }),
    );
    state = rootReducer(
      state,
      apply_amazon_listing_write_result({
        requestId: "req-create",
        mode: "listing_create",
        marketplaceId: "A1F83G8C2ARO7P",
        sellerId: "SELLER",
        sku: "4542804131499",
        responses: [putResponse, getResponse],
      }),
    );
    state = rootReducer(
      state,
      complete_amazon_listing_write({
        requestId: "req-create",
        mode: "listing_create",
        marketplaceId: "A1F83G8C2ARO7P",
        sellerId: "SELLER",
        sku: "4542804131499",
        completedAtMs: 4000,
      }),
    );

    expect(
      state.amazonCatalog.sellerListingPutRawResponseIdBySku["4542804131499"],
    ).toBe(putResponse.id);
    expect(state.amazonCatalog.rawResponsesById[putResponse.id].raw).toEqual({
      sku: "4542804131499",
      status: "ACCEPTED",
    });
    expect(
      state.amazonCatalog.sellerListingRawResponseIdBySku["4542804131499"],
    ).toBe(getResponse.id);
    expect(state.amazonCatalog.lastAppliedRequestId).toBe("req-create");
    expect(state.amazonCatalog.lastListingWriteCompletedAtMs).toBe(4000);
  });

  it("preserves raw product type discovery responses", () => {
    const searchResponse: AmazonRawApiResponseRecord = {
      id: "req-pt:product_type_search:Amifa stickers",
      requestId: "req-pt",
      kind: "product_type_search",
      key: "Amifa stickers",
      marketplaceId: "A1F83G8C2ARO7P",
      sellerId: "SELLER",
      endpoint: "https://sellingpartnerapi-eu.amazon.com",
      requestUrl: "https://example.test/productTypes",
      status: 200,
      statusText: "OK",
      ok: true,
      rateLimit: "5.0",
      fetchedAtMs: 5000,
      raw: {
        productTypes: [{ name: "STICKER_DECAL" }],
      },
    };
    const definitionResponse: AmazonRawApiResponseRecord = {
      ...searchResponse,
      id: "req-pt:product_type_definition:STICKER_DECAL",
      kind: "product_type_definition",
      key: "STICKER_DECAL",
      requestUrl: "https://example.test/productTypes/STICKER_DECAL",
      raw: {
        schema: {
          link: {
            resource: "https://example.test/schema/STICKER_DECAL",
          },
        },
      },
    };
    const schemaResponse: AmazonRawApiResponseRecord = {
      ...searchResponse,
      id: "req-pt:product_type_schema:STICKER_DECAL",
      kind: "product_type_schema",
      key: "STICKER_DECAL",
      requestUrl: "https://example.test/schema/STICKER_DECAL",
      raw: JSON.stringify({
        required: ["item_name", "brand"],
        properties: {
          brand: {},
          item_name: {},
          product_description: {},
        },
      }),
    };

    let state = rootReducer(undefined, { type: "@@INIT" });
    state = rootReducer(
      state,
      begin_amazon_product_type_discovery({
        requestId: "req-pt",
        mode: "product_type_discovery",
        marketplaceId: "A1F83G8C2ARO7P",
        sellerId: "SELLER",
        searchKey: "Amifa stickers",
        requestedAtMs: 5000,
      }),
    );
    state = rootReducer(
      state,
      apply_amazon_product_type_discovery_result({
        requestId: "req-pt",
        mode: "product_type_discovery",
        marketplaceId: "A1F83G8C2ARO7P",
        sellerId: "SELLER",
        searchKey: "Amifa stickers",
        responses: [searchResponse, definitionResponse, schemaResponse],
      }),
    );
    state = rootReducer(
      state,
      complete_amazon_product_type_discovery({
        requestId: "req-pt",
        mode: "product_type_discovery",
        marketplaceId: "A1F83G8C2ARO7P",
        sellerId: "SELLER",
        searchKey: "Amifa stickers",
        completedAtMs: 6000,
      }),
    );

    expect(
      state.amazonCatalog.productTypeSearchRawResponseIdByKey["Amifa stickers"],
    ).toBe(searchResponse.id);
    expect(
      state.amazonCatalog.productTypeDefinitionRawResponseIdByProductType[
        "STICKER_DECAL"
      ],
    ).toBe(definitionResponse.id);
    expect(
      state.amazonCatalog.productTypeSchemaRawResponseIdByProductType[
        "STICKER_DECAL"
      ],
    ).toBe(schemaResponse.id);
    expect(
      state.amazonCatalog.rawResponsesById[definitionResponse.id].raw,
    ).toEqual(definitionResponse.raw);
    expect(state.amazonCatalog.rawResponsesById[schemaResponse.id].raw).toEqual(
      schemaResponse.raw,
    );
    expect(
      state.amazonCatalog.productTypeRequiredAttributesByProductType[
        "STICKER_DECAL"
      ],
    ).toEqual(["brand", "item_name"]);
    expect(
      state.amazonCatalog.productTypePropertyNamesByProductType[
        "STICKER_DECAL"
      ],
    ).toEqual(["brand", "item_name", "product_description"]);
    expect(state.amazonCatalog.lastProductTypeDiscoveryCompletedAtMs).toBe(
      6000,
    );
  });
});
