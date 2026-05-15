/**
 * Generates a Shopify-compatible handle from a title and JAN code.
 * Format: slugified-title-jancode
 */
export function generateHandle(title: string, jan: string): string {
  return `${slugifyHandlePart(title)}-${jan}`;
}

/**
 * Slug-shape a free-form string into the part of a Shopify handle that
 * sits before the trailing `-${jan}`. Lowercases, replaces whitespace and
 * non-word chars with `-`, and strips leading/trailing `-`.
 */
function slugifyHandlePart(value: string): string {
  return value
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[\s\W-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Shopify handles: lowercase letters, digits, single hyphens. No spaces,
// no `&`, no parens, no uppercase, no leading/trailing/consecutive hyphens.
const SHOPIFY_HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Canonicalize a user-typed handle string for a given JAN.
 *
 * Goal: if the operator typed something Shopify can't accept (spaces,
 * `&`, parens, uppercase, …), clean it up. If the operator typed an
 * already-valid slug — including a slug that intentionally omits the
 * trailing `-${jan}` so multiple JANs can share one Shopify listing
 * (e.g. `uni-propus-window-highlighter`) — leave it alone.
 *
 * Three input shapes:
 *  - Already a valid Shopify slug → returned as-is.
 *  - Free-form title-shaped text → slugified and `-${jan}` appended
 *    (matching `generateHandle(title, jan)` shape).
 *  - Empty / falsy → returns `""` so downstream callers fall through
 *    to `proposal.handle || generateHandle(title, jan)` rather than
 *    pinning the handle to the bare JAN.
 */
export function canonicalizeHandle(value: string, jan: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  const janStr = String(jan || "").trim();
  if (SHOPIFY_HANDLE_RE.test(trimmed)) return trimmed;
  const slug = slugifyHandlePart(trimmed);
  if (!slug) return "";
  if (!janStr) return slug;
  return slug.endsWith(`-${janStr}`) ? slug : `${slug}-${janStr}`;
}

export { generateSku } from "./sku";
