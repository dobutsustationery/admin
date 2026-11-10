import { auditScope, UK_MARKETPLACE } from "./amazon-audit";

export const amazonImageFields = [
  "main_product_image_locator",
  ...Array.from(
    { length: 8 },
    (_, i) => `other_product_image_locator_${i + 1}`,
  ),
];
export function sourceImageKey(url: string): string {
  const drive = url.match(/(?:\/d\/|[?&]id=)([A-Za-z0-9_-]+)/)?.[1];
  if (drive) return `drive:${drive}`;
  return String(url)
    .replace(/([?&])v=\d+(&|$)/, "$1")
    .replace(/[?&]$/, "");
}
export function imageSignature(attributes: any, fields = amazonImageFields) {
  return JSON.stringify(
    fields.map((field) =>
      (attributes?.[field] || []).map((v: any) =>
        sourceImageKey(v.media_location || ""),
      ),
    ),
  );
}
export function imageAttributes(attributes: any) {
  return Object.fromEntries(
    amazonImageFields
      .filter((k) => attributes?.[k]?.length)
      .map((k) => [k, attributes[k]]),
  );
}
export function rejectedAmazonImageFields(issues: any[] = []): string[] {
  const fields = new Set<string>();
  for (const issue of issues) {
    if (issue.severity !== "ERROR") continue;
    const named = (issue.attributeNames || []).filter((field: string) =>
      amazonImageFields.includes(field),
    );
    if (named.length) named.forEach((field: string) => fields.add(field));
    else if (
      String(issue.code) === "18320" ||
      issue.categories?.some((category: string) =>
        ["INVALID_IMAGE", "MISSING_IMAGE"].includes(category),
      )
    )
      fields.add("main_product_image_locator");
  }
  return [...fields];
}
// Accepted request bytes preserve source identity; Amazon's CDN URLs do not.
export function imageChanges(
  state: any,
  seller: string,
  sku: string,
  desired: any,
  remote: any,
  rejected: string[] = [],
) {
  let baseline =
    state.amazonAudit?.imageBaselines?.[
      auditScope(seller, UK_MARKETPLACE, sku)
    ];
  let sources = baseline?.sources || {},
    at = baseline?.at || 0;
  const jobs = (Object.values(state.amazonPreparation?.jobs || {}) as any[])
    .filter(
      (j) =>
        j.sellerId === seller &&
        j.marketplaceId === UK_MARKETPLACE &&
        j.entry?.sku === sku &&
        j.result?.data?.status === "ACCEPTED" &&
        j.submittedAt > at,
    )
    .sort((a, b) => a.submittedAt - b.submittedAt || a.id.localeCompare(b.id));
  for (const job of jobs) {
    if (
      job.entry.method === "PUT" &&
      !job.entry.updateExisting &&
      job.entry.syncIssue !== "category"
    )
      sources = { ...sources, ...imageAttributes(job.entry.body.attributes) };
    else
      for (const patch of job.entry.syncPatches ||
        job.entry.body.patches ||
        []) {
        const field = patch.path.replace("/attributes/", "");
        if (amazonImageFields.includes(field))
          sources = {
            ...sources,
            [field]: patch.op === "delete" ? [] : patch.value,
          };
      }
  }
  const tracked =
    !!baseline ||
    jobs.some(
      (j) =>
        (j.entry.method === "PUT" &&
          !j.entry.updateExisting &&
          j.entry.syncIssue !== "category") ||
        j.entry.body.patches?.some((p: any) =>
          amazonImageFields.includes(p.path.replace("/attributes/", "")),
        ),
    );
  return amazonImageFields.filter((field) => {
    const want = desired?.[field] || [],
      actual = remote?.[field] || [];
    if (want.length && rejected.includes(field)) return true;
    if (tracked)
      return (
        imageSignature(desired, [field]) !== imageSignature(sources, [field]) ||
        (want.length > 0 &&
          !actual.length &&
          (!baseline || baseline.remote?.[field]?.length))
      );
    // Legacy images confirmed by the operator: CDN substitution is not drift.
    // A subsequent recorded baseline lets us detect later local replacements.
    if (actual.length)
      return (
        !actual.every((v: any) =>
          /^https:\/\/(?:m\.media-amazon\.com|images[^/]*\.ssl-images-amazon\.com)\//i.test(
            v.media_location || "",
          ),
        ) &&
        imageSignature(desired, [field]) !== imageSignature(remote, [field])
      );
    return want.length > 0;
  });
}

// First adoption records the operator-confirmed existing images once. Subsequent
// local changes compare with this durable source snapshot, never a new baseline.
export async function legacyImageBaselines(state: any) {
  const { buildAmazonListingCreateDraftFromState } =
    await import("./amazon-listing-projection");
  const seller = state.amazonAudit?.sellerId;
  const items: any[] = [];
  for (const [key, item] of Object.entries(state.inventory.idToItem || {}) as [
    string,
    any,
  ][]) {
    const sku =
      state.amazonAudit.mappings?.[auditScope(seller, UK_MARKETPLACE, key)] ||
      key;
    const observation =
      state.amazonAudit.observations?.[auditScope(seller, UK_MARKETPLACE, sku)];
    const handle = state.listings.idToHandle?.[key] || item.handle;
    const listing = state.listings.handleToListing?.[handle];
    if (
      !/^amifa\b/i.test(listing?.title || "") ||
      observation?.status !== 200 ||
      !observation.raw?.summaries?.some((s: any) => s.asin)
    )
      continue;
    const draft = buildAmazonListingCreateDraftFromState({
      state,
      handle,
      itemKey: key,
      marketplaceId: UK_MARKETPLACE,
      productType: observation.raw.summaries[0].productType,
    });
    const desired = draft?.submissions.find((s) => s.itemKey === key)?.payload
      .attributes;
    if (desired)
      items.push({
        sku,
        sources: imageAttributes(desired),
        remote: imageAttributes(observation.raw.attributes),
        at: Date.now(),
      });
  }
  return items;
}
