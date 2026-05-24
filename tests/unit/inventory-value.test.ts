import { describe, expect, it } from "vitest";

import {
  buildInventoryValueReport,
  inventoryValueTsv,
} from "$lib/inventory-value";

const D = (s: string) => Date.parse(s + "T00:00:00Z");

function inv(costLedger: any, stockOrderRegistry: any = {}) {
  return { costLedger, stockOrderRegistry } as any;
}

describe("buildInventoryValueReport", () => {
  it("returns [] when there is no ledger activity", () => {
    expect(buildInventoryValueReport(inv({}), D("2025-04-15"))).toEqual([]);
  });

  it("values inventory at each period end, stock order, and now", () => {
    const ledger = {
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
    const ledger = {
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
