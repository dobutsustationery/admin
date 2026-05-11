const crypto = require("crypto");

/**
 * Verifies the Etsy webhook signature.
 * Etsy v3 webhooks include an x-etsy-signature header.
 * The signature is a HMAC-SHA256 hash of:
 *   webhook_id + "." + webhook_timestamp + "." + raw_body
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
  const secretKey = secret.replace("whsec_", "");
  const secretBytes = Buffer.from(secretKey, "base64");
  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
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
 * Refresh the Etsy OAuth tokens using the stored refresh_token.
 * Etsy v3 access tokens expire after ~1 hour; refresh tokens rotate on
 * every refresh, so the caller MUST persist the returned pair.
 */
async function refreshEtsyTokens(config) {
  const body = {
    grant_type: "refresh_token",
    client_id: config.keystring,
    refresh_token: config.refreshToken,
  };
  // Confidential clients also need the keystring shared secret.  Public
  // clients will reject it; Etsy currently accepts the extra parameter for
  // both client types, so we always include it when available.
  if (config.keystringSharedSecret) {
    body.client_secret = config.keystringSharedSecret;
  }
  const resp = await fetch("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!resp.ok) {
    throw new Error(`Etsy token refresh failed (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json();
  if (!data.access_token || !data.refresh_token) {
    throw new Error(`Etsy token refresh: malformed response ${JSON.stringify(data)}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in || 3600,
  };
}

/**
 * Fetch an Etsy v3 endpoint, refreshing the access token once on 401
 * "invalid_token / expired" and retrying.  `config` is mutated in place
 * with the new tokens so subsequent calls in the same run reuse them.
 * `onTokensRefreshed`, if provided, is awaited after a successful
 * refresh so callers can persist the new pair.
 */
async function fetchEtsyApi(config, url, opts = {}, onTokensRefreshed) {
  const doCall = () =>
    fetch(url, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        "x-api-key": config.apiKey,
        Authorization: `Bearer ${config.accessToken}`,
      },
    });
  let resp = await doCall();
  if (resp.status === 401) {
    const body = await resp.text();
    const looksExpired =
      body.includes("invalid_token") ||
      body.includes("expired") ||
      body.includes("access token");
    if (!looksExpired || !config.refreshToken) {
      // Reconstitute the response so the caller still sees a proper
      // Response-like object with the body we already consumed.
      return new Response(body, { status: 401, headers: resp.headers });
    }
    const tokens = await refreshEtsyTokens(config);
    config.accessToken = tokens.accessToken;
    config.refreshToken = tokens.refreshToken;
    if (onTokensRefreshed) {
      await onTokensRefreshed(tokens);
    }
    resp = await doCall();
  }
  return resp;
}

/**
 * Fetches receipts that have been modified since the given timestamp.
 * Supports pagination and transparent token refresh.
 */
async function fetchChangedReceipts(
  config,
  lastModifiedTimestamp,
  onTokensRefreshed,
) {
  const { shopId, accessToken } = config;
  if (!shopId || !accessToken) {
    throw new Error("Missing Etsy shopId or accessToken");
  }

  let allReceipts = [];
  let offset = 0;
  const limit = 50;
  let pageCount = 0;
  const MAX_PAGES = 100; // Safety cap

  while (pageCount < MAX_PAGES) {
    pageCount++;
    const params = new URLSearchParams({
      min_last_modified_timestamp: String(lastModifiedTimestamp),
      limit: String(limit),
      offset: String(offset),
    });
    const url = `https://openapi.etsy.com/v3/application/shops/${shopId}/receipts?${params.toString()}`;
    const response = await fetchEtsyApi(config, url, {}, onTokensRefreshed);

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

  const CONCURRENCY = 5;
  const results = [];
  for (let i = 0; i < allReceipts.length; i += CONCURRENCY) {
    const chunk = allReceipts.slice(i, i + CONCURRENCY);
    const fullChunk = await Promise.all(
      chunk.map(async (receipt) => {
        const transactions = await fetchReceiptTransactions(
          config,
          receipt.receipt_id,
          onTokensRefreshed,
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

async function fetchReceiptTransactions(config, receiptId, onTokensRefreshed) {
  const url = `https://openapi.etsy.com/v3/application/shops/${config.shopId}/receipts/${receiptId}/transactions`;
  const response = await fetchEtsyApi(config, url, {}, onTokensRefreshed);
  if (!response.ok) {
    return []; // Fallback to empty if transactions fail
  }
  const data = await response.json();
  return data.results || [];
}

module.exports = {
  verifyEtsyWebhookSignature,
  fetchChangedReceipts,
  refreshEtsyTokens,
  fetchEtsyApi,
};
