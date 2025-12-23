/**
 * Generates a Shopify-compatible handle from a title and JAN code.
 * Format: slugified-title-jancode
 */
export function generateHandle(title: string, jan: string): string {
  const slug = title
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[\s\W-]+/g, "-") // Replace spaces and non-word chars with -
    .replace(/^-+|-+$/g, ""); // Remove leading/trailing -

  return `${slug}-${jan}`;
}
