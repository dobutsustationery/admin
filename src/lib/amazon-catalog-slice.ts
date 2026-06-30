import { createAction, createReducer } from "@reduxjs/toolkit";

export type AmazonProbeMode = "jan_probe" | "sku_probe";
export type AmazonListingWriteMode = "listing_create";
export type AmazonProductTypeDiscoveryMode = "product_type_discovery";
export type AmazonListingRestrictionsMode = "listing_restrictions";

export type AmazonRawResponseKind =
  | "catalog_search_by_jan"
  | "seller_listings_search_by_jan"
  | "seller_listing_get_by_sku"
  | "seller_listing_put"
  | "listing_restrictions"
  | "product_type_search"
  | "product_type_definition"
  | "product_type_schema";

export interface AmazonRawApiResponseRecord {
  id: string;
  requestId: string;
  kind: AmazonRawResponseKind;
  key: string;
  marketplaceId: string;
  sellerId: string;
  endpoint: string;
  requestUrl: string;
  status: number;
  statusText: string;
  ok: boolean;
  rateLimit: string;
  fetchedAtMs: number;
  raw: unknown;
}

export interface AmazonCatalogState {
  marketplaceId: string;
  sellerId: string;
  lastProbeMode: "" | AmazonProbeMode;
  lastProbeRequestedAtMs: number;
  lastProbeCompletedAtMs: number;
  lastProbeFailedAtMs: number;
  lastProbeError: string;
  lastListingWriteMode: "" | AmazonListingWriteMode;
  lastListingWriteRequestedAtMs: number;
  lastListingWriteCompletedAtMs: number;
  lastListingWriteFailedAtMs: number;
  lastListingWriteError: string;
  lastProductTypeDiscoveryMode: "" | AmazonProductTypeDiscoveryMode;
  lastProductTypeDiscoveryRequestedAtMs: number;
  lastProductTypeDiscoveryCompletedAtMs: number;
  lastProductTypeDiscoveryFailedAtMs: number;
  lastProductTypeDiscoveryError: string;
  lastListingRestrictionsMode: "" | AmazonListingRestrictionsMode;
  lastListingRestrictionsRequestedAtMs: number;
  lastListingRestrictionsCompletedAtMs: number;
  lastListingRestrictionsFailedAtMs: number;
  lastListingRestrictionsError: string;
  activeRequestId: string;
  lastAppliedRequestId: string;
  lastFailedRequestId: string;
  catalogRawResponseIdByJan: Record<string, string>;
  sellerListingsRawResponseIdByJan: Record<string, string>;
  sellerListingRawResponseIdBySku: Record<string, string>;
  sellerListingPutRawResponseIdBySku: Record<string, string>;
  listingRestrictionsRawResponseIdByKey: Record<string, string>;
  productTypeSearchRawResponseIdByKey: Record<string, string>;
  productTypeDefinitionRawResponseIdByProductType: Record<string, string>;
  productTypeSchemaRawResponseIdByProductType: Record<string, string>;
  productTypeRequiredAttributesByProductType: Record<string, string[]>;
  productTypePropertyNamesByProductType: Record<string, string[]>;
  rawResponsesById: Record<string, AmazonRawApiResponseRecord>;
  rawResponseIds: string[];
}

export const initialState: AmazonCatalogState = {
  marketplaceId: "",
  sellerId: "",
  lastProbeMode: "",
  lastProbeRequestedAtMs: 0,
  lastProbeCompletedAtMs: 0,
  lastProbeFailedAtMs: 0,
  lastProbeError: "",
  lastListingWriteMode: "",
  lastListingWriteRequestedAtMs: 0,
  lastListingWriteCompletedAtMs: 0,
  lastListingWriteFailedAtMs: 0,
  lastListingWriteError: "",
  lastProductTypeDiscoveryMode: "",
  lastProductTypeDiscoveryRequestedAtMs: 0,
  lastProductTypeDiscoveryCompletedAtMs: 0,
  lastProductTypeDiscoveryFailedAtMs: 0,
  lastProductTypeDiscoveryError: "",
  lastListingRestrictionsMode: "",
  lastListingRestrictionsRequestedAtMs: 0,
  lastListingRestrictionsCompletedAtMs: 0,
  lastListingRestrictionsFailedAtMs: 0,
  lastListingRestrictionsError: "",
  activeRequestId: "",
  lastAppliedRequestId: "",
  lastFailedRequestId: "",
  catalogRawResponseIdByJan: {},
  sellerListingsRawResponseIdByJan: {},
  sellerListingRawResponseIdBySku: {},
  sellerListingPutRawResponseIdBySku: {},
  listingRestrictionsRawResponseIdByKey: {},
  productTypeSearchRawResponseIdByKey: {},
  productTypeDefinitionRawResponseIdByProductType: {},
  productTypeSchemaRawResponseIdByProductType: {},
  productTypeRequiredAttributesByProductType: {},
  productTypePropertyNamesByProductType: {},
  rawResponsesById: {},
  rawResponseIds: [],
};

export const begin_amazon_catalog_probe = createAction<{
  requestId: string;
  mode: AmazonProbeMode;
  marketplaceId: string;
  sellerId?: string;
  requestedAtMs: number;
}>("amazonCatalog/begin_probe");

export const apply_amazon_catalog_probe_chunk = createAction<{
  requestId: string;
  mode: AmazonProbeMode;
  marketplaceId: string;
  sellerId?: string;
  responses: AmazonRawApiResponseRecord[];
}>("amazonCatalog/apply_probe_chunk");

export const complete_amazon_catalog_probe = createAction<{
  requestId: string;
  mode: AmazonProbeMode;
  marketplaceId: string;
  sellerId?: string;
  completedAtMs: number;
}>("amazonCatalog/complete_probe");

export const fail_amazon_catalog_probe = createAction<{
  requestId: string;
  mode: AmazonProbeMode;
  marketplaceId: string;
  sellerId?: string;
  failedAtMs: number;
  errorMessage: string;
}>("amazonCatalog/fail_probe");

export const begin_amazon_listing_write = createAction<{
  requestId: string;
  mode: AmazonListingWriteMode;
  marketplaceId: string;
  sellerId?: string;
  sku: string;
  requestedAtMs: number;
}>("amazonCatalog/begin_listing_write");

export const apply_amazon_listing_write_result = createAction<{
  requestId: string;
  mode: AmazonListingWriteMode;
  marketplaceId: string;
  sellerId?: string;
  sku: string;
  responses: AmazonRawApiResponseRecord[];
}>("amazonCatalog/apply_listing_write_result");

export const complete_amazon_listing_write = createAction<{
  requestId: string;
  mode: AmazonListingWriteMode;
  marketplaceId: string;
  sellerId?: string;
  sku: string;
  completedAtMs: number;
}>("amazonCatalog/complete_listing_write");

export const fail_amazon_listing_write = createAction<{
  requestId: string;
  mode: AmazonListingWriteMode;
  marketplaceId: string;
  sellerId?: string;
  sku: string;
  failedAtMs: number;
  errorMessage: string;
}>("amazonCatalog/fail_listing_write");

export const begin_amazon_product_type_discovery = createAction<{
  requestId: string;
  mode: AmazonProductTypeDiscoveryMode;
  marketplaceId: string;
  sellerId?: string;
  searchKey: string;
  requestedAtMs: number;
}>("amazonCatalog/begin_product_type_discovery");

export const apply_amazon_product_type_discovery_result = createAction<{
  requestId: string;
  mode: AmazonProductTypeDiscoveryMode;
  marketplaceId: string;
  sellerId?: string;
  searchKey: string;
  responses: AmazonRawApiResponseRecord[];
}>("amazonCatalog/apply_product_type_discovery_result");

export const complete_amazon_product_type_discovery = createAction<{
  requestId: string;
  mode: AmazonProductTypeDiscoveryMode;
  marketplaceId: string;
  sellerId?: string;
  searchKey: string;
  completedAtMs: number;
}>("amazonCatalog/complete_product_type_discovery");

export const fail_amazon_product_type_discovery = createAction<{
  requestId: string;
  mode: AmazonProductTypeDiscoveryMode;
  marketplaceId: string;
  sellerId?: string;
  searchKey: string;
  failedAtMs: number;
  errorMessage: string;
}>("amazonCatalog/fail_product_type_discovery");

export const begin_amazon_listing_restrictions = createAction<{
  requestId: string;
  mode: AmazonListingRestrictionsMode;
  marketplaceId: string;
  sellerId?: string;
  restrictionKey: string;
  requestedAtMs: number;
}>("amazonCatalog/begin_listing_restrictions");

export const apply_amazon_listing_restrictions_result = createAction<{
  requestId: string;
  mode: AmazonListingRestrictionsMode;
  marketplaceId: string;
  sellerId?: string;
  restrictionKey: string;
  responses: AmazonRawApiResponseRecord[];
}>("amazonCatalog/apply_listing_restrictions_result");

export const complete_amazon_listing_restrictions = createAction<{
  requestId: string;
  mode: AmazonListingRestrictionsMode;
  marketplaceId: string;
  sellerId?: string;
  restrictionKey: string;
  completedAtMs: number;
}>("amazonCatalog/complete_listing_restrictions");

export const fail_amazon_listing_restrictions = createAction<{
  requestId: string;
  mode: AmazonListingRestrictionsMode;
  marketplaceId: string;
  sellerId?: string;
  restrictionKey: string;
  failedAtMs: number;
  errorMessage: string;
}>("amazonCatalog/fail_listing_restrictions");

export const reset_amazon_catalog_state = createAction(
  "amazonCatalog/reset_state",
);

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => String(entry || "").trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
    : [];
}

function deriveSchemaFields(raw: unknown): {
  requiredAttributes: string[];
  propertyNames: string[];
} {
  let schema = raw as any;
  if (typeof raw === "string") {
    try {
      schema = raw ? JSON.parse(raw) : {};
    } catch {
      schema = {};
    }
  }
  return {
    requiredAttributes: stringArray(schema?.required),
    propertyNames: Object.keys(schema?.properties || {}).sort((a, b) =>
      a.localeCompare(b),
    ),
  };
}

function observeResponse(
  state: AmazonCatalogState,
  response: AmazonRawApiResponseRecord,
) {
  if (!response?.id) return;
  state.rawResponsesById[response.id] = response;
  if (!state.rawResponseIds.includes(response.id)) {
    state.rawResponseIds.push(response.id);
  }

  if (response.marketplaceId) state.marketplaceId = response.marketplaceId;
  if (response.sellerId) state.sellerId = response.sellerId;

  if (response.kind === "catalog_search_by_jan") {
    state.catalogRawResponseIdByJan[response.key] = response.id;
  } else if (response.kind === "seller_listings_search_by_jan") {
    state.sellerListingsRawResponseIdByJan[response.key] = response.id;
  } else if (response.kind === "seller_listing_get_by_sku") {
    state.sellerListingRawResponseIdBySku[response.key] = response.id;
  } else if (response.kind === "seller_listing_put") {
    state.sellerListingPutRawResponseIdBySku[response.key] = response.id;
  } else if (response.kind === "listing_restrictions") {
    state.listingRestrictionsRawResponseIdByKey[response.key] = response.id;
  } else if (response.kind === "product_type_search") {
    state.productTypeSearchRawResponseIdByKey[response.key] = response.id;
  } else if (response.kind === "product_type_definition") {
    state.productTypeDefinitionRawResponseIdByProductType[response.key] =
      response.id;
    const raw = response.raw as any;
    const inlineSchema = raw?.schema && !raw.schema.link ? raw.schema : null;
    if (inlineSchema) {
      const fields = deriveSchemaFields(inlineSchema);
      state.productTypeRequiredAttributesByProductType[response.key] =
        fields.requiredAttributes;
      state.productTypePropertyNamesByProductType[response.key] =
        fields.propertyNames;
    }
  } else if (response.kind === "product_type_schema") {
    state.productTypeSchemaRawResponseIdByProductType[response.key] =
      response.id;
    const fields = deriveSchemaFields(response.raw);
    state.productTypeRequiredAttributesByProductType[response.key] =
      fields.requiredAttributes;
    state.productTypePropertyNamesByProductType[response.key] =
      fields.propertyNames;
  }
}

export const amazonCatalog = createReducer(initialState, (builder) => {
  builder
    .addCase(begin_amazon_catalog_probe, (state, action) => {
      const { requestId, mode, marketplaceId, sellerId, requestedAtMs } =
        action.payload;
      state.activeRequestId = requestId;
      state.lastProbeMode = mode;
      state.marketplaceId = marketplaceId || state.marketplaceId;
      state.sellerId = sellerId || state.sellerId;
      state.lastProbeError = "";
      state.lastProbeRequestedAtMs = Math.max(
        Number(state.lastProbeRequestedAtMs || 0),
        Number(requestedAtMs || 0),
      );
    })
    .addCase(apply_amazon_catalog_probe_chunk, (state, action) => {
      const { marketplaceId, sellerId, responses } = action.payload;
      state.marketplaceId = marketplaceId || state.marketplaceId;
      state.sellerId = sellerId || state.sellerId;
      const safeResponses = Array.isArray(responses) ? responses : [];
      safeResponses.forEach((response) => observeResponse(state, response));
    })
    .addCase(complete_amazon_catalog_probe, (state, action) => {
      const { requestId, mode, marketplaceId, sellerId, completedAtMs } =
        action.payload;
      state.activeRequestId = "";
      state.lastAppliedRequestId = requestId;
      state.lastProbeMode = mode;
      state.marketplaceId = marketplaceId || state.marketplaceId;
      state.sellerId = sellerId || state.sellerId;
      state.lastProbeError = "";
      state.lastProbeCompletedAtMs = Math.max(
        Number(state.lastProbeCompletedAtMs || 0),
        Number(completedAtMs || 0),
      );
    })
    .addCase(fail_amazon_catalog_probe, (state, action) => {
      const {
        requestId,
        mode,
        marketplaceId,
        sellerId,
        failedAtMs,
        errorMessage,
      } = action.payload;
      state.activeRequestId = "";
      state.lastFailedRequestId = requestId;
      state.lastProbeMode = mode;
      state.marketplaceId = marketplaceId || state.marketplaceId;
      state.sellerId = sellerId || state.sellerId;
      state.lastProbeError = String(errorMessage || "").trim();
      state.lastProbeFailedAtMs = Math.max(
        Number(state.lastProbeFailedAtMs || 0),
        Number(failedAtMs || 0),
      );
    })
    .addCase(begin_amazon_listing_write, (state, action) => {
      const { requestId, mode, marketplaceId, sellerId, requestedAtMs } =
        action.payload;
      state.activeRequestId = requestId;
      state.lastListingWriteMode = mode;
      state.marketplaceId = marketplaceId || state.marketplaceId;
      state.sellerId = sellerId || state.sellerId;
      state.lastListingWriteError = "";
      state.lastListingWriteRequestedAtMs = Math.max(
        Number(state.lastListingWriteRequestedAtMs || 0),
        Number(requestedAtMs || 0),
      );
    })
    .addCase(apply_amazon_listing_write_result, (state, action) => {
      const { marketplaceId, sellerId, responses } = action.payload;
      state.marketplaceId = marketplaceId || state.marketplaceId;
      state.sellerId = sellerId || state.sellerId;
      const safeResponses = Array.isArray(responses) ? responses : [];
      safeResponses.forEach((response) => observeResponse(state, response));
    })
    .addCase(complete_amazon_listing_write, (state, action) => {
      const { requestId, mode, marketplaceId, sellerId, completedAtMs } =
        action.payload;
      state.activeRequestId = "";
      state.lastAppliedRequestId = requestId;
      state.lastListingWriteMode = mode;
      state.marketplaceId = marketplaceId || state.marketplaceId;
      state.sellerId = sellerId || state.sellerId;
      state.lastListingWriteError = "";
      state.lastListingWriteCompletedAtMs = Math.max(
        Number(state.lastListingWriteCompletedAtMs || 0),
        Number(completedAtMs || 0),
      );
    })
    .addCase(fail_amazon_listing_write, (state, action) => {
      const {
        requestId,
        mode,
        marketplaceId,
        sellerId,
        failedAtMs,
        errorMessage,
      } = action.payload;
      state.activeRequestId = "";
      state.lastFailedRequestId = requestId;
      state.lastListingWriteMode = mode;
      state.marketplaceId = marketplaceId || state.marketplaceId;
      state.sellerId = sellerId || state.sellerId;
      state.lastListingWriteError = String(errorMessage || "").trim();
      state.lastListingWriteFailedAtMs = Math.max(
        Number(state.lastListingWriteFailedAtMs || 0),
        Number(failedAtMs || 0),
      );
    })
    .addCase(begin_amazon_product_type_discovery, (state, action) => {
      const { requestId, mode, marketplaceId, sellerId, requestedAtMs } =
        action.payload;
      state.activeRequestId = requestId;
      state.lastProductTypeDiscoveryMode = mode;
      state.marketplaceId = marketplaceId || state.marketplaceId;
      state.sellerId = sellerId || state.sellerId;
      state.lastProductTypeDiscoveryError = "";
      state.lastProductTypeDiscoveryRequestedAtMs = Math.max(
        Number(state.lastProductTypeDiscoveryRequestedAtMs || 0),
        Number(requestedAtMs || 0),
      );
    })
    .addCase(apply_amazon_product_type_discovery_result, (state, action) => {
      const { marketplaceId, sellerId, responses } = action.payload;
      state.marketplaceId = marketplaceId || state.marketplaceId;
      state.sellerId = sellerId || state.sellerId;
      const safeResponses = Array.isArray(responses) ? responses : [];
      safeResponses.forEach((response) => observeResponse(state, response));
    })
    .addCase(complete_amazon_product_type_discovery, (state, action) => {
      const { requestId, mode, marketplaceId, sellerId, completedAtMs } =
        action.payload;
      state.activeRequestId = "";
      state.lastAppliedRequestId = requestId;
      state.lastProductTypeDiscoveryMode = mode;
      state.marketplaceId = marketplaceId || state.marketplaceId;
      state.sellerId = sellerId || state.sellerId;
      state.lastProductTypeDiscoveryError = "";
      state.lastProductTypeDiscoveryCompletedAtMs = Math.max(
        Number(state.lastProductTypeDiscoveryCompletedAtMs || 0),
        Number(completedAtMs || 0),
      );
    })
    .addCase(fail_amazon_product_type_discovery, (state, action) => {
      const {
        requestId,
        mode,
        marketplaceId,
        sellerId,
        failedAtMs,
        errorMessage,
      } = action.payload;
      state.activeRequestId = "";
      state.lastFailedRequestId = requestId;
      state.lastProductTypeDiscoveryMode = mode;
      state.marketplaceId = marketplaceId || state.marketplaceId;
      state.sellerId = sellerId || state.sellerId;
      state.lastProductTypeDiscoveryError = String(errorMessage || "").trim();
      state.lastProductTypeDiscoveryFailedAtMs = Math.max(
        Number(state.lastProductTypeDiscoveryFailedAtMs || 0),
        Number(failedAtMs || 0),
      );
    })
    .addCase(begin_amazon_listing_restrictions, (state, action) => {
      const { requestId, mode, marketplaceId, sellerId, requestedAtMs } =
        action.payload;
      state.activeRequestId = requestId;
      state.lastListingRestrictionsMode = mode;
      state.marketplaceId = marketplaceId || state.marketplaceId;
      state.sellerId = sellerId || state.sellerId;
      state.lastListingRestrictionsError = "";
      state.lastListingRestrictionsRequestedAtMs = Math.max(
        Number(state.lastListingRestrictionsRequestedAtMs || 0),
        Number(requestedAtMs || 0),
      );
    })
    .addCase(apply_amazon_listing_restrictions_result, (state, action) => {
      const { marketplaceId, sellerId, responses } = action.payload;
      state.marketplaceId = marketplaceId || state.marketplaceId;
      state.sellerId = sellerId || state.sellerId;
      const safeResponses = Array.isArray(responses) ? responses : [];
      safeResponses.forEach((response) => observeResponse(state, response));
    })
    .addCase(complete_amazon_listing_restrictions, (state, action) => {
      const { requestId, mode, marketplaceId, sellerId, completedAtMs } =
        action.payload;
      state.activeRequestId = "";
      state.lastAppliedRequestId = requestId;
      state.lastListingRestrictionsMode = mode;
      state.marketplaceId = marketplaceId || state.marketplaceId;
      state.sellerId = sellerId || state.sellerId;
      state.lastListingRestrictionsError = "";
      state.lastListingRestrictionsCompletedAtMs = Math.max(
        Number(state.lastListingRestrictionsCompletedAtMs || 0),
        Number(completedAtMs || 0),
      );
    })
    .addCase(fail_amazon_listing_restrictions, (state, action) => {
      const {
        requestId,
        mode,
        marketplaceId,
        sellerId,
        failedAtMs,
        errorMessage,
      } = action.payload;
      state.activeRequestId = "";
      state.lastFailedRequestId = requestId;
      state.lastListingRestrictionsMode = mode;
      state.marketplaceId = marketplaceId || state.marketplaceId;
      state.sellerId = sellerId || state.sellerId;
      state.lastListingRestrictionsError = String(errorMessage || "").trim();
      state.lastListingRestrictionsFailedAtMs = Math.max(
        Number(state.lastListingRestrictionsFailedAtMs || 0),
        Number(failedAtMs || 0),
      );
    })
    .addCase(reset_amazon_catalog_state, () => initialState);
});
