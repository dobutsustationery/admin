import type { ShopifySyncEvent } from "$lib/shopify-sync-model";

export const SYNC_COLLECTION = "sync";
export const SYNC_SECRETS_COLLECTION = "sync_secrets";
export const SHOPIFY_REQUEST_COLLECTION = "request_shopify_sync";
export const SHOPIFY_CATALOG_SYNC_REQUEST_COLLECTION =
  "request_shopify_catalog_sync";
export const PHOTOS_TRANSFER_REQUEST_COLLECTION = "request_photos_transfer";
export const PHOTOS_TRANSFORM_REQUEST_COLLECTION = "request_photos_transform";
export const GOOGLE_AUTH_REQUEST_COLLECTION = "request_google_auth";
export const GOOGLE_AUTH_RESULTS_COLLECTION = "google_auth_results";
export const AMAZON_CATALOG_PROBE_REQUEST_COLLECTION =
  "request_amazon_catalog_probe";
export const AMAZON_LISTING_CREATE_REQUEST_COLLECTION =
  "request_amazon_listing_create";
export const AMAZON_PRODUCT_TYPE_DISCOVERY_REQUEST_COLLECTION =
  "request_amazon_product_type_discovery";
export const AMAZON_LISTING_RESTRICTIONS_REQUEST_COLLECTION =
  "request_amazon_listing_restrictions";
export const SHOPIFY_SYNC_NAMESPACE = "shopify";
export const PHOTOS_SYNC_NAMESPACE = "photos";
export const GOOGLE_SYNC_NAMESPACE = "google";
export const AMAZON_SYNC_NAMESPACE = "amazon";

export const SHOPIFY_SYNC_REQUEST_EVENT = `${SHOPIFY_SYNC_NAMESPACE}/sync_requested`;
export const PHOTOS_IMAGE_TRANSFER_REQUEST_EVENT = `${PHOTOS_SYNC_NAMESPACE}/image_transfer_requested`;
export const PHOTOS_IMAGE_TRANSFORM_REQUEST_EVENT = `${PHOTOS_SYNC_NAMESPACE}/image_transform_requested`;
export const GOOGLE_AUTH_REQUESTED_EVENT = `${GOOGLE_SYNC_NAMESPACE}/auth_requested`;
export const GOOGLE_AUTH_STARTED_EVENT = `${GOOGLE_SYNC_NAMESPACE}/auth_started`;
export const GOOGLE_AUTH_COMPLETED_EVENT = `${GOOGLE_SYNC_NAMESPACE}/auth_completed`;
export const GOOGLE_AUTH_FAILED_EVENT = `${GOOGLE_SYNC_NAMESPACE}/auth_failed`;
export const AMAZON_CATALOG_PROBE_REQUESTED_EVENT = `${AMAZON_SYNC_NAMESPACE}/catalog_probe_requested`;
export const AMAZON_CATALOG_PROBE_STARTED_EVENT = `${AMAZON_SYNC_NAMESPACE}/catalog_probe_started`;
export const AMAZON_CATALOG_PROBE_API_CALL_EVENT = `${AMAZON_SYNC_NAMESPACE}/catalog_probe_api_call`;
export const AMAZON_CATALOG_PROBE_COMPLETED_EVENT = `${AMAZON_SYNC_NAMESPACE}/catalog_probe_completed`;
export const AMAZON_CATALOG_PROBE_FAILED_EVENT = `${AMAZON_SYNC_NAMESPACE}/catalog_probe_failed`;
export const AMAZON_LISTING_CREATE_REQUESTED_EVENT = `${AMAZON_SYNC_NAMESPACE}/listing_create_requested`;
export const AMAZON_LISTING_CREATE_STARTED_EVENT = `${AMAZON_SYNC_NAMESPACE}/listing_create_started`;
export const AMAZON_LISTING_CREATE_API_CALL_EVENT = `${AMAZON_SYNC_NAMESPACE}/listing_create_api_call`;
export const AMAZON_LISTING_CREATE_COMPLETED_EVENT = `${AMAZON_SYNC_NAMESPACE}/listing_create_completed`;
export const AMAZON_LISTING_CREATE_FAILED_EVENT = `${AMAZON_SYNC_NAMESPACE}/listing_create_failed`;
export const AMAZON_PRODUCT_TYPE_DISCOVERY_REQUESTED_EVENT = `${AMAZON_SYNC_NAMESPACE}/product_type_discovery_requested`;
export const AMAZON_PRODUCT_TYPE_DISCOVERY_STARTED_EVENT = `${AMAZON_SYNC_NAMESPACE}/product_type_discovery_started`;
export const AMAZON_PRODUCT_TYPE_DISCOVERY_API_CALL_EVENT = `${AMAZON_SYNC_NAMESPACE}/product_type_discovery_api_call`;
export const AMAZON_PRODUCT_TYPE_DISCOVERY_COMPLETED_EVENT = `${AMAZON_SYNC_NAMESPACE}/product_type_discovery_completed`;
export const AMAZON_PRODUCT_TYPE_DISCOVERY_FAILED_EVENT = `${AMAZON_SYNC_NAMESPACE}/product_type_discovery_failed`;
export const AMAZON_LISTING_RESTRICTIONS_REQUESTED_EVENT = `${AMAZON_SYNC_NAMESPACE}/listing_restrictions_requested`;
export const AMAZON_LISTING_RESTRICTIONS_STARTED_EVENT = `${AMAZON_SYNC_NAMESPACE}/listing_restrictions_started`;
export const AMAZON_LISTING_RESTRICTIONS_API_CALL_EVENT = `${AMAZON_SYNC_NAMESPACE}/listing_restrictions_api_call`;
export const AMAZON_LISTING_RESTRICTIONS_COMPLETED_EVENT = `${AMAZON_SYNC_NAMESPACE}/listing_restrictions_completed`;
export const AMAZON_LISTING_RESTRICTIONS_FAILED_EVENT = `${AMAZON_SYNC_NAMESPACE}/listing_restrictions_failed`;

export function normalizeShopifySyncEventType(eventType: string): string {
  const value = String(eventType || "").trim();
  if (!value) return "";
  if (value.startsWith(`${SHOPIFY_SYNC_NAMESPACE}/`)) {
    const tail = value.slice(SHOPIFY_SYNC_NAMESPACE.length + 1);
    // Backward-compat for listing audit events that were written with a
    // parallel lifecycle naming scheme.
    if (tail === "listings_audit_requested") return "sync_requested";
    if (tail === "listings_audit_completed") return "sync_completed";
    if (tail === "listings_audit_failed") return "sync_failed";
    return tail;
  }
  if (value.startsWith(`${PHOTOS_SYNC_NAMESPACE}/`)) {
    const tail = value.slice(PHOTOS_SYNC_NAMESPACE.length + 1);
    if (
      tail === "image_transfer_requested" ||
      tail === "image_transform_requested"
    )
      return "sync_requested";
    if (tail === "image_transfer_started" || tail === "image_transform_started")
      return "sync_claimed";
    if (
      tail === "image_transfer_completed" ||
      tail === "image_transform_completed"
    )
      return "sync_completed";
    if (tail === "image_transfer_failed" || tail === "image_transform_failed")
      return "sync_failed";
    if (tail === "image_transfer_api_call") return "sync_api_call";
    return tail;
  }
  if (value.startsWith(`${AMAZON_SYNC_NAMESPACE}/`)) {
    const tail = value.slice(AMAZON_SYNC_NAMESPACE.length + 1);
    if (tail === "catalog_probe_requested") return "sync_requested";
    if (tail === "catalog_probe_started") return "sync_claimed";
    if (tail === "catalog_probe_api_call") return "sync_api_call";
    if (tail === "catalog_probe_completed") return "sync_completed";
    if (tail === "catalog_probe_failed") return "sync_failed";
    if (tail === "listing_create_requested") return "sync_requested";
    if (tail === "listing_create_started") return "sync_claimed";
    if (tail === "listing_create_api_call") return "sync_api_call";
    if (tail === "listing_create_completed") return "sync_completed";
    if (tail === "listing_create_failed") return "sync_failed";
    if (tail === "product_type_discovery_requested") return "sync_requested";
    if (tail === "product_type_discovery_started") return "sync_claimed";
    if (tail === "product_type_discovery_api_call") return "sync_api_call";
    if (tail === "product_type_discovery_completed") return "sync_completed";
    if (tail === "product_type_discovery_failed") return "sync_failed";
    if (tail === "listing_restrictions_requested") return "sync_requested";
    if (tail === "listing_restrictions_started") return "sync_claimed";
    if (tail === "listing_restrictions_api_call") return "sync_api_call";
    if (tail === "listing_restrictions_completed") return "sync_completed";
    if (tail === "listing_restrictions_failed") return "sync_failed";
    return tail;
  }
  return value;
}

export function toShopifySyncListenerEvent(params: {
  id: string;
  data: Record<string, any>;
}): ShopifySyncEvent {
  const { id, data } = params;
  return {
    id,
    ...data,
    eventType: String(data?.eventType || ""),
  } as ShopifySyncEvent;
}
