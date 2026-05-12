import { describe, expect, it } from "vitest";
import { getOrderDisplayStatus } from "$lib/inventory";

describe("getOrderDisplayStatus", () => {
  it("returns 'ok' for paid/completed/open orders", () => {
    expect(getOrderDisplayStatus({})).toBe("ok");
    expect(getOrderDisplayStatus({ status: "Paid" })).toBe("ok");
    expect(getOrderDisplayStatus({ status: "Completed" })).toBe("ok");
    expect(getOrderDisplayStatus({ status: "Open" })).toBe("ok");
  });

  it("flags Etsy's title-cased 'Canceled' as canceled (this was the bug)", () => {
    expect(getOrderDisplayStatus({ status: "Canceled" })).toBe("canceled");
    expect(getOrderDisplayStatus({ status: "Cancelled" })).toBe("canceled");
    expect(getOrderDisplayStatus({ status: "canceled" })).toBe("canceled");
    expect(getOrderDisplayStatus({ status: "  CANCELED  " })).toBe("canceled");
  });

  it("flags refund states", () => {
    expect(getOrderDisplayStatus({ status: "Fully Refunded" })).toBe(
      "refunded",
    );
    expect(getOrderDisplayStatus({ status: "fully_refunded" })).toBe(
      "refunded",
    );
    expect(getOrderDisplayStatus({ status: "Refunded" })).toBe("refunded");
    expect(getOrderDisplayStatus({ status: "Partially Refunded" })).toBe(
      "partial_refund",
    );
    expect(getOrderDisplayStatus({ status: "partially_refunded" })).toBe(
      "partial_refund",
    );
  });

  it("flags unpaid orders", () => {
    expect(getOrderDisplayStatus({ status: "Unpaid" })).toBe("unpaid");
    expect(getOrderDisplayStatus({ isPaid: false })).toBe("unpaid");
    expect(getOrderDisplayStatus({ status: "Paid", isPaid: true })).toBe("ok");
  });

  it("cancellation wins over unpaid when both apply", () => {
    // Etsy can return is_paid=false on a canceled receipt; the canceled
    // banner is more informative for the operator.
    expect(getOrderDisplayStatus({ status: "Canceled", isPaid: false })).toBe(
      "canceled",
    );
  });
});
