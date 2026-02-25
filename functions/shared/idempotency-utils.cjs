/**
 * Shared utilities for idempotent image handling.
 * This file is CommonJS to be compatible with Cloud Functions.
 */

const DERIVATION_KEY_PROPERTY = "derivation_key";

/**
 * Generate a deterministic derivation key for a file in Drive.
 * Format: {source_type}:{source_id}:{transform_name}
 */
function generateDerivationKey(type, id, transform) {
  if (!id) return null;
  // Simple normalization: no colons in IDs, ensure string
  const safeId = String(id).replace(/:/g, "_");
  const safeType = String(type || "unknown");
  const safeTransform = String(transform || "identity");
  return `${safeType}:${safeId}:${safeTransform}`;
}

/**
 * Escape a value for use in a Google Drive API query string.
 */
function escapeDriveQueryValue(value) {
  if (!value) return "";
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Build a query string for searching by derivation key.
 */
function buildDerivationKeyQuery(derivationKey) {
  return `appProperties has { key='${DERIVATION_KEY_PROPERTY}' and value='${escapeDriveQueryValue(derivationKey)}' } and trashed=false`;
}

module.exports = {
  DERIVATION_KEY_PROPERTY,
  generateDerivationKey,
  escapeDriveQueryValue,
  buildDerivationKeyQuery,
};
