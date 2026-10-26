import { it, expect } from "vitest";
import fixture from "../fixtures/customs-senshu.json";
import { reduceCustoms } from "../../src/lib/customs-summary-slice";
function parse(input: any = structuredClone(fixture)) {
  let state: any;
  for (const action of [
    { type: "customs/created", payload: { reportId: "senshu", name: "Test" } },
    {
      type: "customs/sourceChunk",
      payload: {
        reportId: "senshu",
        readId: "r",
        index: 0,
        json: JSON.stringify(input),
      },
    },
    {
      type: "customs/sourceReceived",
      payload: { reportId: "senshu", readId: "r", chunks: 1 },
    },
  ])
    state = reduceCustoms(state, action, {});
  return state.reports.senshu.projection;
}
it("reads two-row Senshu headers, piece quantities and inline invoice number", () => {
  const p = parse();
  expect(p.invoice).toBe("101626-2 DHL");
  expect(p.products).toHaveLength(2);
  expect(p.products[0]).toMatchObject({
    qty: 24,
    price: 72,
    grams: 19.5,
    material: "STEEL/ABS",
    origin: "China",
  });
  expect(p.allocations.map((a: any) => a.qty)).toEqual([24, 20]);
  expect(p.cartons).toHaveLength(1);
  expect(p.totals).toMatchObject({ pieces: 44, yen: 3168, netKg: 0.928 });
  expect(
    p.issues.every((i: string) =>
      /HS code|measurements|gross weight|package convention/.test(i),
    ),
  ).toBe(true);
});
it("uses the final JPY price rather than an old price annotation", () => {
  const f = structuredClone(fixture);
  f.order.rows[3][11] = "68->72";
  expect(parse(f).products[0].price).toBe(72);
});
it("checks goods subtotal and charges against the grand total", () => {
  const f = structuredClone(fixture);
  f.order.rows[7][13] = 4169;
  expect(parse(f).issues).toContain(
    "Invoice grand total disagrees with goods plus logistics charges",
  );
});
it("does not silently merge repeated product JANs", () => {
  const f = structuredClone(fixture);
  f.order.rows.splice(5, 0, [...f.order.rows[3]]);
  expect(parse(f).issues.some((i: string) => i.includes("duplicate JAN"))).toBe(
    true,
  );
});
it("still rejects missing unit prices", () => {
  const f = structuredClone(fixture);
  f.order.rows[2][12] = "";
  expect(parse(f).issues[0]).toContain("price per piece");
});
