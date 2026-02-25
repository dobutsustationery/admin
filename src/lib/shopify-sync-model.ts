import { normalizeShopifySyncEventType } from "$lib/sync-events";

export type ShopifySyncEvent = {
  id: string;
  eventType: string;
  requestId: string;
  requestEventId?: string;
  handle?: string;
  processor?: string;
  payload?: any;
  requestedBy?: string;
  requestedAt?: number;
  source?: string;
  timestamp?: any;
  createdAtMs?: number;
  listing?: any;
  variants?: any[];
};

export type ShopifySyncRequestStatus =
  | "queued"
  | "processing"
  | "success"
  | "partial_failed"
  | "failed";

export type ShopifySyncApiCall = {
  eventId: string;
  requestType: string;
  endpoint: string;
  success: boolean;
  response: any;
  context: any;
  loggedAt: number;
  processor: string;
};

export type ShopifySyncRequestView = {
  requestId: string;
  requestEventId: string;
  handle: string;
  requestedBy: string;
  source: string;
  requestedAt: number;
  createdAtMs: number;
  processor: string;
  status: ShopifySyncRequestStatus;
  result?: any;
  apiCalls: ShopifySyncApiCall[];
  timeline: ShopifySyncEvent[];
};

export type FoldedShopifySync = {
  requestsById: Record<string, ShopifySyncRequestView>;
  requestIds: string[];
  handleToLatestRequestId: Record<string, string>;
};

export type GenericSyncRequestStatus =
  | "queued"
  | "processing"
  | "success"
  | "partial_failed"
  | "failed";

export function toMs(value: any): number {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (typeof value?.seconds === "number") {
    const nanos =
      typeof value?.nanoseconds === "number" ? value.nanoseconds : 0;
    return value.seconds * 1000 + nanos / 1_000_000;
  }
  if (value?.toDate) return value.toDate().getTime();
  return 0;
}

export function sortSyncEventsAsc(
  events: ShopifySyncEvent[],
): ShopifySyncEvent[] {
  return [...events].sort((a, b) => {
    const tA = toMs(a.timestamp) || Number(a.createdAtMs || 0);
    const tB = toMs(b.timestamp) || Number(b.createdAtMs || 0);
    if (tA !== tB) return tA - tB;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
}

export function getSyncEventBaseType(eventType: string): string {
  const value = String(eventType || "");
  const slash = value.lastIndexOf("/");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

export function inferSyncRequestDomainFromEvents(
  events: Pick<ShopifySyncEvent, "eventType">[],
): "shopify" | "photos" | "unknown" {
  const first = String(events?.[0]?.eventType || "");
  if (!first) return "unknown";
  if (first.startsWith("photos/")) return "photos";
  if (first.startsWith("shopify/") || first.includes("sync_")) return "shopify";
  return "unknown";
}

export function classifySyncRequestStatusFromEventTypes(
  eventTypes: string[],
): GenericSyncRequestStatus | null {
  if (eventTypes.length === 0) return null;

  const hasFailed = eventTypes.some(
    (t) =>
      t.includes("sync_failed") ||
      t.includes("sync_partial_failed") ||
      t.includes("image_transfer_failed") ||
      t.includes("image_transform_failed") ||
      t.includes("/rejected"),
  );
  if (hasFailed) return "failed";

  const hasCompleted = eventTypes.some(
    (t) =>
      t.includes("sync_completed") ||
      t.includes("image_transfer_completed") ||
      t.includes("image_transform_completed"),
  );
  if (hasCompleted) return "success";

  const hasStarted = eventTypes.some(
    (t) =>
      t.includes("sync_claimed") ||
      t.includes("image_transfer_started") ||
      t.includes("image_transform_started") ||
      t.includes("_api_call") || // Any API activity means it's processing
      t.includes("secret_provided"),
  );
  if (hasStarted) return "processing";

  const hasRequested = eventTypes.some(
    (t) =>
      t.includes("sync_requested") ||
      t.includes("image_transfer_requested") ||
      t.includes("image_transform_requested") ||
      t.includes("secret_required"),
  );
  if (hasRequested) return "queued";

  return "processing"; // Fallback
}

export function foldSyncRequests(
  syncEvents: ShopifySyncEvent[],
): FoldedShopifySync {
  const byRequestId = new Map<string, ShopifySyncRequestView>();
  const sortedAsc = sortSyncEventsAsc(syncEvents);

  for (const ev of sortedAsc) {
    const reqId = String(ev.requestId || "").trim();
    if (!reqId) continue;

    let req = byRequestId.get(reqId);
    if (!req) {
      req = {
        requestId: reqId,
        requestEventId: "",
        handle: String(ev.handle || ""),
        requestedBy: String(ev.requestedBy || ""),
        source: String(ev.source || ""),
        requestedAt: Number(ev.requestedAt || 0),
        createdAtMs: Number(ev.createdAtMs || 0),
        processor: "",
        status: "queued",
        apiCalls: [],
        timeline: [],
      };
      byRequestId.set(reqId, req);
    }

    const normalizedEventType = normalizeShopifySyncEventType(ev.eventType);
    req.timeline.push({
      ...ev,
      eventType: normalizedEventType,
    });

    if (normalizedEventType === "sync_requested") {
      req.requestEventId = ev.id;
      req.handle = String(ev.handle || req.handle || "");
      req.requestedBy = String(ev.requestedBy || req.requestedBy || "");
      req.source = String(ev.source || req.source || "");
      req.requestedAt = Number(ev.requestedAt || req.requestedAt || 0);
      req.createdAtMs = Number(ev.createdAtMs || req.createdAtMs || 0);
      req.status = "queued";
    }

    if (normalizedEventType === "sync_claimed") {
      req.processor = String(ev.processor || req.processor || "");
      req.status = "processing";
    }

    if (normalizedEventType === "sync_api_call") {
      const payload = ev.payload || {};
      req.processor = String(ev.processor || req.processor || "");
      req.apiCalls.push({
        eventId: ev.id,
        requestType: String(payload.requestType || "api_call"),
        endpoint: String(payload.endpoint || ""),
        success: !!payload.success,
        response: payload.response,
        context: payload.context,
        loggedAt: Number(ev.createdAtMs || 0),
        processor: String(ev.processor || ""),
      });
    }

    if (normalizedEventType === "sync_completed") {
      req.processor = String(ev.processor || req.processor || "");
      req.status = "success";
      req.result = ev.payload || {};
    }

    if (normalizedEventType === "sync_partial_failed") {
      req.processor = String(ev.processor || req.processor || "");
      req.status = "partial_failed";
      req.result = ev.payload || {};
    }

    if (normalizedEventType === "sync_failed") {
      req.processor = String(ev.processor || req.processor || "");
      req.status = "failed";
      req.result = ev.payload || {};
    }
  }

  const requests = Array.from(byRequestId.values()).sort((a, b) => {
    const aTime = a.requestedAt || a.createdAtMs || 0;
    const bTime = b.requestedAt || b.createdAtMs || 0;
    return bTime - aTime;
  });

  const requestsById: Record<string, ShopifySyncRequestView> = {};
  const requestIds: string[] = [];
  const handleToLatestRequestId: Record<string, string> = {};

  for (const request of requests) {
    requestsById[request.requestId] = request;
    requestIds.push(request.requestId);
    if (request.handle && !handleToLatestRequestId[request.handle]) {
      handleToLatestRequestId[request.handle] = request.requestId;
    }
  }

  return {
    requestsById,
    requestIds,
    handleToLatestRequestId,
  };
}
