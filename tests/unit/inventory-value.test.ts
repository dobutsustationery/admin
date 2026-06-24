import { describe, expect, it } from "vitest";

import {
  buildInventoryValueReport,
  inventoryValueTsv,
  totalCumulativeValues,
} from "$lib/inventory-value";
import type { LedgerEntry } from "$lib/cost-engine";

const D = (s: string) => Date.parse(s + "T00:00:00Z");

function inv(costLedger: any, stockOrderRegistry: any = {}) {
  return { costLedger, stockOrderRegistry } as any;
}

describe("buildInventoryValueReport", () => {
  it("returns [] when there is no ledger activity", () => {
    expect(buildInventoryValueReport(inv({}), D("2025-04-15"))).toEqual([]);
  });

  it("values inventory at each period end, stock order, and now", () => {
    const ledger: Record<string, LedgerEntry[]> = {
      A: [
        {
          kind: "receipt",
          at: D("2025-01-15"),
          seq: 0,
          qty: 10,
          unitCostJpy: 100,
          unitCostEur: 1,
        },
        { kind: "sale", at: D("2025-03-05"), seq: 1, qty: 4 },
      ],
    };
    const registry = {
      o1: { name: "Kanegen #1", receivedAt: D("2025-02-10") },
      // No real date -> excluded.
      o2: { name: "Bad", receivedAt: 0 },
    };
    const rows = buildInventoryValueReport(
      inv(ledger, registry),
      D("2025-04-15"),
    );

    expect(rows.map((r) => [r.dateIso, r.kind])).toEqual([
      ["2025-01-31", "month-end"],
      ["2025-02-10", "stock-order"],
      ["2025-02-28", "month-end"],
      ["2025-03-31", "quarter-end"],
      ["2025-04-15", "current"],
    ]);

    // Before the sale: 10 @ ¥100 / €1.
    expect(rows[0].valueJpy).toBe(1000);
    expect(rows[0].valueEur).toBe(10);
    expect(rows[1].valueJpy).toBe(1000);
    // After the Mar-05 sale of 4: 6 on hand.
    expect(rows[3].valueJpy).toBe(600);
    expect(rows[3].valueEur).toBe(6);
    expect(rows[3].cumulativeInventoryValueJpy).toBe(1000);
    expect(rows[3].cumulativeInventoryValueEur).toBe(10);
    expect(rows[3].cumulativeSoldValueJpy).toBe(400);
    expect(rows[3].cumulativeSoldValueEur).toBe(4);
    expect(rows[4].valueJpy).toBe(600); // current
  });

  it("does not emit period rows beyond max(activity, now)", () => {
    const ledger: Record<string, LedgerEntry[]> = {
      A: [
        {
          kind: "receipt",
          at: D("2025-01-10"),
          seq: 0,
          qty: 1,
          unitCostJpy: 50,
          unitCostEur: 0.5,
        },
      ],
    };
    const rows = buildInventoryValueReport(inv(ledger), D("2025-02-05"));
    // Jan-31 month end + current (Feb-05). Feb-28 is beyond `now`.
    expect(rows.map((r) => r.dateIso)).toEqual(["2025-01-31", "2025-02-05"]);
  });

  it("nets restored sale quantities out of cumulative sold value", () => {
    const ledger = {
      A: [
        {
          kind: "receipt",
          at: D("2025-01-10"),
          seq: 0,
          qty: 10,
          unitCostJpy: 100,
          unitCostEur: 1,
        },
        { kind: "sale", at: D("2025-01-15"), seq: 1, qty: 4 },
        { kind: "sale", at: D("2025-01-20"), seq: 2, qty: -1 },
      ],
    };
    const rows = buildInventoryValueReport(inv(ledger), D("2025-01-31"));
    const current = rows.at(-1)!;

    expect(current.valueJpy).toBe(700);
    expect(current.cumulativeInventoryValueJpy).toBe(1000);
    expect(current.cumulativeSoldValueJpy).toBe(300);
  });

  it("values early sales against the next receipt once stock arrives", () => {
    const ledger: Record<string, LedgerEntry[]> = {
      A: [
        { kind: "sale", at: D("2025-01-05"), seq: 0, qty: 1 },
        {
          kind: "receipt",
          at: D("2025-01-10"),
          seq: 1,
          qty: 10,
          unitCostJpy: 100,
          unitCostEur: 1,
        },
      ],
    };

    expect(
      totalCumulativeValues(Object.values(ledger), D("2025-01-06")),
    ).toEqual({
      inventoryJpy: 0,
      inventoryEur: 0,
      soldJpy: 0,
      soldEur: 0,
    });

    expect(
      totalCumulativeValues(Object.values(ledger), D("2025-01-11")),
    ).toEqual({
      inventoryJpy: 1000,
      inventoryEur: 10,
      soldJpy: 100,
      soldEur: 1,
    });
  });

  it("does not count recount receipts as cumulative inventory value increases", () => {
    const ledger: Record<string, LedgerEntry[]> = {
      A: [
        {
          kind: "receipt",
          at: D("2025-01-10"),
          seq: 0,
          qty: 2,
          unitCostJpy: 100,
          unitCostEur: 1,
        },
        { kind: "sale", at: D("2025-01-20"), seq: 1, qty: 2, isArchive: true },
        {
          kind: "receipt",
          at: D("2025-01-25"),
          seq: 2,
          qty: 2,
          receivedQty: 0,
          unitCostJpy: 0,
          unitCostEur: 0,
        },
      ],
    };

    const rows = buildInventoryValueReport(inv(ledger), D("2025-01-31"));
    const current = rows.at(-1)!;
    const cumulative = totalCumulativeValues(
      Object.values(ledger),
      D("2025-01-31"),
    );

    expect(current.valueJpy).toBe(200);
    expect(current.cumulativeInventoryValueJpy).toBe(200);
    expect(current.cumulativeSoldValueJpy).toBe(0);
    expect(cumulative.inventoryJpy).toBe(200);
  });

  it("does not count repricing existing zero-cost on-hand as newly received inventory value", () => {
    const ledger: Record<string, LedgerEntry[]> = {
      A: [
        {
          kind: "receipt",
          at: D("2024-01-10"),
          seq: 0,
          qty: 4,
          unitCostJpy: 0,
          unitCostEur: 0,
        },
        {
          kind: "receipt",
          at: D("2024-07-02"),
          seq: 1,
          qty: 4,
          unitCostJpy: 65,
          unitCostEur: 0.4,
        },
      ],
    };
    const rows = buildInventoryValueReport(inv(ledger), D("2024-07-02"));
    const current = rows.at(-1)!;
    const cumulative = totalCumulativeValues(
      Object.values(ledger),
      D("2024-07-02"),
    );

    expect(current.valueJpy).toBe(520);
    expect(current.cumulativeInventoryValueJpy).toBe(260);
    expect(current.cumulativeSoldValueJpy).toBe(0);
    expect(cumulative.inventoryJpy).toBe(260);
  });

  it("accounts stocktake recount value decreases as sold inventory value", () => {
    const ledger: Record<string, LedgerEntry[]> = {
      A: [
        {
          kind: "receipt",
          at: D("2025-01-01"),
          seq: 0,
          qty: 4,
          unitCostJpy: 100,
          unitCostEur: 1,
        },
        { kind: "sale", at: D("2025-01-02"), seq: 1, qty: 3 },
        {
          kind: "receipt",
          at: D("2025-01-03"),
          seq: 2,
          qty: 10,
          unitCostJpy: 50,
          unitCostEur: 0.5,
        },
        { kind: "sale", at: D("2025-01-04"), seq: 3, qty: 1 },
        {
          kind: "sale",
          at: D("2025-01-05"),
          seq: 4,
          qty: 10,
          isArchive: true,
        },
        {
          kind: "receipt",
          at: D("2025-01-06"),
          seq: 5,
          qty: 10,
          receivedQty: 0,
          unitCostJpy: 0,
          unitCostEur: 0,
        },
      ],
    };

    const rows = buildInventoryValueReport(inv(ledger), D("2025-01-31"));
    const current = rows.at(-1)!;
    const cumulative = totalCumulativeValues(
      Object.values(ledger),
      D("2025-01-31"),
    );

    expect(current.valueJpy).toBe(500);
    expect(current.cumulativeInventoryValueJpy).toBe(900);
    expect(current.cumulativeSoldValueJpy).toBe(400);
    expect(current.valueJpy + current.cumulativeSoldValueJpy).toBe(
      current.cumulativeInventoryValueJpy,
    );
    expect(cumulative.inventoryJpy).toBe(900);
    expect(cumulative.soldJpy).toBeCloseTo(400);
  });

  it("keeps restored zero-cost lots at zero for FIFO sold-value accounting", () => {
    const ledger: Record<string, LedgerEntry[]> = {
      A: [
        {
          kind: "receipt",
          at: D("2023-11-12"),
          seq: 0,
          qty: 3,
          unitCostJpy: 0,
          unitCostEur: 0,
        },
        {
          kind: "receipt",
          at: D("2024-10-09"),
          seq: 1,
          qty: 16,
          unitCostJpy: 65,
          unitCostEur: 0.4,
        },
        { kind: "sale", at: D("2024-10-26"), seq: 2, qty: 1 },
        { kind: "sale", at: D("2024-10-26"), seq: 3, qty: -1 },
        { kind: "sale", at: D("2024-10-26"), seq: 4, qty: 1 },
        { kind: "sale", at: D("2024-10-26"), seq: 5, qty: 1 },
        { kind: "sale", at: D("2024-10-26"), seq: 6, qty: 1 },
        { kind: "sale", at: D("2024-10-26"), seq: 7, qty: 1 },
        {
          kind: "sale",
          at: D("2025-05-02"),
          seq: 8,
          qty: 15,
          isArchive: true,
        },
        {
          kind: "receipt",
          at: D("2025-05-05"),
          seq: 9,
          qty: 13,
          receivedQty: 0,
          unitCostJpy: 0,
          unitCostEur: 0,
        },
      ],
    };

    const rows = buildInventoryValueReport(inv(ledger), D("2025-05-31"));
    const current = rows.at(-1)!;
    const cumulative = totalCumulativeValues(
      Object.values(ledger),
      D("2025-05-31"),
    );

    expect(current.valueJpy).toBe(845);
    expect(current.cumulativeInventoryValueJpy).toBe(1040);
    expect(current.cumulativeSoldValueJpy).toBe(195);
    expect(
      current.cumulativeInventoryValueJpy -
        current.valueJpy -
        current.cumulativeSoldValueJpy,
    ).toBe(0);
    expect(cumulative.soldJpy).toBe(195);
  });

  it("balances normal post-restock sales with weighted-average inventory value", () => {
    const ledger: Record<string, LedgerEntry[]> = {
      A: [
        {
          kind: "receipt",
          at: D("2024-10-08"),
          seq: 0,
          qty: 6,
          unitCostJpy: 65,
          unitCostEur: 0.4,
        },
        {
          kind: "sale",
          at: D("2025-05-02"),
          seq: 1,
          qty: 6,
          isArchive: true,
        },
        {
          kind: "receipt",
          at: D("2025-05-04"),
          seq: 2,
          qty: 1,
          receivedQty: 0,
          unitCostJpy: 0,
          unitCostEur: 0,
        },
        {
          kind: "receipt",
          at: D("2025-09-25"),
          seq: 3,
          qty: 12,
          unitCostJpy: 62,
          unitCostEur: 0.38,
        },
        { kind: "sale", at: D("2025-11-23"), seq: 4, qty: 1 },
      ],
    };

    const rows = buildInventoryValueReport(inv(ledger), D("2025-11-30"));
    const current = rows.at(-1)!;
    const residual =
      current.cumulativeInventoryValueJpy -
      current.valueJpy -
      current.cumulativeSoldValueJpy;

    expect(current.cumulativeInventoryValueJpy).toBe(1134);
    expect(residual).toBeCloseTo(0, 6);
  });

  it("exports a TSV with header and one line per row", () => {
    const ledger = {
      A: [
        {
          kind: "receipt",
          at: D("2025-01-10"),
          seq: 0,
          qty: 2,
          unitCostJpy: 100,
          unitCostEur: 1.5,
        },
      ],
    };
    const rows = buildInventoryValueReport(inv(ledger), D("2025-02-15"));
    const tsv = inventoryValueTsv(rows);
    const lines = tsv.split("\n");
    expect(lines[0]).toBe(
      [
        "Date",
        "Type",
        "Event",
        "Value (EUR)",
        "Value (JPY)",
        "Cumulative Inventory Value (EUR)",
        "Cumulative Inventory Value (JPY)",
        "Cumulative Sold Inventory Value (EUR)",
        "Cumulative Sold Inventory Value (JPY)",
      ].join("\t"),
    );
    expect(lines.length).toBe(rows.length + 1);
    expect(lines[1]).toBe(
      "2025-01-31\tMonth end\tMonth end 2025-01-31\t3.00\t200\t3.00\t200\t0.00\t0",
    );
    expect(lines[2]).toBe(
      "2025-02-15\tCurrent\tCurrent\t3.00\t200\t3.00\t200\t0.00\t0",
    );
  });
});
