import { UK_MARKETPLACE } from "./amazon-audit";
export interface ProductTypeLookupResult {
  status: "idle" | "pending" | "success" | "empty" | "error";
  requestId: string;
  types: { name: string; displayName?: string }[];
  error: string;
}
export function amazonProductTypeLookup(params: {
  responses: Record<string, any>;
  events: Record<string, any>;
  seller: string;
  title: string;
  requestId?: string;
}): ProductTypeLookupResult {
  const { seller, title, requestId = "" } = params;
  const candidates: any[] = [];
  for (const r of Object.values(params.responses)) {
    if (
      r.kind !== "product_type_search" ||
      r.key !== title ||
      r.sellerId !== seller ||
      r.marketplaceId !== UK_MARKETPLACE ||
      (requestId && r.requestId !== requestId)
    )
      continue;
    candidates.push({
      requestId: r.requestId,
      at: r.fetchedAtMs,
      ok: r.ok !== false && r.status >= 200 && r.status < 300,
      raw: r.raw,
      status: r.status,
    });
  }
  const events = Object.values(params.events)
    .filter((e: any) => {
      if (requestId) return e.requestId === requestId;
      const p = e.payload || {},
        c = p.context || {};
      return (
        (c.key || p.searchKey) === title &&
        (c.sellerId || p.sellerId) === seller &&
        (c.marketplaceId || p.marketplaceId) === UK_MARKETPLACE
      );
    })
    .sort(
      (a: any, b: any) =>
        Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0),
    );
  for (const e of events) {
    const p = e.payload || {},
      c = p.context || {};
    if (
      e.eventType !== "amazon/product_type_discovery_api_call" ||
      p.requestType !== "product_type_search"
    )
      continue;
    if (
      c.key !== title ||
      c.sellerId !== seller ||
      c.marketplaceId !== UK_MARKETPLACE
    )
      continue;
    candidates.push({
      requestId: e.requestId,
      at: e.createdAtMs,
      ok: p.success,
      raw: p.response,
      status: c.status,
    });
  }
  const latest = candidates.sort((a, b) => b.at - a.at)[0];
  const result = (
    status: ProductTypeLookupResult["status"],
    id = requestId,
    types: ProductTypeLookupResult["types"] = [],
    error = "",
  ): ProductTypeLookupResult => ({ status, requestId: id, types, error });
  if (latest) {
    if (!latest.ok)
      return result(
        "error",
        latest.requestId,
        [],
        latest.raw?.errors?.map((e: any) => e.message).join(" · ") ||
          latest.raw?.error ||
          `Amazon product type search failed (HTTP ${latest.status}).`,
      );
    const types = (latest.raw?.productTypes || []).filter(
      (t: any) => typeof t.name === "string",
    );
    return result(types.length ? "success" : "empty", latest.requestId, types);
  }
  const failed = events.find(
    (e: any) => e.eventType === "amazon/product_type_discovery_failed",
  );
  if (failed)
    return result(
      "error",
      failed.requestId,
      [],
      failed.payload?.errorMessage ||
        failed.payload?.message ||
        "Amazon product type lookup failed.",
    );
  const completed = events.find(
    (e: any) => e.eventType === "amazon/product_type_discovery_completed",
  );
  if (completed) {
    const types = (completed.payload?.productTypes || []).map(
      (name: string) => ({ name }),
    );
    return result(
      types.length ? "success" : "empty",
      completed.requestId,
      types,
    );
  }
  return result(requestId || events.length ? "pending" : "idle");
}
