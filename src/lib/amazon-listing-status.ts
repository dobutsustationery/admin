import {
  preparationFingerprint,
  previewValid,
  type PreparationRow,
} from "./amazon-preparation";
export const categories = [
  "New listings",
  "Add offers",
  "Zero stock",
  "Updates needed",
  "Needs your input",
  "Ready to publish",
  "In progress",
  "Failed",
  "In sync",
  "Excluded",
] as const;
export type Category = (typeof categories)[number];
export function listingStatus(r: PreparationRow, now: number): Category {
  if (
    /\bnot for sale\b/i.test(r.row.title) ||
    r.decision.deferred ||
    r.decision.included === false
  )
    return "Excluded";
  const same =
    !!r.entry &&
    preparationFingerprint(r.entry) === preparationFingerprint(r.job?.entry);
  if (
    r.job &&
    [
      "queued",
      "publish_queued",
      "publishing",
      "readback_pending",
      "unknown",
    ].includes(r.job.status)
  )
    return r.job.status === "unknown" ? "Failed" : "In progress";
  if (
    r.job?.status === "submitted" &&
    r.row.checkedAt <= (r.job.submittedAt || r.job.updatedAt)
  )
    return "In progress";
  if (r.row.health === "Processing") return "In progress";
  if (same && r.job?.status === "blocked") return "Failed";

  if (
    same &&
    r.job?.status === "ready" &&
    previewValid(r.job) &&
    now - r.job.updatedAt < 1800000
  )
    return "Ready to publish";
  if (r.row.onHand === 0) return "Zero stock";
  if (r.reason === "Price and stock already match Amazon.") return "In sync";
  if (
    !r.row.asin &&
    (r.decision.asin ||
      r.offerMatch?.candidates.length ||
      r.entry?.body?.requirements === "LISTING_OFFER_ONLY")
  )
    return "Add offers";
  if (r.reason) return "Needs your input";
  return r.entry?.method === "PATCH" ? "Updates needed" : "New listings";
}
export function statusDetail(r: PreparationRow, now: number): string {
  const status = listingStatus(r, now);
  if (/\bnot for sale\b/i.test(r.row.title))
    return "Marked NOT FOR SALE in the local catalogue.";
  if (status === "Failed")
    return (
      r.job?.error ||
      "The last attempt failed. Review this product before retrying."
    );
  if (status === "In progress")
    return r.job?.status === "queued"
      ? "Checking with Amazon; nothing is published by validation."
      : "Waiting for Amazon processing or verification.";
  if (status === "Ready to publish")
    return "Amazon validation passed. Review the exact changes before publishing.";
  if (status === "Excluded")
    return "Excluded from Amazon sync by your saved choice.";
  if (status === "Zero stock")
    return r.entry
      ? `Amazon still shows ${r.row.quantity} available. Check and review a stock-only update to zero.`
      : r.reason;
  if (status === "Add offers")
    return (
      r.reason ||
      `Add your offer to ASIN ${r.decision.asin}. Existing Amazon product content will not be replaced.`
    );
  if (r.reason.startsWith("Shared JAN"))
    return "Variants share a barcode. Find and confirm the exact existing ASIN to add an offer, or link an existing seller SKU. Creating a new shared-barcode product is not supported.";
  if (r.reason === "No whole units in stock.")
    return "No positive whole-unit stock. Zero-stock publication is not supported by this flow yet; review existing offers in Amazon.";
  return (
    r.reason ||
    (r.entry?.method === "PUT"
      ? "New listing: check the product information with Amazon."
      : "Price or stock differs from the last Amazon observation.")
  );
}
