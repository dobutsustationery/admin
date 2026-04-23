const crypto = require("crypto");

/**
 * Verifies the HMAC signature of a Shopify webhook request.
 * @param {string|Buffer} rawBody
 * @param {string} hmacHeader
 * @param {string} secret
 * @returns {boolean}
 */
function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  const hash = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");
  
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hash, "base64"),
      Buffer.from(hmacHeader, "base64")
    );
  } catch (e) {
    return false;
  }
}

module.exports = {
  verifyShopifyHmac,
};
