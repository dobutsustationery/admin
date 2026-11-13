import { describe, expect, it, vi } from "vitest";
vi.mock("firebase/firestore", () => {
  let id = 0;
  return {
    collection: (_db: unknown, name: string) => name,
    doc: (name: string) => ({ id: String(++id), name }),
    serverTimestamp: () => "server-time",
    writeBatch: () => ({ set: vi.fn(), commit: vi.fn(async () => {}) }),
  };
});
import { findAmazonOfferMatches } from "$lib/amazon-offer-requests";
describe("bulk supplier ASIN searches", () => {
  it("deduplicates barcodes and splits more than twenty into tracked server requests", async () => {
    const set = vi.fn(),
      commit = vi.fn(async () => {});
    vi.spyOn(await import("firebase/firestore"), "writeBatch").mockReturnValue({
      set,
      commit,
    } as any);
    const jans = Array.from({ length: 45 }, (_, i) =>
      String(4900000000000 + i),
    );
    const result = await findAmazonOfferMatches({} as any, "user", [
      ...jans,
      jans[0],
      "invalid",
    ]);
    expect(result.count).toBe(45);
    expect(result.requestIds).toHaveLength(3);
    expect(set.mock.calls.map((c) => c[1].jans.length)).toEqual([20, 20, 5]);
    expect(set.mock.calls.flatMap((c) => c[1].jans)).toEqual(jans);
    expect(
      set.mock.calls.every(
        (c) => c[1].includeSellerListings === false && c[1].creator === "user",
      ),
    ).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
  });
  it("doesn't enqueue an empty barcode search", async () => {
    await expect(
      findAmazonOfferMatches({} as any, "user", ["bad"]),
    ).rejects.toThrow("No valid JAN");
  });
});
