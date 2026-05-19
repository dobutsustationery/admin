import { describe, it, expect } from "vitest";
import {
  walkLedger,
  valueAt,
  totalValuation,
  UNKNOWN_RECEIPT_DATE,
  lotMatchesOrder,
  type LedgerEntry,
} from "$lib/cost-engine";

// See docs/investigations/DESIGN_INVENTORY_COST_AND_VALUATION.md

const r = (
  at: number,
  qty: number,
  jpy: number,
  eur: number,
  seq = 0,
): LedgerEntry => ({
  kind: "receipt",
  at,
  seq,
  qty,
  unitCostJpy: jpy,
  unitCostEur: eur,
});
const s = (at: number, qty: number, seq = 0): LedgerEntry => ({
  kind: "sale",
  at,
  seq,
  qty,
});

describe("cost-engine", () => {
  it("empty ledger -> zeros", () => {
    expect(walkLedger([])).toEqual({ onHand: 0, avgJpy: 0, avgEur: 0 });
  });

  it("single receipt bootstraps the average", () => {
    expect(walkLedger([r(1, 10, 282.7, 2.1)])).toEqual({
      onHand: 10,
      avgJpy: 282.7,
      avgEur: 2.1,
    });
  });

  it("blends receipts qty-weighted, JPY and EUR independently", () => {
    const w = walkLedger([r(1, 10, 100, 0.8), r(2, 10, 75, 0.6)]);
    expect(w.onHand).toBe(20);
    expect(w.avgJpy).toBeCloseTo((10 * 100 + 10 * 75) / 20, 9); // 87.5
    expect(w.avgEur).toBeCloseTo((10 * 0.8 + 10 * 0.6) / 20, 9); // 0.7
  });

  it("a sale reduces on-hand and leaves the average unchanged", () => {
    const w = walkLedger([r(1, 10, 100, 1), s(2, 4)]);
    expect(w).toEqual({ onHand: 6, avgJpy: 100, avgEur: 1 });
  });

  it("ORDER MATTERS: sale before a re-order blends against reduced on-hand", () => {
    // sale-then-reorder: 10@100, sell 8, +10@75 -> (2*100+10*75)/12
    const interleaved = walkLedger([
      r(1, 10, 100, 1),
      s(2, 8),
      r(3, 10, 75, 0.7),
    ]);
    expect(interleaved.onHand).toBe(12);
    expect(interleaved.avgJpy).toBeCloseTo((2 * 100 + 10 * 75) / 12, 9); // 79.166…

    // reorder-then-sale: both receipts first -> 87.5, then sell 8
    const grouped = walkLedger([r(1, 10, 100, 1), r(2, 10, 75, 0.7), s(3, 8)]);
    expect(grouped.onHand).toBe(12);
    expect(grouped.avgJpy).toBeCloseTo(87.5, 9);

    expect(interleaved.avgJpy).not.toBeCloseTo(grouped.avgJpy, 5);
  });

  it("as-of truncation: only entries dated <= asOf are folded", () => {
    const led = [r(100, 10, 100, 1), s(200, 5), r(300, 10, 50, 0.5)];
    expect(walkLedger(led, 50)).toEqual({ onHand: 0, avgJpy: 0, avgEur: 0 });
    expect(walkLedger(led, 100)).toEqual({
      onHand: 10,
      avgJpy: 100,
      avgEur: 1,
    });
    expect(walkLedger(led, 250)).toEqual({ onHand: 5, avgJpy: 100, avgEur: 1 });
    const all = walkLedger(led, 300);
    expect(all.onHand).toBe(15);
    expect(all.avgJpy).toBeCloseTo((5 * 100 + 10 * 50) / 15, 9);
  });

  it("is input-order independent given (at, seq)", () => {
    const a = r(100, 10, 100, 1, 0);
    const b = r(100, 5, 200, 2, 1); // same date, later seq
    expect(walkLedger([a, b])).toEqual(walkLedger([b, a]));
    // seq 0 establishes basis, seq 1 blends
    const w = walkLedger([b, a]);
    expect(w.avgJpy).toBeCloseTo((10 * 100 + 5 * 200) / 15, 9);
  });

  it("a sale cannot drive on-hand negative (oversell clamps at 0)", () => {
    const w = walkLedger([r(1, 5, 100, 1), s(2, 9)]);
    expect(w.onHand).toBe(0);
    expect(w.avgJpy).toBe(100);
  });

  it("valueAt = on-hand × average; totalValuation sums items", () => {
    const itemA = [r(1, 10, 100, 1)];
    const itemB = [r(1, 4, 50, 0.4), s(2, 1)];
    const va = valueAt(itemA);
    expect(va.valueJpy).toBe(1000);
    expect(va.valueEur).toBe(10);
    const t = totalValuation([itemA, itemB]);
    expect(t.valueJpy).toBe(1000 + 3 * 50);
    expect(t.valueEur).toBeCloseTo(10 + 3 * 0.4, 9);
  });

  it("UNKNOWN_RECEIPT_DATE is a normal date the engine does not special-case", () => {
    expect(UNKNOWN_RECEIPT_DATE).toBe(Date.UTC(2026, 0, 1));
    const w = walkLedger([
      r(UNKNOWN_RECEIPT_DATE, 10, 100, 1),
      r(UNKNOWN_RECEIPT_DATE + 1000, 10, 200, 2, 1),
    ]);
    expect(w.onHand).toBe(20);
    expect(w.avgJpy).toBeCloseTo(150, 9);
  });
});

describe("lotMatchesOrder", () => {
  const rc = (over: Partial<any> = {}): LedgerEntry =>
    ({
      kind: "receipt",
      at: 1,
      seq: 0,
      qty: 1,
      unitCostJpy: 0,
      unitCostEur: 0,
      ...over,
    }) as any;

  it("matches a receipt the order created (source-tagged)", () => {
    expect(lotMatchesOrder(rc({ source: "stockOrder:O1" }), "O1")).toBe(true);
    expect(lotMatchesOrder(rc({ source: "stockOrder:O1" }), "O2")).toBe(false);
  });

  it("matches a scan lot whose cost a zeroed order supplied (costOrderId)", () => {
    const e = rc({ source: "update_item", costOrderId: "O1" });
    expect(lotMatchesOrder(e, "O1")).toBe(true); // scan-sourced but cost from O1
    expect(lotMatchesOrder(e, "O2")).toBe(false);
  });

  it("never matches a sale entry", () => {
    expect(
      lotMatchesOrder({ kind: "sale", at: 1, seq: 0, qty: 1 } as any, "O1"),
    ).toBe(false);
  });
});
