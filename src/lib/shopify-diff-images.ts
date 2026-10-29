import { normalizeImageUrl } from "./shopify-deep-diff";
import { toGoogleDrivePublicImageUrl } from "./drive-url";

// Comparable values contain identities, not necessarily renderable URLs.
// Prefer the observed source so Shopify previews show its actual CDN copy.
export function shopifyDiffImageUrl(
  value: unknown,
  sourceUrls: string[] = [],
): string {
  const identity = String(value || "").trim();
  if (!identity) return "";
  const normalized = normalizeImageUrl(identity);
  const source = sourceUrls.find(
    (url) => /^https?:\/\//.test(url) && normalizeImageUrl(url) === normalized,
  );
  if (source) return source;
  if (identity.startsWith("drive:"))
    return toGoogleDrivePublicImageUrl(identity.slice(6));
  return /^https?:\/\//.test(identity) ? identity : "";
}
