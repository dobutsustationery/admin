import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { verifyShopifyHmac } from "../../functions/shared/shopify-order-logic.cjs";

describe("Shopify HMAC Verification", () => {
  const secret = "test_secret";
  const payload = JSON.stringify({ id: 12345, email: "test@example.com" });
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64");

  it("should verify valid HMAC", () => {
    expect(verifyShopifyHmac(payload, hmac, secret)).toBe(true);
  });

  it("should fail for invalid HMAC", () => {
    expect(verifyShopifyHmac(payload, "invalid_hmac", secret)).toBe(false);
  });

  it("should fail for invalid secret", () => {
    expect(verifyShopifyHmac(payload, hmac, "wrong_secret")).toBe(false);
  });

  it("should fail for modified payload", () => {
    expect(verifyShopifyHmac(payload + " ", hmac, secret)).toBe(false);
  });

  it("should handle missing hmac or secret", () => {
    expect(verifyShopifyHmac(payload, "", secret)).toBe(false);
    expect(verifyShopifyHmac(payload, hmac, "")).toBe(false);
  });

  it("should handle Buffer payload", () => {
    const bufferPayload = Buffer.from(payload);
    expect(verifyShopifyHmac(bufferPayload, hmac, secret)).toBe(true);
  });
});
