import type { AmazonRawApiResponseRecord } from "./amazon-catalog-slice";

export const AMAZON_AUDIT_REQUEST_COLLECTION = "request_amazon_audit";
export const UK_MARKETPLACE = "A1F83G8C2ARO7P";
export type AuditHealth =
  | "Active"
  | "Processing"
  | "Needs attention"
  | "No offer"
  | "Not linked"
  | "Not checked";
export interface AuditObservation {
  sellerId: string;
  marketplaceId: string;
  sku: string;
  at: number;
  raw: any;
  status: number;
  id: string;
}
export interface AuditRun {
  id: string;
  sellerId: string;
  marketplaceId: string;
  mode: string;
  startedAt: number;
  updatedAt: number;
  status: string;
  error: string;
  pages: number;
  count: number;
  nextCheckAt: number;
}
export interface AuditRow {
  key: string;
  family: string;
  title: string;
  jan: string;
  subtype: string;
  onHand: number;
  sharedJan: boolean;
  sku: string;
  asin: string;
  health: AuditHealth;
  detail: string;
  price: string;
  quantity: number | null;
  checkedAt: number;
  skuCandidates: string[];
  mappingSource: string;
}
export interface AmazonAuditState {
  sellerId: string;
  marketplaceId: string;
  observations: Record<string, AuditObservation>;
  submissions: Record<string, { at: number; raw: any }>;
  mappings: Record<string, string>;
  runs: Record<string, AuditRun>;
  chunks: Record<string, Record<string, string>>;
  receipts: Record<string, any>;
  rows: AuditRow[];
}
export const initialAmazonAudit: AmazonAuditState = {
  sellerId: "",
  marketplaceId: UK_MARKETPLACE,
  observations: {},
  submissions: {},
  mappings: {},
  runs: {},
  chunks: {},
  receipts: {},
  rows: [],
};
export const auditScope = (seller: string, marketplace: string, key: string) =>
  JSON.stringify([seller, marketplace, key]);
const list = (v: any): any[] => (Array.isArray(v) ? v : []);
const text = (v: any) => String(v ?? "").trim();

export function listingHealth(
  raw: any,
  status = 200,
): { health: AuditHealth; detail: string } {
  if (status === 404)
    return {
      health: "No offer",
      detail: "Amazon did not find this seller SKU.",
    };
  if (status < 200 || status >= 300)
    return {
      health: "Needs attention",
      detail: `Amazon read failed (HTTP ${status}). Refresh after resolving the error.`,
    };
  const errors = list(raw?.issues).filter((i) => i.severity === "ERROR");
  if (errors.length)
    return {
      health: "Needs attention",
      detail: errors.map((i) => `${i.code}: ${i.message}`).join(" · "),
    };
  const statuses = list(raw?.summaries).flatMap((s) => list(s.status));
  if (statuses.includes("BUYABLE"))
    return {
      health: "Active",
      detail:
        "Amazon reports a buyable offer. Search ranking and Brand Store placement are separate.",
    };
  const quantity = list(raw?.fulfillmentAvailability).find(
    (a) => a.fulfillmentChannelCode === "DEFAULT",
  )?.quantity;
  if (Number(quantity) === 0 && quantity !== undefined)
    return {
      health: "No offer",
      detail: "No merchant-fulfilled stock is available on Amazon.",
    };
  return {
    health: "Processing",
    detail:
      "Not buyable yet. Automatic checks distinguish delayed processing from errors; acceptance alone is not success.",
  };
}

function observe(state: AmazonAuditState, o: AuditObservation) {
  if (!o.sellerId || !o.marketplaceId || !o.sku) return;
  const key = auditScope(o.sellerId, o.marketplaceId, o.sku);
  const old = state.observations[key];
  if (!old || o.at > old.at || (o.at === old.at && o.id > old.id))
    state.observations[key] = o;
}

export function projectAmazonAudit(
  state: AmazonAuditState,
  inventory: any,
  listings: any,
): AuditRow[] {
  const entries = Object.entries(inventory?.idToItem || {}) as [string, any][];
  const janCount = new Map<string, number>();
  for (const [, item] of entries)
    janCount.set(
      text(item.janCode),
      (janCount.get(text(item.janCode)) || 0) + 1,
    );
  const observations = Object.values(state.observations).filter(
    (o) =>
      o.sellerId === state.sellerId && o.marketplaceId === state.marketplaceId,
  );
  const bySku = new Map(observations.map((o) => [o.sku, o]));
  const claims = new Map<string, string[]>();
  for (const [key] of entries) {
    const sku =
      state.mappings[auditScope(state.sellerId, state.marketplaceId, key)] ||
      (bySku.has(key) ? key : "");
    if (sku) claims.set(sku, [...(claims.get(sku) || []), key]);
  }
  return entries
    .flatMap(([key, item]) => {
      const handle = listings?.idToHandle?.[key] || item.handle || "";
      const listing = listings?.handleToListing?.[handle] || {};
      const identity = [
        listing.title,
        listing.brand,
        item.brand,
        item.manufacturer,
        item.description,
        handle,
      ].join(" ");
      if (!/\bamifa\b/i.test(identity)) return [];
      const jan = text(item.janCode);
      const mapped =
        state.mappings[auditScope(state.sellerId, state.marketplaceId, key)];
      const sku = mapped || (bySku.has(key) ? key : "");
      const observation = bySku.get(sku);
      const raw = observation?.raw;
      const sharedJan = (janCount.get(jan) || 0) > 1;
      const candidates = observations
        .filter((o) =>
          list(o.raw?.attributes?.externally_assigned_product_identifier).some(
            (v) => text(v.value) === jan,
          ),
        )
        .map((o) => o.sku);
      let health: { health: AuditHealth; detail: string } = observation
        ? listingHealth(raw, observation.status)
        : {
            health: state.sellerId ? "Not linked" : "Not checked",
            detail: sharedJan
              ? "Shared JAN: choose the correct existing SKU or resolve variant identifiers before creation. An exemption is not assumed."
              : "Refresh the seller catalogue, then link an existing SKU or review this product for creation.",
          };
      if (mapped && !observation)
        health = {
          health: "Not checked",
          detail:
            "SKU mapping saved. Select this row and refresh to verify its Amazon offer.",
        };
      const submitted =
        state.submissions[
          auditScope(state.sellerId, state.marketplaceId, sku || key)
        ];
      if (submitted && (!observation || submitted.at > observation.at))
        health =
          list(submitted.raw?.issues).some((i) => i.severity === "ERROR") ||
          submitted.raw?.status === "INVALID"
            ? {
                health: "Needs attention",
                detail:
                  list(submitted.raw?.issues)
                    .map((i) => `${i.code}: ${i.message}`)
                    .join(" · ") ||
                  "Amazon rejected the submission. Open Diagnostics for the response.",
              }
            : {
                health: "Processing",
                detail:
                  "Submission recorded; awaiting a newer Amazon observation.",
              };
      if (sku && (claims.get(sku)?.length || 0) > 1)
        health = {
          health: "Needs attention",
          detail:
            "Multiple inventory items map to this seller SKU. Resolve the mapping before syncing.",
        };
      if (
        raw?.attributes?.parentage_level?.some((v: any) => v.value === "parent")
      )
        health = {
          health: "Needs attention",
          detail:
            "This SKU is a variation parent. Link the sellable child SKU instead.",
        };
      const offer = list(raw?.offers).find(
        (o) => !o.marketplaceId || o.marketplaceId === state.marketplaceId,
      );
      const price = offer?.price;
      const quantity = list(raw?.fulfillmentAvailability).find(
        (a) => a.fulfillmentChannelCode === "DEFAULT",
      )?.quantity;
      const checkRun = Object.values(state.runs)
        .filter(
          (r) =>
            r.id &&
            r.marketplaceId === state.marketplaceId &&
            r.sellerId === state.sellerId &&
            r.mode === `sku:${sku}`,
        )
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      if (health.health === "Processing" && checkRun?.status === "expired")
        health = {
          health: "Needs attention",
          detail:
            "Automatic checks reached the 24-hour deadline. Review Diagnostics or contact Amazon; nothing was resubmitted.",
        };
      if (
        checkRun?.status === "failed" &&
        (!observation || checkRun.updatedAt >= observation.at)
      )
        health = {
          health: "Needs attention",
          detail:
            checkRun.error || "Automatic readback failed. Refresh to retry.",
        };
      return [
        {
          key,
          family: handle || jan || key,
          title: text(listing.title || item.description || key),
          jan,
          subtype: text(listing.variantOptionsByItemId?.[key] || item.subtype),
          onHand: Number(item.qty || 0) - Number(item.shipped || 0),
          sharedJan,
          sku,
          asin: text(
            list(raw?.summaries).find(
              (s) =>
                !s.marketplaceId || s.marketplaceId === state.marketplaceId,
            )?.asin,
          ),
          ...health,
          price: price
            ? `${price.currencyCode || price.currency || ""} ${price.amount ?? ""}`.trim()
            : "—",
          quantity: typeof quantity === "number" ? quantity : null,
          checkedAt: observation?.at || 0,
          skuCandidates: candidates,
          mappingSource: mapped
            ? "Saved mapping"
            : sku
              ? "Exact local identity / seller SKU match"
              : "",
        },
      ];
    })
    .sort(
      (a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key),
    );
}

export function reduceAmazonAudit(
  previous: AmazonAuditState = initialAmazonAudit,
  action: any,
): AmazonAuditState {
  const p = action.payload || {};
  if (
    !action.type?.startsWith("amazonAudit/") &&
    ![
      "amazonCatalog/apply_probe_chunk",
      "amazonCatalog/apply_listing_write_result",
    ].includes(action.type)
  )
    return previous;
  const state: AmazonAuditState = {
    ...previous,
    observations: { ...previous.observations },
    submissions: { ...previous.submissions },
    mappings: { ...previous.mappings },
    runs: { ...previous.runs },
    chunks: { ...previous.chunks },
    receipts: { ...previous.receipts },
  };
  if (action.type === "amazonAudit/map") {
    if (p.sellerId && p.marketplaceId && p.itemKey) {
      const key = auditScope(p.sellerId, p.marketplaceId, p.itemKey);
      if (text(p.sku)) state.mappings[key] = text(p.sku);
      else delete state.mappings[key];
    }
  } else if (action.type === "amazonAudit/chunk") {
    state.chunks[p.responseId] = {
      ...state.chunks[p.responseId],
      [p.index]: p.json,
    };
  } else if (action.type === "amazonAudit/response") {
    state.receipts[p.responseId] = p;
  } else if (action.type === "amazonAudit/job") {
    const old = state.runs[p.id];
    if (!old || p.updatedAt >= old.updatedAt)
      state.runs[p.id] = { ...old, ...p };
    // Only full audits select the active seller. Targeted readbacks cannot flip scope.
    if (
      p.mode === "catalogue" &&
      !Object.values(previous.runs).some(
        (r) => r.mode === "catalogue" && r.startedAt > p.startedAt,
      )
    ) {
      state.sellerId = p.sellerId;
      state.marketplaceId = p.marketplaceId;
    }
  } else {
    for (const r of (p.responses || []) as AmazonRawApiResponseRecord[]) {
      if (r.kind === "seller_listing_get_by_sku")
        observe(state, {
          sellerId: r.sellerId,
          marketplaceId: r.marketplaceId,
          sku: r.key,
          at: r.fetchedAtMs,
          raw: r.raw,
          status: r.status,
          id: r.id,
        });
      if (r.kind === "seller_listing_put") {
        const key = auditScope(r.sellerId, r.marketplaceId, r.key);
        if (
          !state.submissions[key] ||
          r.fetchedAtMs > state.submissions[key].at
        )
          state.submissions[key] = { at: r.fetchedAtMs, raw: r.raw };
      }
    }
  }
  for (const [id, receipt] of Object.entries(state.receipts)) {
    const chunks = state.chunks[id];
    if (
      !chunks ||
      !Number.isInteger(receipt.chunks) ||
      receipt.chunks < 1 ||
      Array.from({ length: receipt.chunks }, (_, i) => chunks[i]).some(
        (c) => typeof c !== "string",
      )
    )
      continue;
    try {
      const raw = JSON.parse(
        Array.from({ length: receipt.chunks }, (_, i) => chunks[i]).join(""),
      );
      const items = receipt.sku
        ? [{ ...raw, sku: receipt.sku }]
        : list(raw.items);
      for (const item of items)
        observe(state, {
          sellerId: receipt.sellerId,
          marketplaceId: receipt.marketplaceId,
          sku: item.sku,
          at: receipt.at,
          raw: item,
          status: receipt.status,
          id,
        });
      delete state.chunks[id];
      delete state.receipts[id];
    } catch {
      /* Preserve incomplete/corrupt input for diagnosis. */
    }
  }
  return state;
}
