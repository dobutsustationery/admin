const crypto = require("crypto");

/**
 * Verifies the HMAC signature of a Shopify webhook request.
 */
function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  const hash = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");
  return hash === hmacHeader;
}

module.exports = {
  verifyShopifyHmac,
};
