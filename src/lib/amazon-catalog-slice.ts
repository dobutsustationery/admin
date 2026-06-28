import { createAction, createReducer } from "@reduxjs/toolkit";

export type AmazonProbeMode = "jan_probe" | "sku_probe";

export type AmazonRawResponseKind =
  | "catalog_search_by_jan"
  | "seller_listings_search_by_jan"
  | "seller_listing_get_by_sku";

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
  activeRequestId: string;
  lastAppliedRequestId: string;
  lastFailedRequestId: string;
  catalogRawResponseIdByJan: Record<string, string>;
  sellerListingsRawResponseIdByJan: Record<string, string>;
  sellerListingRawResponseIdBySku: Record<string, string>;
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
  activeRequestId: "",
  lastAppliedRequestId: "",
  lastFailedRequestId: "",
  catalogRawResponseIdByJan: {},
  sellerListingsRawResponseIdByJan: {},
  sellerListingRawResponseIdBySku: {},
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

export const reset_amazon_catalog_state = createAction(
  "amazonCatalog/reset_state",
);

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
    .addCase(reset_amazon_catalog_state, () => initialState);
});
