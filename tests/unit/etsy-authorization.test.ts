import { describe, expect, it, vi } from "vitest";
const {
  saveEtsyAuthorization,
} = require("../../functions/shared/etsy-authorization.cjs");
describe("Etsy reauthorization", () => {
  it("replaces worker credentials without resetting the receipt cursor", async () => {
    let state: any = { lastReceiptModifiedTimestamp: 123, accessToken: "old" };
    const set = vi.fn(async (value, options) => {
      expect(options).toEqual({ merge: true });
      state = { ...state, ...value };
    });
    const db = { collection: () => ({ doc: () => ({ set }) }) };
    await saveEtsyAuthorization(
      db,
      {
        access_token: "new",
        refresh_token: "refresh",
        scope: "listings_r listings_w",
      },
      42,
    );
    expect(state.lastReceiptModifiedTimestamp).toBe(123);
    expect(state.accessToken).toBe("new");
    expect(state.grantedScopes).toEqual(["listings_r", "listings_w"]);
    expect(state.canWrite).toBe(true);
  });
});
