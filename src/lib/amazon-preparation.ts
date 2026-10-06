import {
  auditScope,
  UK_MARKETPLACE,
  type AmazonAuditState,
  type AuditRow,
} from "./amazon-audit";
import { buildAmazonListingCreateDraft } from "./amazon-listing-projection";
export interface PreparationDecision {
  priceGBP?: string;
  productType?: string;
  deferred?: boolean;
  included?: boolean;
}
export interface PreparationDraft {
  revision: number;
  token: string;
  decisions: Record<string, PreparationDecision>;
  gbpPerEur?: string;
  view: {
    active: boolean;
    query: string;
    tab: string;
    pricingOpen: boolean;
    reviewedJobIds: string[];
  };
}
export const emptyPreparationDraft = (): PreparationDraft => ({
  revision: 0,
  token: "",
  decisions: {},
  view: {
    active: false,
    query: "",
    tab: "prepare",
    pricingOpen: false,
    reviewedJobIds: [],
  },
});
export const preparationDraftScope = (seller: string, owner: string) =>
  auditScope(seller, UK_MARKETPLACE, owner);
export function draftHasChanges(draft: PreparationDraft): boolean {
  return (
    Object.keys(draft.decisions).length > 0 || draft.gbpPerEur !== undefined
  );
}
export interface PreparationEntry {
  itemKey: string;
  sku: string;
  method: "PUT" | "PATCH";
  body: any;
}
export interface PreparationRow {
  row: AuditRow;
  decision: PreparationDecision;
  price: number;
  productType: string;
  reason: string;
  entry: PreparationEntry | null;
  job: any;
}
export interface PreparationState {
  drafts: Record<string, PreparationDraft>;
  decisions: Record<string, PreparationDecision>;
  policies: Record<string, { gbpPerEur: string }>;
  jobs: Record<string, any>;
  rows: PreparationRow[];
}
export const initialPreparation: PreparationState = {
  drafts: {},
  decisions: {},
  policies: {},
  jobs: {},
  rows: [],
};
export const preparationScope = (seller: string, key = "") =>
  auditScope(seller, UK_MARKETPLACE, key);
export function reducePreparation(
  previous = initialPreparation,
  action: any,
): PreparationState {
  const p = action.payload || {};
  if (
    [
      "amazonPrepare/draftDecisionChanged",
      "amazonPrepare/draftPricingChanged",
      "amazonPrepare/draftViewChanged",
      "amazonPrepare/draftApplied",
      "amazonPrepare/draftDiscarded",
    ].includes(action.type) &&
    p.sellerId &&
    p.owner &&
    Number.isFinite(p.revision) &&
    p.token
  ) {
    const key = preparationDraftScope(p.sellerId, p.owner);
    const old = previous.drafts[key] || emptyPreparationDraft();
    if (
      p.revision < old.revision ||
      (p.revision === old.revision && p.token <= old.token)
    )
      return previous;
    let draft = { ...old, revision: p.revision, token: p.token };
    let next = previous;
    if (action.type === "amazonPrepare/draftDecisionChanged") {
      if (
        !p.itemKey ||
        !["priceGBP", "productType", "included", "deferred"].includes(p.field)
      )
        return previous;
      draft = {
        ...draft,
        decisions: {
          ...draft.decisions,
          [p.itemKey]: { ...draft.decisions[p.itemKey], [p.field]: p.value },
        },
        view: { ...draft.view, reviewedJobIds: [] },
      };
    } else if (action.type === "amazonPrepare/draftPricingChanged") {
      draft = {
        ...draft,
        gbpPerEur: p.value,
        view: { ...draft.view, reviewedJobIds: [] },
      };
    } else if (action.type === "amazonPrepare/draftViewChanged") {
      draft = { ...draft, view: { ...draft.view, ...p.changes } };
    } else {
      if (action.type === "amazonPrepare/draftApplied") {
        const decisions = { ...previous.decisions };
        for (const [itemKey, changes] of Object.entries(old.decisions)) {
          const scope = preparationScope(p.sellerId, itemKey);
          decisions[scope] = { ...decisions[scope], ...changes };
        }
        const policies = { ...previous.policies };
        if (old.gbpPerEur !== undefined)
          policies[preparationScope(p.sellerId)] = { gbpPerEur: old.gbpPerEur };
        next = { ...previous, decisions, policies };
      }
      draft = {
        ...emptyPreparationDraft(),
        revision: p.revision,
        token: p.token,
        ...(action.type === "amazonPrepare/draftApplied"
          ? { view: { ...old.view, reviewedJobIds: [] } }
          : {}),
      };
    }
    return { ...next, drafts: { ...previous.drafts, [key]: draft } };
  }

  if (action.type === "amazonPrepare/decision" && p.sellerId && p.itemKey)
    return {
      ...previous,
      decisions: {
        ...previous.decisions,
        [preparationScope(p.sellerId, p.itemKey)]: {
          ...previous.decisions[preparationScope(p.sellerId, p.itemKey)],
          ...p.decision,
        },
      },
    };
  if (action.type === "amazonPrepare/policy" && p.sellerId)
    return {
      ...previous,
      policies: {
        ...previous.policies,
        [preparationScope(p.sellerId)]: {
          gbpPerEur: String(p.gbpPerEur || ""),
        },
      },
    };
  if (
    action.type === "amazonPrepare/job" &&
    p.id &&
    (!previous.jobs[p.id] ||
      p.updatedAt > previous.jobs[p.id].updatedAt ||
      (p.updatedAt === previous.jobs[p.id].updatedAt &&
        p.revision > previous.jobs[p.id].revision))
  )
    return { ...previous, jobs: { ...previous.jobs, [p.id]: p } };
  return previous;
}
export function previewValid(job: any): boolean {
  return (
    job?.validation?.status >= 200 &&
    job.validation.status < 300 &&
    job.validation.data?.status === "VALID" &&
    !(job.validation.data?.issues || []).some(
      (i: any) => i.severity === "ERROR",
    )
  );
}
export function projectPreparation(
  prep: PreparationState,
  audit: AmazonAuditState,
  inventory: any,
  listings: any,
): PreparationRow[] {
  if (!audit.sellerId) return [];
  const latestJobs = new Map<string, any>();
  for (const job of Object.values(prep.jobs)) {
    if (
      job.sellerId !== audit.sellerId ||
      job.marketplaceId !== UK_MARKETPLACE ||
      !job.entry?.itemKey
    )
      continue;
    const previous = latestJobs.get(job.entry.itemKey);
    if (
      !previous ||
      job.createdAt > previous.createdAt ||
      (job.createdAt === previous.createdAt && job.id > previous.id)
    )
      latestJobs.set(job.entry.itemKey, job);
  }
  const factor = Number(
    prep.policies[preparationScope(audit.sellerId)]?.gbpPerEur,
  );
  return audit.rows.map((row) => {
    const item = inventory?.idToItem?.[row.key] || {};
    const listing = listings?.handleToListing?.[row.family];
    const decision =
      prep.decisions[preparationScope(audit.sellerId, row.key)] || {};
    const observation =
      audit.observations[auditScope(audit.sellerId, UK_MARKETPLACE, row.sku)];
    const raw = observation?.raw;
    const existing = observation?.status === 200;
    const oldPrice = row.price.startsWith("GBP ")
      ? Number(row.price.slice(4))
      : 0;
    const price = decision.priceGBP?.trim()
      ? Number(decision.priceGBP)
      : oldPrice > 0
        ? oldPrice
        : factor > 0
          ? Math.round(Number(item.price) * factor * 100) / 100
          : 0;
    const productType = String(
      decision.productType ||
        raw?.productTypes?.[0]?.productType ||
        raw?.summaries?.[0]?.productType ||
        "",
    )
      .trim()
      .toUpperCase();
    let reason = "";
    if (!audit.sellerId) reason = "Refresh the seller catalogue first.";
    else if (decision.deferred) reason = "Set aside for later.";
    else if (!Number.isInteger(row.onHand) || row.onHand <= 0)
      reason = "No whole units in stock.";
    else if (Number(item.pieces || 1) !== 1)
      reason = "Resolve the inventory unit before publishing stock.";
    else if (row.health === "Needs attention" || row.health === "Processing")
      reason = row.detail;
    else if (row.sku && !existing && observation?.status !== 404)
      reason = "Refresh this mapped SKU before continuing.";
    else if (!existing && row.sharedJan)
      reason =
        "Shared JAN: link a verified existing child SKU. New variant creation needs a confirmed identifier or exemption.";
    else if (!existing && row.skuCandidates.length)
      reason =
        "An Amazon SKU already uses this JAN. Verify and save its mapping first.";
    else if (!existing && !/^\d{13}$/.test(row.jan))
      reason = "A valid manufacturer EAN/JAN is needed for creation.";
    else if (!existing && !listing)
      reason =
        "Create the local product listing with its title and images first.";
    else if (
      !Number.isFinite(price) ||
      price <= 0 ||
      Math.abs(Math.round(price * 100) - price * 100) > 0.000001
    )
      reason =
        "Enter a GBP price with at most two decimal places, or set the GBP pricing factor.";
    else if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(productType))
      reason =
        "Choose the Amazon product type (use product-type discovery if unsure).";
    let entry: PreparationEntry | null = null;
    if (!reason) {
      const offer = [
        {
          ...(raw?.attributes?.purchasable_offer?.find(
            (o: any) =>
              (!o.marketplace_id || o.marketplace_id === UK_MARKETPLACE) &&
              (!o.audience || o.audience === "ALL"),
          ) || {}),
          marketplace_id: UK_MARKETPLACE,
          currency: "GBP",
          our_price: [{ schedule: [{ value_with_tax: price }] }],
        },
      ];
      const availability = [
        {
          ...(raw?.attributes?.fulfillment_availability?.find(
            (a: any) => a.fulfillment_channel_code === "DEFAULT",
          ) || {}),
          fulfillment_channel_code: "DEFAULT",
          quantity: row.onHand,
        },
      ];
      if (existing) {
        if (oldPrice === price && row.quantity === row.onHand)
          reason = "Price and stock already match Amazon.";
        else
          entry = {
            itemKey: row.key,
            sku: row.sku,
            method: "PATCH",
            body: {
              productType,
              patches: [
                ...(oldPrice !== price
                  ? [
                      {
                        op: "replace",
                        path: "/attributes/purchasable_offer",
                        value: offer,
                      },
                    ]
                  : []),
                ...(row.quantity !== row.onHand
                  ? [
                      {
                        op: "replace",
                        path: "/attributes/fulfillment_availability",
                        value: availability,
                      },
                    ]
                  : []),
              ],
            },
          };
      } else {
        // This path deliberately prepares a single distinct GTIN product, never
        // infers exemptions or creates a COLOR family from a shared barcode.
        const draft = buildAmazonListingCreateDraft({
          handle: row.family,
          itemKey: row.key,
          item,
          listing,
          marketplaceId: UK_MARKETPLACE,
          productType,
        });
        const attributes = { ...draft?.submissions[0]?.payload.attributes };
        // Do not guess compliance declarations, pack counts or safety warnings.
        for (const name of [
          "batteries_required",
          "supplier_declared_dg_hz_regulation",
          "safety_warning",
          "unit_count",
          "number_of_items",
          "list_price",
        ])
          delete attributes[name];
        attributes.purchasable_offer = offer;
        attributes.fulfillment_availability = availability;
        entry = {
          itemKey: row.key,
          sku: row.sku || row.key,
          method: "PUT",
          body: { productType, requirements: "LISTING", attributes },
        };
      }
    }
    const job = latestJobs.get(row.key);
    return { row, decision, price, productType, reason, entry, job };
  });
}

// Firestore map field order is not significant and may differ after replay.
export function preparationFingerprint(value: any): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}
