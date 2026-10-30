import { describe, it, expect } from "vitest";
import { listingStatus, statusDetail } from "$lib/amazon-listing-status";
import type { PreparationRow } from "$lib/amazon-preparation";
const row = (changes: any = {}): PreparationRow =>
  ({
    row: { title: "Notebook", key: "1", health: "Active", checkedAt: 100 },
    decision: {},
    reason: "",
    entry: { itemKey: "1", sku: "1", method: "PATCH", body: {} },
    ...changes,
  }) as PreparationRow;
describe("Amazon catalogue action categories", () => {
  it("excludes not-for-sale products even when eligible", () =>
    expect(
      listingStatus(row({ row: { title: "NOT FOR SALE Notebook" } }), 100),
    ).toBe("Excluded"));
  it("does not call an unvalidated update in sync", () =>
    expect(listingStatus(row(), 100)).toBe("Updates needed"));
  it("keeps shared barcode blockers visible", () =>
    expect(
      listingStatus(
        row({ reason: "Shared JAN: verify identity", entry: null }),
        100,
      ),
    ).toBe("Needs your input"));
  it("retains failures without a recent-time cutoff", () => {
    const r = row();
    r.job = {
      entry: r.entry,
      status: "blocked",
      error: "Image rejected",
      updatedAt: 1,
    };
    expect(listingStatus(r, 99999999)).toBe("Failed");
  });
  it("expires validation and requires another check", () => {
    const r = row();
    r.job = {
      entry: r.entry,
      status: "ready",
      updatedAt: 100,
      validation: { status: 200, data: { status: "VALID", issues: [] } },
    };
    expect(listingStatus(r, 200)).toBe("Ready to publish");
    expect(listingStatus(r, 1800200)).toBe("Updates needed");
  });
  it("does not reuse validation for changed payloads", () => {
    const r = row();
    r.job = {
      entry: { ...r.entry, body: { changed: true } },
      status: "ready",
      updatedAt: 100,
      validation: { status: 200, data: { status: "VALID" } },
    };
    expect(listingStatus(r, 200)).toBe("Updates needed");
  });
  it("keeps unverified submissions in progress", () =>
    expect(
      listingStatus(
        row({ job: { status: "submitted", submittedAt: 101 } }),
        200,
      ),
    ).toBe("In progress"));
  it("only marks matching supported fields in sync", () =>
    expect(
      listingStatus(
        row({ reason: "Price and stock already match Amazon.", entry: null }),
        200,
      ),
    ).toBe("In sync"));
});

it("separates zero stock and offer candidates from input problems", () => {
  expect(
    listingStatus(
      row({
        row: { title: "Paper", onHand: 0 },
        entry: null,
        reason: "No offer will be created.",
      }),
      100,
    ),
  ).toBe("Zero stock");
  expect(
    listingStatus(
      row({
        offerMatch: { candidates: [{ asin: "B012345678" }] },
        entry: null,
        reason: "Verify an ASIN",
      }),
      100,
    ),
  ).toBe("Add offers");
});

it("routes shared-JAN products to the supported GTIN-exempt family workflow", () => {
  const detail = statusDetail(
    row({
      row: { title: "Amifa stickers" },
      reason: "Shared JAN: verify identity",
      entry: null,
    }),
    100,
  );
  expect(detail).toContain("Create variant family with GTIN exemption");
  expect(detail).not.toContain("not supported");
});
