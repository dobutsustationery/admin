import { describe, it, expect } from "vitest";
import {
  walkLedger,
  valueAt,
  totalValuation,
  archiveSweepDivergences,
  ledgerOversold,
  orderIdFromSaleId,
  zeroCostBlendWarnings,
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
const recount = (
  at: number,
  qty: number,
  jpy: number,
  eur: number,
  seq = 0,
): LedgerEntry => ({
  ...(r(at, qty, jpy, eur, seq) as ReceiptEntry),
  receivedQty: 0,
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
    const w = walkLedger([
      r(1, 2, 282, 1.835),
      sa(2, 2, 1),
      recount(3, 10, 0, 0, 2),
    ]);
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
      recount(3, 10, 243, 0, 2),
    ]);
    expect(w.onHand).toBe(10);
    expect(w.avgJpy).toBe(243);
    expect(w.avgEur).toBeCloseTo((243 * 1.835) / 282, 6);
  });

  it("archive recount carries the surviving FIFO lot cost, not the diluted blend", () => {
    // The Japan Festival archive/recount is a stocktake transition:
    // infer shrinkage from the recount, consume oldest lots first, and
    // carry the cost of the lots that survived into the recount.
    const w = walkLedger([
      r(1, 6, 0, 0),
      r(2, 16, 65, 0.385, 1),
      sa(3, 22, 2),
      recount(4, 15, 0, 0, 3),
    ]);
    expect(w.onHand).toBe(15);
    expect(w.avgJpy).toBe(65);
    expect(w.avgEur).toBeCloseTo(0.385, 6);
  });

  it("fully priced recount overrides the carry (no fictionalisation)", () => {
    const w = walkLedger([
      r(1, 2, 282, 1.835),
      sa(2, 2, 1),
      recount(3, 10, 500, 3, 2),
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
      recount(3, 10, 0, 0, 2), // carry → avg 282 JPY, 1.835 EUR; on-hand 10
      r(4, 10, 100, 0.5, 3), // blend: (10*282 + 10*100)/20, (10*1.835 + 10*0.5)/20
    ]);
    expect(w.onHand).toBe(20);
    expect(w.avgJpy).toBe((10 * 282 + 10 * 100) / 20);
    expect(w.avgEur).toBeCloseTo((10 * 1.835 + 10 * 0.5) / 20, 6);
  });

  it("sweeps ALL on-hand even when the recorded archive qty is stale and too low", () => {
    // The 4902778185650 shape: 20 received, 7 sold, then an archive whose
    // recorded qty (3) is a snapshot from before a later audit action restored
    // 10 units. The archive must still sweep the full re-derived on-hand (13)
    // to zero rather than only the stale recorded 3.
    const w = walkLedger([
      r(1, 20, 282.7, 1.836),
      s(2, 7, 1),
      sa(3, 3, 2), // recorded 3, but on-hand here is 13
    ]);
    expect(w.onHand).toBe(0);
  });
});

describe("archiveSweepDivergences", () => {
  const sa = (at: number, qty: number, seq = 0, id?: string): LedgerEntry => ({
    kind: "sale",
    at,
    seq,
    qty,
    isArchive: true,
    id,
  });

  it("reports nothing when the recorded archive qty matches the swept qty", () => {
    const out = archiveSweepDivergences([
      r(1, 20, 282.7, 1.836),
      s(2, 7, 1),
      sa(3, 13, 2), // on-hand at archive is 13, recorded 13
    ]);
    expect(out).toEqual([]);
  });

  it("reports the divergence when an audit action changed pre-archive on-hand", () => {
    const out = archiveSweepDivergences([
      r(1, 20, 282.7, 1.836),
      s(2, 7, 1),
      sa(3, 3, 2, "archive-1"), // recorded 3, but on-hand is 13
    ]);
    expect(out).toEqual([
      { id: "archive-1", at: 3, seq: 2, recordedQty: 3, sweptQty: 13 },
    ]);
  });

  it("ignores ignored archive rows", () => {
    const out = archiveSweepDivergences([
      r(1, 20, 282.7, 1.836),
      s(2, 7, 1),
      { kind: "sale", at: 3, seq: 2, qty: 3, isArchive: true, ignored: true },
    ]);
    expect(out).toEqual([]);
  });
});

describe("ledgerOversold", () => {
  const saleFrom = (
    at: number,
    qty: number,
    seq: number,
    orderId: string,
  ): LedgerEntry => ({
    kind: "sale",
    at,
    seq,
    qty,
    id: `ledger:sale:KEY:act${seq}:package_item:${encodeURIComponent(orderId)}:${at}:${qty}`,
  });

  it("returns null when sales never exceed receipts", () => {
    expect(ledgerOversold([r(1, 10, 100, 1), s(2, 9, 1)])).toBeNull();
  });

  it("returns null for a transient deficit a later receipt covers", () => {
    // Oversold mid-stream, then restocked: net on-hand is non-negative.
    expect(
      ledgerOversold([r(1, 5, 100, 1), s(2, 8, 1), r(3, 10, 100, 2)]),
    ).toBeNull();
  });

  it("reports the net oversold quantity and the offending order", () => {
    // 10 received; one event sells 9 (leaves 1), a later event sells 8.
    const out = ledgerOversold([
      r(1, 10, 145, 0.82),
      saleFrom(2, 9, 1, "live-event:japan-festival:AAA"),
      saleFrom(
        4,
        8,
        2,
        "live-event:thessaloniki-comic-con:3FxZC2TXnuSvFfe11nt3",
      ),
    ]);
    expect(out).not.toBeNull();
    expect(out!.oversoldQty).toBe(7);
    expect(out!.firstNegativeAt).toBe(4);
    expect(out!.offendingOrders).toEqual([
      "live-event:thessaloniki-comic-con:3FxZC2TXnuSvFfe11nt3",
    ]);
  });

  it("does not flag a fully-sold loose-piece item (qty balances; visibleQty is pieces)", () => {
    // 4 packs received; sold as loose pieces. Cost-ledger qty is the
    // pack-fraction (1 piece = 1/22), summing to exactly 4; visibleQty is the
    // piece count (88) and must not be balanced against pack-unit receipts.
    const loosePiece = (
      at: number,
      pieces: number,
      seq: number,
    ): LedgerEntry => ({
      kind: "sale",
      at,
      seq,
      qty: pieces / 22,
      visibleQty: pieces,
    });
    const ledger: LedgerEntry[] = [
      r(1, 4, 0, 0),
      loosePiece(2, 44, 1),
      loosePiece(3, 44, 2),
    ];
    expect(ledgerOversold(ledger)).toBeNull();
  });

  it("does not flag an item that still has visible stock, even if the cost balance is negative", () => {
    // An archive that sweeps a post-dated receipt can drive the cost balance
    // negative while real stock remains. Positive visible on-hand wins.
    const ledger: LedgerEntry[] = [
      r(1, 10, 100, 1, 0),
      { kind: "sale", at: 2, seq: 1, qty: 20, isArchive: true, id: "a" }, // over-swept
      r(3, 10, 100, 1, 2),
    ];
    // qty walk: 10 - 20 + 10 = 0 cost; visible walk clamps 10 -> 0 -> 10 = 10
    // on hand, so the item is not oversold.
    expect(ledgerOversold(ledger)).toBeNull();
  });

  it("does not flag a loose-piece item whose same-day sales sort before the receipt, then archive", () => {
    // 7 packs received; two same-day loose-piece sales sort ahead of the
    // receipt (lower seq), then an archive sweeps the remainder. The cost
    // sweep must carry the leading deficit into the receipt (sweep 6.7), so
    // the item nets to exactly 0 and is not flagged. (A mid-walk clamp would
    // sweep 6.9 and surface a phantom 0.2 oversold.)
    const ledger: LedgerEntry[] = [
      { kind: "sale", at: 1, seq: 0, qty: 0.1, visibleQty: 1, id: "s0" },
      { kind: "sale", at: 1, seq: 1, qty: 0.2, visibleQty: 2, id: "s1" },
      r(1, 7, 0, 0, 2),
      {
        kind: "sale",
        at: 2,
        seq: 3,
        qty: 6.7,
        visibleQty: 4,
        isArchive: true,
        id: "a",
      },
    ];
    expect(ledgerOversold(ledger)).toBeNull();
  });

  it("orderIdFromSaleId decodes the package_item order segment", () => {
    expect(
      orderIdFromSaleId(
        "ledger:sale:KEY:abc:package_item:live-event%3Athessaloniki%3AXYZ:123:8",
      ),
    ).toBe("live-event:thessaloniki:XYZ");
    expect(
      orderIdFromSaleId("ledger:sale:KEY:abc:archive_inventory:KEY:1:2"),
    ).toBe(undefined);
  });
});

describe("zeroCostBlendWarnings", () => {
  const sa = (at: number, qty: number, seq = 0): LedgerEntry => ({
    kind: "sale",
    at,
    seq,
    qty,
    isArchive: true,
  });

  it("flags a ¥0 receipt diluting priced on-hand as zero-incoming (still blends)", () => {
    const entries = [r(1, 10, 100, 1), r(2, 5, 0, 0, 1)];
    const w = zeroCostBlendWarnings(entries);
    expect(w.length).toBe(1);
    expect(w[0]).toMatchObject({
      existingQty: 10,
      existingAvgJpy: 100,
      receiptQty: 5,
      receiptUnitJpy: 0,
      kind: "zero-incoming",
    });
    // This case should never happen, but if it does we keep the old dilution.
    expect(walkLedger(entries).avgJpy).toBeCloseTo((10 * 100) / 15);
  });

  it("re-prices uncosted on-hand to a priced receipt without averaging", () => {
    const entries = [r(1, 5, 0, 0), r(2, 10, 100, 1, 1)];
    const w = zeroCostBlendWarnings(entries);
    expect(w.length).toBe(1);
    expect(w[0]).toMatchObject({
      existingAvgJpy: 0,
      receiptUnitJpy: 100,
      kind: "uncosted-onhand",
    });
    // All 15 units adopt the incoming ¥100 cost, not the diluted ¥66.67.
    const state = walkLedger(entries);
    expect(state.onHand).toBe(15);
    expect(state.avgJpy).toBe(100);
    expect(state.avgEur).toBe(1);
  });

  it("does not warn when both lots are priced", () => {
    expect(
      zeroCostBlendWarnings([r(1, 10, 100, 1), r(2, 5, 80, 0.5, 1)]),
    ).toEqual([]);
  });

  it("does not warn on the first receipt establishing the basis (no blend)", () => {
    expect(zeroCostBlendWarnings([r(1, 5, 0, 0)])).toEqual([]);
    expect(zeroCostBlendWarnings([r(1, 5, 100, 1)])).toEqual([]);
  });

  it("does not warn for a carry-rescued post-archive recount", () => {
    // ¥0 recount after an archive inherits the pre-archive average via carry,
    // and on-hand is 0 at that point, so it establishes a basis, not a blend.
    const w = zeroCostBlendWarnings([
      r(1, 2, 282, 1.835),
      sa(2, 2, 1),
      recount(3, 10, 0, 0, 2),
    ]);
    expect(w).toEqual([]);
  });
});
