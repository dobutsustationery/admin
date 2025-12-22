
/**
 * Generates a Shopify-compatible handle from a title and JAN code.
 * Format: slugified-title-jancode
 */
export function generateHandle(title: string, jan: string): string {
    const slug = title
        .toString()
        .toLowerCase()
        .trim()
        .replace(/[\s\W-]+/g, '-') // Replace spaces and non-word chars with -
        .replace(/^-+|-+$/g, ''); // Remove leading/trailing -
    
    // Shopify handles generally don't *strictly* require the JAN appended, 
    // but the existing logic in shopify-products enforced it to ensure uniqueness-ish.
    // However, the requested logic "reuse the same logic that is already in shopify-products"
    // The previous code in shopify-products was:
    /*
        const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""); // Trim dashes
        return `${slug}-${jan}`;
    */
    // The previous code in shopify-import was slightly different (no jan appended).
    // The user explicitly said: "The 'auto-generated' handles are wrong. They should reuse the same logic that is already in the shopify-products code."
    // So I MUST use the logic that appends the JAN.
    
    return `${slug}-${jan}`;
}
