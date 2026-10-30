import { previewValid, type PreparationRow } from "./amazon-preparation";
import type { Category } from "./amazon-listing-status";

// New Amifa variants are prepared as one product-level operation. Existing-ASIN
// offers and intentional exclusions keep their current offer workflow.
export function amazonCreationFamilies(
  rows: PreparationRow[],
  listings: Record<string, any>,
): Map<string, PreparationRow[]> {
  const groups = new Map<string, PreparationRow[]>();
  for (const r of rows) {
    if (!r.row.family) continue;
    groups.set(r.row.family, [...(groups.get(r.row.family) || []), r]);
  }
  for (const [handle, members] of groups) {
    if (
      !listings[handle] ||
      members.length < 2 ||
      members.some(
        (r) =>
          !/^amifa\b/i.test(r.row.title) ||
          r.row.asin ||
          r.decision.asin ||
          !!r.offerMatch?.candidates.length ||
          r.decision.deferred ||
          r.decision.included === false ||
          /\bnot for sale\b/i.test(r.row.title),
      )
    )
      groups.delete(handle);
  }
  return groups;
}
export function amazonFamilyStatus(
  members: PreparationRow[],
  jobs: Record<string, any>,
  seller: string,
  now: number,
): Category {
  const handle = members[0].row.family;
  const parent = Object.values(jobs)
    .filter(
      (j) =>
        j.sellerId === seller &&
        j.entry?.family?.handle === handle &&
        j.entry.family.role === "parent",
    )
    .sort(
      (a, b) =>
        b.createdAt - a.createdAt || String(b.id).localeCompare(String(a.id)),
    )[0];
  if (!parent)
    return members.every((r) => r.row.onHand === 0)
      ? "Zero stock"
      : "New listings";
  const batch = Object.values(jobs).filter(
    (j) => j.id === parent.id || j.parentJobId === parent.id,
  );
  if (batch.some((j) => ["blocked", "unknown"].includes(j.status)))
    return "Failed";
  if (
    batch.length === members.length + 1 &&
    batch.every(
      (j) =>
        j.status === "ready" && previewValid(j) && now - j.updatedAt < 1800000,
    )
  )
    return "Ready to publish";
  if (
    batch.some((j) =>
      [
        "queued",
        "publish_queued",
        "publishing",
        "readback_pending",
        "submitted",
      ].includes(j.status),
    )
  )
    return "In progress";
  return "New listings";
}
