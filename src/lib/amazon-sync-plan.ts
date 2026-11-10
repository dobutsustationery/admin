import { imageChanges } from "./amazon-images";
import {
  auditScope,
  UK_MARKETPLACE,
  projectAmazonAudit,
  initialAmazonAudit,
} from "./amazon-audit";
import {
  initialPreparation,
  preparationScope,
  projectPreparation,
  type PreparationEntry,
  type PreparationRow,
} from "./amazon-preparation";
import { buildAmazonVariationFamily } from "./amazon-variation-family";
import { buildAmazonListingCreateDraft } from "./amazon-listing-projection";
import {
  amazonExchangeRate,
  amazonPrice,
  categoryMapping,
  isAmifa,
} from "./amazon-defaults";

export const amazonSyncIssues = {
  presence: "New listings",
  category: "Category",
  quantity: "Inventory quantity",
  price: "Price",
  variant_image: "Variant image",
  gallery: "Product images",
  metadata: "Title and description",
  weight: "Weight",
  variant_structure: "Variant relationships",
  attributes: "Product details",
  featured_offer: "Offer not featured",
  offer_unchecked: "Offer status needs checking",
  all: "All changes",
  attention: "Needs attention",
  processing: "In progress",
  synced: "In sync",
} as const;
export type AmazonSyncIssue = keyof typeof amazonSyncIssues;
export const syncAttributes: Partial<Record<AmazonSyncIssue, string[]>> = {
  attributes: [
    "batteries_required",
    "supplier_declared_dg_hz_regulation",
    "unit_count",
    "number_of_items",
    "model_number",
    "size",
    "safety_warning",
    "condition_type",
    "skip_offer",
    "list_price",
    "country_of_origin",
    "manufacturer",
  ],
  quantity: ["fulfillment_availability"],
  price: ["purchasable_offer"],
  variant_image: ["main_product_image_locator"],
  gallery: Array.from(
    { length: 8 },
    (_, i) => `other_product_image_locator_${i + 1}`,
  ),
  metadata: ["item_name", "product_description", "bullet_point"],
  weight: ["item_package_weight"],
  variant_structure: [
    "parentage_level",
    "variation_theme",
    "child_parent_sku_relationship",
  ],
};
// Amazon adds locale identifiers and changes map order during readback.
export function comparableAmazonAttribute(v: any): string {
  return JSON.stringify(v ?? [], (key, value) => {
    if (key === "marketplace_id" || key === "language_tag") return undefined;
    if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, value[k]]),
        )
      : value;
  });
}
export interface AmazonSyncDetail {
  key: string;
  subtype: string;
  sku: string;
  issue: AmazonSyncIssue;
  local: any;
  remote: any;
  reason: string;
}
export interface AmazonSyncRow {
  handle: string;
  title: string;
  category: string;
  image: string;
  details: AmazonSyncDetail[];
  entries: Partial<Record<AmazonSyncIssue, PreparationEntry[]>>;
  issues: AmazonSyncIssue[];
}
const terminal = new Set(["blocked", "unknown"]);
const pending = new Set([
  "queued",
  "publish_queued",
  "publishing",
  "readback_pending",
]);
export function projectAmazonSync(state: any): AmazonSyncRow[] {
  const audit = state.amazonAudit || initialAmazonAudit;
  if (!audit.sellerId) return [];
  const prep = state.amazonPreparation || initialPreparation;
  const inventory = state.inventory,
    listings = state.listings;
  const seller = audit.sellerId,
    rate = amazonExchangeRate(prep, seller);
  const rows = projectAmazonAudit(audit, inventory, listings);
  const effective = { ...prep, decisions: { ...prep.decisions } };
  for (const row of rows) {
    const listing = listings.handleToListing[row.family];
    if (!isAmifa(listing, inventory.idToItem[row.key])) continue;
    effective.decisions[preparationScope(seller, row.key)] = {
      ...prep.decisions[preparationScope(seller, row.key)],
      priceGBP: String(amazonPrice(inventory.idToItem[row.key]?.price, rate)),
      productType: categoryMapping(prep, seller, listing?.productCategory || "")
        .productType,
    };
  }
  const prepared = projectPreparation(
    effective,
    { ...audit, rows },
    inventory,
    listings,
    undefined,
    state.amazonCatalog,
  );
  const groups = new Map<string, PreparationRow[]>();
  for (const r of prepared) {
    if (
      !r.row.family ||
      !isAmifa(
        listings.handleToListing[r.row.family],
        inventory.idToItem[r.row.key],
      )
    )
      continue;
    groups.set(r.row.family, [...(groups.get(r.row.family) || []), r]);
  }
  return [...groups]
    .flatMap(([handle, members]) => {
      const listing = listings.handleToListing[handle];
      const obs = (r: PreparationRow) =>
        audit.observations[
          auditScope(seller, UK_MARKETPLACE, r.row.sku || r.row.key)
        ];
      if (!members.some((r) => r.row.onHand > 0 || obs(r)?.status === 200))
        return [];
      const mapping = categoryMapping(
        prep,
        seller,
        listing.productCategory || "",
      );
      const result: AmazonSyncRow = {
        handle,
        title: listing.title,
        category: listing.productCategory || "",
        image:
          listing.images?.[0]?.url ||
          inventory.idToItem[members[0].row.key]?.image ||
          "",
        details: [],
        entries: {},
        issues: [],
      };
      function detail(
        r: PreparationRow,
        issue: AmazonSyncIssue,
        local: any,
        remote: any,
        reason = "",
      ) {
        result.details.push({
          key: r.row.key,
          subtype: r.row.subtype,
          sku: r.row.sku || r.row.key,
          issue,
          local,
          remote,
          reason,
        });
        if (!result.issues.includes(issue)) result.issues.push(issue);
      }
      const family =
        members.length > 1
          ? buildAmazonVariationFamily({
              handle,
              rows: members,
              inventory,
              listings,
              decision: {
                productType: mapping.productType,
                variationTheme: mapping.variationTheme,
                identifierExemption: true,
              },
            })
          : null;
      const desired = new Map<string, PreparationEntry>();
      if (family && !family.reason)
        for (const entry of family.entries) desired.set(entry.itemKey, entry);
      if (!family)
        for (const r of members) {
          const draft = buildAmazonListingCreateDraft({
            handle,
            itemKey: r.row.key,
            item: inventory.idToItem[r.row.key],
            listing,
            marketplaceId: UK_MARKETPLACE,
            productType: mapping.productType,
          });
          if (draft)
            desired.set(r.row.key, {
              itemKey: r.row.key,
              sku: r.row.sku || r.row.key,
              method: "PUT",
              body: {
                productType: mapping.productType,
                requirements: "LISTING",
                attributes: {
                  ...draft.submissions[0].payload.attributes,
                  purchasable_offer: [
                    {
                      marketplace_id: UK_MARKETPLACE,
                      currency: "GBP",
                      our_price: [{ schedule: [{ value_with_tax: r.price }] }],
                    },
                  ],
                  fulfillment_availability: [
                    {
                      fulfillment_channel_code: "DEFAULT",
                      quantity: r.row.onHand,
                    },
                  ],
                },
              },
            });
        }

      for (const r of members) {
        const observation = obs(r),
          job = r.job;
        const runs = Object.values(audit.runs || {}) as any[];
        const readback = runs
          .filter(
            (j) =>
              j.sellerId === seller &&
              j.mode === `sku:${r.row.sku || r.row.key}` &&
              j.startedAt >= (job?.submittedAt || Infinity),
          )
          .sort((a, b) => b.startedAt - a.startedAt)[0];
        const inProgress =
          job &&
          (pending.has(job.status) ||
            (job.status === "submitted" &&
              (!observation ||
                observation.at < job.submittedAt ||
                readback?.status === "waiting")));
        const liveRaw = observation?.raw;
        const liveExisting =
          observation?.status === 200 &&
          (liveRaw?.summaries || []).some((s: any) => s.asin);
        const liveType =
          liveRaw?.productTypes?.[0]?.productType ||
          liveRaw?.summaries?.[0]?.productType ||
          "PRODUCT";
        const stockValid =
          Number.isInteger(r.row.onHand) &&
          r.row.onHand >= 0 &&
          Number(inventory.idToItem[r.row.key]?.pieces || 1) === 1;
        const selectable =
          !r.decision.deferred &&
          r.decision.included !== false &&
          !r.row.detail.includes("Multiple inventory") &&
          !r.row.detail.includes("variation parent");
        let reason = "";
        if (inProgress) {
          detail(
            r,
            "processing",
            null,
            null,
            job.error || "Queued on the server or awaiting Amazon readback.",
          );
          continue;
        }
        if (
          job &&
          terminal.has(job.status) &&
          (!observation || observation.at < job.updatedAt)
        ) {
          detail(
            r,
            "attention",
            null,
            null,
            job.error || "Amazon rejected this submission.",
          );
          if (job.status === "unknown") {
            continue;
          }
        }
        if (
          liveExisting &&
          r.row.onHand > 0 &&
          (liveRaw?.summaries || []).some((s: any) =>
            s.status?.includes("BUYABLE"),
          )
        ) {
          const pricing =
            audit.pricing?.[auditScope(seller, UK_MARKETPLACE, r.row.sku)];
          const mine = pricing?.raw?.payload?.Offers?.find(
            (o: any) => o.MyOffer || o.SellerId === seller,
          );
          if (
            pricing?.status === 200 &&
            typeof mine?.IsBuyBoxWinner === "boolean"
          ) {
            if (!mine.IsBuyBoxWinner)
              detail(
                r,
                "featured_offer",
                "Featured Offer",
                "Not featured",
                "Your offer is buyable but Amazon is not featuring it. Check Pricing Health in Seller Central; syncing listing data cannot guarantee selection.",
              );
          } else
            detail(
              r,
              "offer_unchecked",
              null,
              null,
              pricing && pricing.status !== 200
                ? `Featured Offer check failed (HTTP ${pricing.status}). Refresh from Amazon to retry.`
                : "Refresh from Amazon to check Featured Offer status.",
            );
        }
        if (liveExisting && selectable) {
          for (const issue of ["quantity", "price"] as const) {
            const quantity = issue === "quantity";
            const valid = quantity
              ? stockValid
              : r.price > 0 && Number.isFinite(r.price);
            const changed = quantity
              ? r.row.quantity !== r.row.onHand
              : Number(String(r.row.price).replace("GBP ", "")) !== r.price;
            if (!valid || !changed) continue;
            const field = quantity
              ? "fulfillment_availability"
              : "purchasable_offer";
            const value = quantity
              ? [
                  {
                    ...(liveRaw.attributes?.[field]?.find(
                      (a: any) => a.fulfillment_channel_code === "DEFAULT",
                    ) || {}),
                    fulfillment_channel_code: "DEFAULT",
                    quantity: r.row.onHand,
                  },
                ]
              : [
                  {
                    ...(liveRaw.attributes?.[field]?.find(
                      (a: any) =>
                        (!a.marketplace_id ||
                          a.marketplace_id === UK_MARKETPLACE) &&
                        (!a.audience || a.audience === "ALL"),
                    ) || {}),
                    marketplace_id: UK_MARKETPLACE,
                    currency: "GBP",
                    our_price: [{ schedule: [{ value_with_tax: r.price }] }],
                  },
                ];
            detail(r, issue, value, liveRaw.attributes?.[field] || []);
            result.entries[issue] = [
              ...(result.entries[issue] || []),
              {
                itemKey: r.row.key,
                sku: r.row.sku,
                method: "PATCH",
                syncIssue: issue,
                body: {
                  productType: liveType,
                  patches: [
                    { op: "replace", path: `/attributes/${field}`, value },
                  ],
                },
              },
            ];
          }
        }
        if (!mapping.productType)
          reason = "Choose a mapping on Amazon Categories.";
        else if (!(rate > 0) || !Number.isFinite(rate))
          reason = "Set a positive EUR to GBP exchange rate.";
        else if (!(r.price > 0) || !Number.isFinite(r.price))
          reason = "The inventory item needs a positive euro price.";
        else if (
          !Number.isInteger(r.row.onHand) ||
          r.row.onHand < 0 ||
          Number(inventory.idToItem[r.row.key]?.pieces || 1) !== 1
        )
          reason = "Resolve the inventory stock unit.";
        else if (r.decision.deferred || r.decision.included === false)
          reason = "Excluded in advanced preparation.";
        else if (
          r.row.detail.includes("Multiple inventory") ||
          r.row.detail.includes("variation parent")
        )
          reason = r.row.detail;
        else if (observation && ![200, 404].includes(observation.status))
          reason = r.row.detail;
        else if (r.row.sku && !observation)
          reason = "Refresh the mapped seller SKU first.";
        if (reason) {
          detail(
            r,
            mapping.productType ? "attention" : "category",
            mapping.productType,
            "",
            reason,
          );
          continue;
        }
        const want = desired.get(r.row.key);
        if (!want) {
          detail(
            r,
            "attention",
            null,
            null,
            family?.reason || "Could not build the local listing.",
          );
          continue;
        }
        const raw = observation?.raw,
          existing = observation?.status === 200;
        const hasAsin = !!(raw?.summaries || []).find((s: any) => s.asin);
        if (!existing || !hasAsin) {
          const candidates = r.row.skuCandidates.filter((s) => s !== r.row.sku);
          if (
            candidates.length ||
            r.decision.asin ||
            r.offerMatch?.candidates.length
          ) {
            detail(
              r,
              "attention",
              null,
              null,
              "Review the existing ASIN or SKU matches in advanced preparation before creating this product.",
            );
            continue;
          }
          detail(r, "presence", want.body.attributes, null);
          if (!existing && r.row.onHand === 0 && !family) continue;
          result.entries.presence = [
            ...(result.entries.presence || []),
            { ...want, syncIssue: "presence" },
          ];
          continue;
        }
        if ((raw.issues || []).some((i: any) => i.severity === "ERROR"))
          detail(r, "attention", null, null, r.row.detail);
        const remoteType =
          raw.productTypes?.[0]?.productType || raw.summaries?.[0]?.productType;
        if (remoteType !== mapping.productType) {
          detail(r, "category", mapping.productType, remoteType);
          result.entries.category = [
            ...(result.entries.category || []),
            {
              itemKey: r.row.key,
              sku: want.sku,
              method: "PUT",
              syncIssue: "category",
              body: {
                productType: mapping.productType,
                requirements: "LISTING",
                attributes: raw.attributes,
              },
            },
          ];
        }
        for (const [issue, baseFields] of Object.entries(syncAttributes) as [
          AmazonSyncIssue,
          string[],
        ][]) {
          if (issue === "quantity" || issue === "price") continue;
          let fields = baseFields;
          if (issue === "variant_structure") {
            if (!family || family.reason) continue;
            fields = [...fields, want.family!.attribute];
          }
          const a = want.body.attributes,
            b = raw.attributes || {};
          const patches: any[] = [];
          const changedImages =
            issue === "variant_image" || issue === "gallery"
              ? imageChanges(state, seller, want.sku, a, b)
              : null;
          for (const field of fields) {
            if (changedImages && !changedImages.includes(field)) continue;
            let local = a[field] || [],
              remote = b[field] || [];
            const different =
              comparableAmazonAttribute(local) !==
              comparableAmazonAttribute(remote);
            if (!different) continue;
            // Absence of a local optional field does not erase Amazon content.
            if (!local.length && issue !== "gallery") continue;
            detail(r, issue, local, remote);
            patches.push({
              op: local.length ? "replace" : "delete",
              path: `/attributes/${field}`,
              value: local.length ? local : remote,
            });
          }
          if (patches.length) {
            const entry: PreparationEntry = {
              itemKey: r.row.key,
              sku: want.sku,
              method: "PATCH",
              syncIssue: issue,
              body: { productType: remoteType || mapping.productType, patches },
            };
            if (issue === "variant_structure") {
              // Relationship updates include the complete child link and dimension.
              entry.body.patches = fields.map((field) => ({
                op: "replace",
                path: `/attributes/${field}`,
                value: a[field],
              }));
              entry.family = want.family;
            }
            result.entries[issue] = [...(result.entries[issue] || []), entry];
          }
        }
      }
      if (family) {
        for (const issue of ["presence", "variant_structure"] as const) {
          const children = result.entries[issue];
          if (!children?.length) continue;
          const parent = family.entries.find(
            (e) => e.family?.role === "parent",
          );
          // A blocked sibling does not prevent adding a missing, valid child.
          if (parent)
            result.entries[issue] = [
              { ...parent, syncIssue: issue },
              ...children,
            ];
        }
      }
      result.entries.all = combineAmazonChanges(result.entries);
      if (family && !family.reason && result.entries.category?.length) {
        const parent = family.entries.find((e) => e.family?.role === "parent");
        if (parent && !result.entries.all.some((e) => e.sku === parent.sku))
          result.entries.all.unshift({
            ...parent,
            syncIssue: "variant_structure",
          });
        for (const entry of result.entries.all)
          if (entry.updateExisting) {
            const want = desired.get(entry.itemKey);
            if (!want?.family) continue;
            entry.family = want.family;
            for (const field of [
              "parentage_level",
              "variation_theme",
              "child_parent_sku_relationship",
              want.family.attribute,
            ]) {
              entry.body.attributes[field] = want.body.attributes[field];
              entry.syncPatches!.push({
                op: "replace",
                path: `/attributes/${field}`,
                value: want.body.attributes[field],
              });
            }
          }
      }
      if (!result.issues.length) result.issues = ["synced"];
      return [result];
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}
// Keep a family in one request; writes are committed together before leaving UI.
export function batchAmazonSync(
  rows: AmazonSyncRow[],
  issue: AmazonSyncIssue,
): PreparationEntry[][] {
  const batches: PreparationEntry[][] = [];
  for (const row of rows) {
    const entries = row.entries[issue];
    if (!entries?.length) continue;
    if (entries.length > 100 || JSON.stringify(entries).length > 600000)
      throw Error(`${row.title} is too large for one Amazon request.`);
    let batch = batches[batches.length - 1];
    if (
      !batch ||
      batch.length + entries.length > 100 ||
      JSON.stringify([...batch, ...entries]).length > 600000
    ) {
      batch = [];
      batches.push(batch);
    }
    batch.push(...entries);
  }
  if (batches.length > 400 || JSON.stringify(batches).length > 8000000)
    throw Error("Select fewer products for this sync.");
  return batches;
}

// One write per SKU combines every supported difference. Family parents remain
// in the same durable request as any children needing creation/relationships.
export function combineAmazonChanges(
  groups: AmazonSyncRow["entries"],
): PreparationEntry[] {
  const merged = new Map<string, PreparationEntry>();
  const changes = new Map<string, any[]>();
  for (const [issue, entries] of Object.entries(groups)) {
    if (issue === "all") continue;
    for (const entry of entries || []) {
      const old = merged.get(entry.sku);
      if (entry.method === "PUT") {
        if (
          !old ||
          entry.family?.role === "parent" ||
          issue === "presence" ||
          issue === "category"
        )
          merged.set(entry.sku, structuredClone(entry));
      } else {
        changes.set(entry.sku, [
          ...(changes.get(entry.sku) || []),
          ...entry.body.patches,
        ]);
        if (!old)
          merged.set(entry.sku, {
            ...entry,
            syncIssue: "all",
            body: { productType: entry.body.productType, patches: [] },
          });
        else if (entry.family)
          merged.set(entry.sku, { ...old, family: entry.family });
      }
    }
  }
  for (const [sku, entry] of merged) {
    const patches = [
      ...new Map((changes.get(sku) || []).map((p) => [p.path, p])).values(),
    ];
    if (entry.method === "PATCH") {
      entry.syncIssue = "all";
      entry.body.patches = patches;
    } else if (entry.syncIssue === "category") {
      entry.syncIssue = "all";
      (entry as any).updateExisting = true;
      (entry as any).syncPatches = patches;
      for (const p of patches) {
        const key = p.path.replace("/attributes/", "");
        if (p.op === "delete") delete entry.body.attributes[key];
        else entry.body.attributes[key] = p.value;
      }
    }
  }
  return [...merged.values()].sort(
    (a, b) =>
      Number(b.family?.role === "parent") - Number(a.family?.role === "parent"),
  );
}
