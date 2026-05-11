/**
 * Covers the access-token refresh path inside
 * functions/shared/etsy-order-logic.cjs.  The real reconcile poller calls
 * `fetchEtsyApi` for every receipts/transactions request; that helper
 * detects 401-with-expired-token responses, refreshes via the OAuth
 * token endpoint, and retries the original request.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const etsyLogic: any = require("../../functions/shared/etsy-order-logic.cjs");
const { fetchEtsyApi, refreshEtsyTokens } = etsyLogic;

const baseConfig = () => ({
  shopId: "55123790",
  apiKey: "key:appSecret",
  keystring: "key",
  keystringSharedSecret: "appSecret",
  accessToken: "stale.token",
  refreshToken: "refresh-1",
});

function jsonResponse(status: number, body: any) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Etsy token refresh", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshEtsyTokens posts grant_type=refresh_token and returns the new pair", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch" as any)
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "new.access",
          refresh_token: "new.refresh",
          expires_in: 3600,
        }),
      );

    const tokens = await refreshEtsyTokens(baseConfig());

    expect(tokens).toEqual({
      accessToken: "new.access",
      refreshToken: "new.refresh",
      expiresIn: 3600,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("https://api.etsy.com/v3/public/oauth/token");
    const body = String(init.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("client_id=key");
    expect(body).toContain("refresh_token=refresh-1");
    expect(body).toContain("client_secret=appSecret");
  });

  it("fetchEtsyApi refreshes once on 401 invalid_token and retries the original call", async () => {
    const config = baseConfig();
    const persisted: any[] = [];
    const onTokensRefreshed = async (t: any) => {
      persisted.push(t);
    };

    const fetchMock = vi
      .spyOn(globalThis, "fetch" as any)
      // 1. Original call returns expired-token 401.
      .mockResolvedValueOnce(
        jsonResponse(401, {
          error: "invalid_token",
          error_description: "access token is expired",
        }),
      )
      // 2. Refresh exchange.
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "fresh.access",
          refresh_token: "fresh.refresh",
          expires_in: 3600,
        }),
      )
      // 3. Retry with fresh token.
      .mockResolvedValueOnce(jsonResponse(200, { results: ["ok"] }));

    const resp = await fetchEtsyApi(
      config,
      "https://openapi.etsy.com/v3/application/shops/55123790/receipts",
      {},
      onTokensRefreshed,
    );

    expect(resp.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Config mutated to use the new pair.
    expect(config.accessToken).toBe("fresh.access");
    expect(config.refreshToken).toBe("fresh.refresh");

    // Persisted via the callback.
    expect(persisted).toEqual([
      {
        accessToken: "fresh.access",
        refreshToken: "fresh.refresh",
        expiresIn: 3600,
      },
    ]);

    // Retry used the new bearer header.
    const retryInit = (fetchMock.mock.calls[2] as any)[1];
    expect(retryInit.headers.Authorization).toBe("Bearer fresh.access");
  });

  it("fetchEtsyApi does NOT refresh when the 401 is not a token error", async () => {
    const config = baseConfig();
    const onTokensRefreshed = vi.fn();

    const fetchMock = vi
      .spyOn(globalThis, "fetch" as any)
      .mockResolvedValueOnce(
        jsonResponse(401, { error: "forbidden", error_description: "scope" }),
      );

    const resp = await fetchEtsyApi(
      config,
      "https://openapi.etsy.com/v3/application/shops/55123790/receipts",
      {},
      onTokensRefreshed,
    );

    expect(resp.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onTokensRefreshed).not.toHaveBeenCalled();
    // Original tokens untouched.
    expect(config.accessToken).toBe("stale.token");
    expect(config.refreshToken).toBe("refresh-1");
  });

  it("fetchEtsyApi does NOT refresh when no refresh token is configured", async () => {
    const config = { ...baseConfig(), refreshToken: "" };
    const onTokensRefreshed = vi.fn();

    const fetchMock = vi
      .spyOn(globalThis, "fetch" as any)
      .mockResolvedValueOnce(
        jsonResponse(401, {
          error: "invalid_token",
          error_description: "expired",
        }),
      );

    const resp = await fetchEtsyApi(
      config,
      "https://openapi.etsy.com/v3/application/shops/55123790/receipts",
      {},
      onTokensRefreshed,
    );

    expect(resp.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onTokensRefreshed).not.toHaveBeenCalled();
  });
});
