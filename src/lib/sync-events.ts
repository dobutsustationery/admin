import type { ShopifySyncEvent } from "$lib/shopify-sync-model";

export const SYNC_COLLECTION = "sync";
export const SYNC_SECRETS_COLLECTION = "sync_secrets";
export const SHOPIFY_SYNC_NAMESPACE = "shopify";
export const PHOTOS_SYNC_NAMESPACE = "photos";

export const SHOPIFY_SYNC_REQUEST_EVENT = `${SHOPIFY_SYNC_NAMESPACE}/sync_requested`;
export const PHOTOS_IMAGE_TRANSFER_REQUEST_EVENT = `${PHOTOS_SYNC_NAMESPACE}/image_transfer_requested`;

export function normalizeShopifySyncEventType(eventType: string): string {
  const value = String(eventType || "").trim();
  if (!value) return "";
  if (value.startsWith(`${SHOPIFY_SYNC_NAMESPACE}/`)) {
    return value.slice(SHOPIFY_SYNC_NAMESPACE.length + 1);
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
