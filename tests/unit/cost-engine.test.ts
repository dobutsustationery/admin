import { describe, it, expect } from "vitest";
import {
  walkLedger,
  valueAt,
  totalValuation,
  UNKNOWN_RECEIPT_DATE,
  lotMatchesOrder,
  type LedgerEntry,
  type ReceiptEntry,
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

  it("skips ignored ledger entries", () => {
    const ignored = { ...r(2, 10, 0, 0, 1), ignored: true };
    expect(walkLedger([r(1, 10, 100, 1), ignored])).toEqual({
      onHand: 10,
      avgJpy: 100,
      avgEur: 1,
    });
  });

  it("does not apply ignored receipt adjustment rows", () => {
    const receipt = r(1, 20, 100, 1, 0) as ReceiptEntry;
    const adjustment: ReceiptEntry = {
      kind: "receipt",
      at: 1,
      seq: 0.001,
      qty: -10,
      unitCostJpy: 0,
      unitCostEur: 0,
      adjustmentEntry: true,
      adjustmentMode: "apply-to-target",
      adjustmentTarget: { at: receipt.at, seq: receipt.seq },
      ignored: true,
      ignoreReason: "mistaken qty correction",
    };

    expect(walkLedger([receipt, adjustment])).toEqual({
      onHand: 20,
      avgJpy: 100,
      avgEur: 1,
    });
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

  it("carries an oversold sale forward to the next receipt", () => {
    const w = walkLedger([s(1, 1), r(2, 10, 100, 1)]);
    expect(w.onHand).toBe(9);
    expect(w.avgJpy).toBe(100);
    expect(valueAt([s(1, 1), r(2, 10, 100, 1)]).valueJpy).toBe(900);
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

describe("archive zero-crossing carries the running average", () => {
  // sale-archive helper.
  const sa = (at: number, qty: number, seq = 0): LedgerEntry => ({
    kind: "sale",
    at,
    seq,
    qty,
    isArchive: true,
  });

  it("unpriced post-archive receipt inherits pre-archive JPY and EUR", () => {
    // Pre: receipt qty 2 @ ¥282 / €1.835 → avg = 282 / 1.835.
    // Archive sale 2 → on-hand 0 (carry set). Then unpriced recount qty 10.
    const w = walkLedger([r(1, 2, 282, 1.835), sa(2, 2, 1), r(3, 10, 0, 0, 2)]);
    expect(w.onHand).toBe(10);
    expect(w.avgJpy).toBeCloseTo(282, 6);
    expect(w.avgEur).toBeCloseTo(1.835, 6);
  });

  it("priced JPY but unpriced EUR: JPY wins, EUR derived via carried fx (the 4902778028216 shape)", () => {
    // Pre-archive: a single priced lot at JPY 282 / EUR 1.835.
    // Implicit fx = 1.835/282. Recount priced in JPY 243, EUR 0.
    // Derived EUR = 243 * 1.835 / 282.
    const w = walkLedger([
      r(1, 2, 282, 1.835),
      sa(2, 2, 1),
      r(3, 10, 243, 0, 2),
    ]);
    expect(w.onHand).toBe(10);
    expect(w.avgJpy).toBe(243);
    expect(w.avgEur).toBeCloseTo((243 * 1.835) / 282, 6);
  });

  it("fx ratio is dilution-invariant across pre-archive unpriced scan lots", () => {
    // The 4902778028216 reality: priced lot mixed with two unpriced
    // scan lots before the archive. avg ratio still equals priced fx.
    const w = walkLedger([
      r(1, 2, 282, 1.835), // priced (Order 1 cost-attach)
      r(1, 20, 0, 0, 1), // unpriced scan
      r(1, 2, 0, 0, 2), // unpriced scan
      sa(2, 24, 3), // archive
      r(3, 10, 243, 0, 4), // recount: JPY priced, EUR unpriced
    ]);
    expect(w.onHand).toBe(10);
    expect(w.avgJpy).toBe(243);
    // Pre-archive avgJpy = (2*282)/24 = 23.5, avgEur = (2*1.835)/24 = 0.1529;
    // ratio = 0.1529/23.5 = 0.006507; 243 * ratio = 1.581.
    expect(w.avgEur).toBeCloseTo((243 * 1.835) / 282, 6);
  });

  it("fully priced recount overrides the carry (no fictionalisation)", () => {
    const w = walkLedger([
      r(1, 2, 282, 1.835),
      sa(2, 2, 1),
      r(3, 10, 500, 3, 2),
    ]);
    expect(w.avgJpy).toBe(500);
    expect(w.avgEur).toBe(3);
  });

  it("a NON-archive zero-crossing does NOT carry (current behaviour preserved)", () => {
    // Identical shape but the sale is a normal sale: unpriced recount
    // zeros the average as before.
    const w = walkLedger([r(1, 2, 282, 1.835), s(2, 2, 1), r(3, 10, 0, 0, 2)]);
    expect(w.avgJpy).toBe(0);
    expect(w.avgEur).toBe(0);
  });

  it("carry is consumed by the first post-archive receipt; later receipts blend normally", () => {
    // Fully unpriced recount inherits BOTH carried averages (282 / 1.835).
    // A subsequent priced receipt then blends against those, not the carry.
    const w = walkLedger([
      r(1, 2, 282, 1.835),
      sa(2, 2, 1),
      r(3, 10, 0, 0, 2), // carry → avg 282 JPY, 1.835 EUR; on-hand 10
      r(4, 10, 100, 0.5, 3), // blend: (10*282 + 10*100)/20, (10*1.835 + 10*0.5)/20
    ]);
    expect(w.onHand).toBe(20);
    expect(w.avgJpy).toBe((10 * 282 + 10 * 100) / 20);
    expect(w.avgEur).toBeCloseTo((10 * 1.835 + 10 * 0.5) / 20, 6);
  });
});
