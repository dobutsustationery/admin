const crypto = require("crypto");

/**
 * Verifies the Etsy webhook signature.
 * Etsy v3 webhooks include an x-etsy-signature header.
 * The signature is a HMAC-SHA256 hash of:
 *   webhook_id + "." + webhook_timestamp + "." + raw_body
 *
 * @param {string|Buffer} rawBody
 * @param {string} signatureHeader
 * @param {string} secret
 * @param {string} webhookId
 * @param {string} webhookTimestamp
 * @returns {boolean}
 */
function verifyEtsyWebhookSignature(
  rawBody,
  signatureHeader,
  secret,
  webhookId,
  webhookTimestamp,
) {
  if (!signatureHeader || !secret || !webhookId || !webhookTimestamp) {
    return false;
  }

  // 1. Prepare the secret (remove prefix and decode)
  const secretKey = secret.replace("whsec_", "");
  const secretBytes = Buffer.from(secretKey, "base64");

  // 2. Construct the signed content string
  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;

  // 3. Compute HMAC-SHA256
  const hmac = crypto.createHmac("sha256", secretBytes);
  hmac.update(signedContent);
  const expectedSignature = hmac.digest("base64");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, "base64"),
      Buffer.from(signatureHeader, "base64"),
    );
  } catch (e) {
    return false;
  }
}

/**
 * Fetches receipts that have been modified since the given timestamp.
 * Supports pagination.
 * @param {Object} config Etsy configuration
 * @param {number} lastModifiedTimestamp Cursor in seconds
 * @returns {Promise<Array>} List of raw Etsy receipts
 */
async function fetchChangedReceipts(config, lastModifiedTimestamp) {
  const { shopId, apiKey, accessToken } = config;
  if (!shopId || !accessToken) {
    throw new Error("Missing Etsy shopId or accessToken");
  }

  let allReceipts = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    // Etsy v3: GET /v3/application/shops/{shop_id}/receipts
    // Query params: min_last_modified_timestamp
    const params = new URLSearchParams({
      min_last_modified_timestamp: String(lastModifiedTimestamp),
      limit: String(limit),
      offset: String(offset),
    });

    const url = `https://openapi.etsy.com/v3/application/shops/${shopId}/receipts?${params.toString()}`;

    const response = await fetch(url, {
      headers: {
        "x-api-key": apiKey,
        "Authorization": `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Etsy API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const receipts = data.results || [];
    allReceipts = allReceipts.concat(receipts);

    if (receipts.length < limit) {
      break;
    }
    offset += limit;
  }

  // Each receipt needs its transactions for inventory mapping.
  // Using a small concurrency limit to avoid hitting Etsy rate limits too hard.
  const CONCURRENCY = 5;
  const results = [];
  for (let i = 0; i < allReceipts.length; i += CONCURRENCY) {
    const chunk = allReceipts.slice(i, i + CONCURRENCY);
    const fullChunk = await Promise.all(
      chunk.map(async (receipt) => {
        const transactions = await fetchReceiptTransactions(
          config,
          receipt.receipt_id,
        );
        return {
          ...receipt,
          transactions,
        };
      }),
    );
    results.push(...fullChunk);
  }

  return results;
}

async function fetchReceiptTransactions(config, receiptId) {
  const { apiKey, accessToken } = config;
  const url = `https://openapi.etsy.com/v3/application/shops/${config.shopId}/receipts/${receiptId}/transactions`;
  
  const response = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
      "Authorization": `Bearer ${accessToken}`,
    }
  });

  if (!response.ok) {
    return []; // Fallback to empty if transactions fail
  }

  const data = await response.json();
  return data.results || [];
}

module.exports = {
  verifyEtsyWebhookSignature,
  fetchChangedReceipts,
};
