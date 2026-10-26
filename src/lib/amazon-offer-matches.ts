import { UK_MARKETPLACE } from "./amazon-audit";
export interface OfferCandidate {
  asin: string;
  title: string;
  brand: string;
  details: any;
  image: string;
}
export function offerMatches(
  catalog: any,
  sellerId: string,
  jan: string,
): {
  checked: boolean;
  error: string;
  candidates: OfferCandidate[];
} {
  const latest = (Object.values(catalog?.rawResponsesById || {}) as any[])
    .filter(
      (r) =>
        r.kind === "catalog_search_by_jan" &&
        r.key === jan &&
        r.sellerId === sellerId &&
        r.marketplaceId === UK_MARKETPLACE,
    )
    .sort((a, b) => b.fetchedAtMs - a.fetchedAtMs)[0];
  return {
    checked: !!latest,
    error:
      latest && (!latest.ok || latest.status !== 200)
        ? `Amazon catalogue lookup failed (HTTP ${latest.status}). Retry the lookup.`
        : "",
    candidates:
      latest?.ok && latest.status === 200
        ? (latest.raw?.items || [])
            .filter((i: any) => /^[A-Z0-9]{10}$/.test(i.asin))
            .map((i: any) => ({
              asin: i.asin,
              title: i.summaries?.[0]?.itemName || i.asin,
              brand: i.summaries?.[0]?.brand || "",
              details: i.attributes || {},
              image:
                [
                  ...((
                    i.images?.find(
                      (group: any) => group.marketplaceId === UK_MARKETPLACE,
                    ) || i.images?.[0]
                  )?.images || []),
                ].sort(
                  (a: any, b: any) =>
                    Number(b.variant === "MAIN") -
                      Number(a.variant === "MAIN") ||
                    Number(b.height) * Number(b.width) -
                      Number(a.height) * Number(a.width),
                )[0]?.link || "",
            }))
        : [],
  };
}
