/**
 * Shared utilities for idempotent image handling.
 * This file is CommonJS to be compatible with Cloud Functions.
 */

const DERIVATION_KEY_PROPERTY = "derivation_key";

/**
 * Generate a deterministic derivation key for a file in Drive.
 * Format: {source_type}:{source_id}:{transform_name}
 * @param {string} type
 * @param {string} id
 * @param {string} transform
 * @returns {string|null}
 */
function generateDerivationKey(type, id, transform) {
  if (!id) return null;
  // Simple normalization: no colons in IDs, ensure string
  const safeId = String(id).replace(/:/g, "_");
  const safeType = String(type || "unknown");

  // VERSIONING: We append a version to transforms to allow model upgrades
  // without clashing with old cached results in Drive appProperties.
  let safeTransform = String(transform || "identity");
  if (safeTransform === "remove_bg") {
    safeTransform = "remove_bg_v1";
  }

  return `${safeType}:${safeId}:${safeTransform}`;
}

/**
 * Escape a value for use in a Google Drive API query string.
 * @param {string} value
 * @returns {string}
 */
function escapeDriveQueryValue(value) {
  if (!value) return "";
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Build a query string for searching by derivation key.
 * @param {string} derivationKey
 * @returns {string}
 */
function buildDerivationKeyQuery(derivationKey) {
  return `appProperties has { key='${DERIVATION_KEY_PROPERTY}' and value='${escapeDriveQueryValue(derivationKey)}' } and trashed=false`;
}

/**
 * @param {string} fileId
 * @returns {string}
 */
function toDriveApiMediaUrl(fileId) {
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
}

/**
 * @param {string} fileId
 * @returns {string}
 */
function toDrivePublicUrl(fileId) {
  return `https://lh3.googleusercontent.com/d/${fileId}=s0`;
}

/**
 * Search for a file by its derivation key in appProperties.
 * This is a shared logic helper used by both client and server.
 * @param {string} derivationKey The key to search for.
 * @param {function} executeRequest A callback that takes (url) and returns the JSON response.
 * @returns {Promise<Object|null>} The first matching file object or null.
 */
async function findFileByDerivationKey(derivationKey, executeRequest) {
  const query = buildDerivationKeyQuery(derivationKey);
  // Fields needed by both client and server
  const fields =
    "id,name,mimeType,webViewLink,webContentLink,thumbnailLink,modifiedTime,size";
  const params = new URLSearchParams({
    q: query,
    fields: `files(${fields})`,
    pageSize: "1",
  });

  const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
  const data = await executeRequest(url);
  const first = (data.files || [])[0];
  if (!first) return null;

  // Add derived URLs used by both environments
  return {
    ...first,
    apiUrl: toDriveApiMediaUrl(first.id),
    publicUrl: toDrivePublicUrl(first.id),
  };
}

module.exports = {
  DERIVATION_KEY_PROPERTY,
  generateDerivationKey,
  escapeDriveQueryValue,
  buildDerivationKeyQuery,
  toDriveApiMediaUrl,
  toDrivePublicUrl,
  findFileByDerivationKey,
};
