import { describe, it, expect } from "vitest";
import { deriveAverageCost, type CostLot } from "$lib/inventory";

// M2a — pure receipt-weighted moving-average fold.
// See docs/investigations/DESIGN_RECEIVED_INVENTORY_AND_MOVING_AVERAGE_COST.md
//
// SCOPE: this is receipt-weighted (lots only). Sale-interleaved
// perpetual COGS (which yields the owner's 86.11 example) is a
// SEPARATE pending milestone — see the explicit test below.

const lot = (
  receivedAt: number,
  qty: number,
  unitCost: number,
  source = "o",
  seq?: number,
): CostLot => ({ receivedAt, qty, unitCost, source, seq });

describe("deriveAverageCost (receipt-weighted fold)", () => {
  it("returns undefined for no lots", () => {
    expect(deriveAverageCost(undefined)).toBeUndefined();
    expect(deriveAverageCost([])).toBeUndefined();
  });

  it("bootstrap: a single lot establishes basis with no averaging", () => {
    expect(deriveAverageCost([lot(1, 10, 282.7)])).toBe(282.7);
  });

  it("blends subsequent lots qty-weighted (4902778028179Black)", () => {
    // Order1 ¥282.70 ×10, Order5 ¥243 ×10  ->  (10·282.7+10·243)/20
    expect(
      deriveAverageCost([lot(100, 10, 282.7), lot(200, 10, 243)]),
    ).toBeCloseTo(262.85, 6);
  });

  it("matches hand-computed values for the other flagged JANs", () => {
    // 4977564637699 Green: ¥385×20 (Ord3) + ¥201×40 (Ord5) -> 262.33…
    expect(deriveAverageCost([lot(1, 20, 385), lot(2, 40, 201)])).toBeCloseTo(
      15740 / 60,
      6,
    );
    // 4952270287321 Cat in Mug: ¥194×5 + ¥97×20 -> 116.4
    expect(deriveAverageCost([lot(1, 5, 194), lot(2, 20, 97)])).toBeCloseTo(
      116.4,
      6,
    );
  });

  it("is input-order independent but receivedAt-order dependent (temporal guarantee)", () => {
    const a = lot(100, 10, 282.7);
    const b = lot(200, 10, 243);
    // Same lots, array order shuffled -> identical (fold sorts by receivedAt)
    expect(deriveAverageCost([a, b])).toBe(deriveAverageCost([b, a]));
    // A *late-processed but earlier-received* lot changes the result to
    // the date-ordered fold (this is what makes "process last year's
    // order today, affect the past" correct).
    const withEarlyLot = deriveAverageCost([
      lot(200, 10, 243),
      lot(50, 5, 100), // received BEFORE the 282.7 lot, processed last
      lot(100, 10, 282.7),
    ]);
    // date order: (5@100) -> est 100; +(10@282.7) -> (5·100+10·282.7)/15
    // -> +(10@243) -> blend again
    let q = 5,
      avg = 100;
    avg = (q * avg + 10 * 282.7) / (q + 10);
    q += 10;
    avg = (q * avg + 10 * 243) / (q + 10);
    q += 10;
    expect(withEarlyLot).toBeCloseTo(avg, 6);
  });

  it("deterministic tiebreak when receivedAt collides (seq, then source)", () => {
    const r1 = deriveAverageCost([
      lot(100, 10, 300, "B", 2),
      lot(100, 10, 100, "A", 1),
    ]);
    const r2 = deriveAverageCost([
      lot(100, 10, 100, "A", 1),
      lot(100, 10, 300, "B", 2),
    ]);
    expect(r1).toBe(r2); // order-independent given seq
    // seq 1 (cost 100) establishes basis, then seq 2 blends:
    expect(r1).toBeCloseTo((10 * 100 + 10 * 300) / 20, 6);
  });

  it("ignores non-finite unit costs", () => {
    expect(deriveAverageCost([lot(1, 10, Number.NaN), lot(2, 5, 50)])).toBe(50);
  });

  it("DOCUMENTED LIMITATION: receipt-weighted ≠ sale-interleaved perpetual", () => {
    // Owner example: buy 10@100, SELL 2, buy 10@75.
    // True perpetual (sale-aware) = (8·100 + 10·75)/18 = 86.11…
    // M2a receipt-weighted (no sale modelling) = (10·100+10·75)/20 = 87.5.
    // The sale-aware milestone is pending owner sign-off; this test
    // pins the CURRENT (receipt-weighted) behaviour so the gap is
    // explicit, not silently wrong.
    expect(deriveAverageCost([lot(1, 10, 100), lot(2, 10, 75)])).toBe(87.5);
  });
});
