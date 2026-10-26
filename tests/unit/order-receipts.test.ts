import { describe, it, expect } from "vitest";
import fixture from "../fixtures/customs-august.json";
import { rootReducer } from "$lib/root-reducer";
import {
  customsCreated,
  customsSourceChunk,
  customsSourceReceived,
  customsDecision,
  customsSettings,
} from "$lib/customs-summary-slice";
import {
  receiptStart,
  receiptReviewDecision,
  receiptReviewPrompt,
  type ReceiptRow,
  receiptConfirm,
  receiptLine,
  receiptFacts,
  receiptComplete,
  receiptRefresh,
} from "$lib/order-receipts";
import { update_item, package_item } from "$lib/inventory";

function scenario() {
  let state: any;
  const events: any[] = [];
  function send(a: any) {
    const event = {
      ...a,
      id: "receipt-event-" + events.length,
      creator: "test",
      timestamp: { seconds: 1789300000 + events.length, nanoseconds: 0 },
    };
    events.push(event);
    state = rootReducer(state, event, () => {});
    return state;
  }
  const reportId = "receiving-test";
  const first = String(fixture.order.rows[10][2]);
  send(
    update_item({
      id: first,
      item: {
        janCode: first,
        subtype: "",
        description: "Existing stock",
        hsCode: "48201030",
        qty: 100,
        pieces: 1,
        cost: 100,
      } as any,
    }),
  );
  send(
    package_item({ orderID: "existing-sale", itemKey: first as any, qty: 3 }),
  );
  send(customsCreated({ reportId, name: "Test delivery" }));
  send(
    customsSourceChunk({
      reportId,
      readId: "source",
      index: 0,
      json: JSON.stringify(fixture),
    }),
  );
  send(customsSourceReceived({ reportId, readId: "source", chunks: 1 }));
  send(
    customsDecision({
      reportId,
      jans: state.customsSummary.reports[reportId].projection.products.map(
        (p: any) => p.jan,
      ),
      decision: { code: "48201030" },
    }),
  );
  send(
    receiptStart({
      reportId,
      reportRevision: state.customsSummary.reports[reportId].revision,
    }),
  );
  const get = () => Object.values(state.orderReceipts.orders)[0] as any;
  const saveCosts = (override = {}) =>
    send(
      receiptFacts({
        orderId: get().id,
        revision: get().revision,
        facts: {
          date: "2026-09-14",
          goodsJpy: "238230",
          invoiceJpy: "250000",
          expectedPieces: "911",
          paidAmount: "1500",
          paidCurrency: "EUR",
          shippedDate: "2026-09-01",
          shippingAmount: "11770",
          shippingCurrency: "JPY",
          shippingIncluded: true,
          costTsv: "",
          stockNotEntered: true,
          unitsConfirmed: true,
          ...override,
        },
      }),
    );
  const confirm = () =>
    send(
      receiptConfirm({
        orderId: get().id,
        revision: get().revision,
        jans: get().projection.rows.map((r: any) => r.jan),
      }),
    );
  const complete = () =>
    send(receiptComplete({ orderId: get().id, revision: get().revision }));
  return {
    send,
    get,
    saveCosts,
    confirm,
    complete,
    first,
    reportId,
    events,
    state: () => state,
  };
}
describe("order receipts", () => {
  it("draft review and cost facts never change inventory; completion preserves shipped and adds only accepted goods", () => {
    const s = scenario();
    const before = structuredClone(s.state().inventory);
    s.confirm();
    s.saveCosts();
    const rows = s.get().projection.rows;
    const asset = rows[1],
      short = rows[2];
    s.send(
      receiptLine({
        orderId: s.get().id,
        revision: s.get().revision,
        jan: asset.jan,
        decision: {
          received: String(asset.expected),
          rejected: "0",
          note: "Office supplies",
          allocations: [
            {
              destination: "asset",
              itemKey: "",
              subtype: "",
              qty: String(asset.expected),
            },
          ],
        },
      }),
    );
    s.send(
      receiptLine({
        orderId: s.get().id,
        revision: s.get().revision,
        jan: short.jan,
        decision: {
          received: String(short.expected - 1),
          rejected: "1",
          note: "One missing, one damaged",
          allocations: [
            {
              destination: "inventory",
              itemKey: "",
              subtype: "",
              qty: String(short.expected - 2),
            },
          ],
        },
      }),
    );
    expect(s.state().inventory).toEqual(before);
    expect(s.get().projection.issues).toEqual([]);
    s.complete();
    expect(s.get().completed).toBeTruthy();
    expect(s.state().inventory.idToItem[s.first].qty).toBe(
      100 + rows[0].expected,
    );
    expect(s.state().inventory.idToItem[s.first].shipped).toBe(3);
    expect(s.state().inventory.idToItem[asset.jan]).toBeUndefined();
    expect(s.get().projection.assetQty).toBe(asset.expected);
    expect(s.get().projection.inventoryQty).toBe(911 - asset.expected - 2);
    expect(s.state().inventory.costLedger[short.jan].at(-1).qty).toBe(
      short.expected - 2,
    );
    expect(
      s.state().inventory.costLedger[short.jan].at(-1).unitCostEur,
    ).toBeCloseTo(short.unitJpy * 0.006);
    const completed = structuredClone(s.state().inventory);
    s.complete();
    s.complete();
    expect(s.state().inventory).toEqual(completed);
    s.send(
      receiptStart({
        reportId: s.reportId,
        reportRevision: s.state().customsSummary.reports[s.reportId].revision,
      }),
    );
    expect(Object.keys(s.state().orderReceipts.orders)).toHaveLength(1);
  });
  it("blocks unresolved costs and count errors before any posting", () => {
    const s = scenario();
    const before = structuredClone(s.state().inventory);
    s.confirm();
    s.saveCosts({ goodsJpy: "1" });
    s.complete();
    expect(s.get().completed).toBeUndefined();
    expect(s.state().inventory).toEqual(before);
    expect(s.get().projection.issues.join(" ")).toContain("Goods value");
    s.saveCosts();
    const row = s.get().projection.rows[0];
    s.send(
      receiptLine({
        orderId: s.get().id,
        revision: s.get().revision,
        jan: row.jan,
        decision: { received: "-1", rejected: "0", note: "", allocations: [] },
      }),
    );
    s.complete();
    expect(s.state().inventory).toEqual(before);
    expect(s.get().completed).toBeUndefined();
  });
  it("rejects stale operator edits and changed sources; refresh explicitly clears review", () => {
    const s = scenario();
    const revision = s.get().revision;
    s.confirm();
    s.send(
      receiptFacts({
        orderId: s.get().id,
        revision,
        facts: { ...s.get().facts, paidAmount: "1" },
      }),
    );
    expect(s.get().facts.paidAmount).toBe("");
    expect(Object.values(s.state().orderReceipts.results).at(-1)).toContain(
      "another tab",
    );
    s.saveCosts();
    s.send(
      customsSettings({
        reportId: s.reportId,
        settings: {
          grossKg: "40",
          grossSource: "scale",
          grossMethod: "shipment",
          cartonGross: {},
          packagePolicy: "cartons",
        },
      }),
    );
    s.complete();
    expect(s.get().completed).toBeUndefined();
    s.send(
      receiptRefresh({
        orderId: s.get().id,
        revision: s.get().revision,
        reportId: s.reportId,
        reportRevision: s.state().customsSummary.reports[s.reportId].revision,
      }),
    );
    expect(s.get().decisions).toEqual({});
  });
  it("requires explicit variants and exact allocation sums", () => {
    const s = scenario();
    const row = s.get().projection.rows[0];
    s.send(
      update_item({
        id: s.first + "Blue",
        item: { janCode: s.first, subtype: "Blue", qty: 5, pieces: 1 } as any,
      }),
    );
    s.confirm();
    expect(Object.keys(s.get().decisions)).toHaveLength(0);
    s.send(
      receiptLine({
        orderId: s.get().id,
        revision: s.get().revision,
        jan: row.jan,
        decision: {
          received: String(row.expected),
          rejected: "0",
          note: "",
          allocations: [
            {
              destination: "inventory",
              itemKey: s.first + "Blue",
              subtype: "",
              qty: "1",
            },
          ],
        },
      }),
    );
    expect(s.get().projection.issues.join(" ")).toContain(
      "allocations must equal",
    );
  });
  it("replays raw facts and user intents to identical receipt and inventory results", () => {
    const s = scenario();
    s.confirm();
    s.saveCosts();
    s.complete();
    const again = s.events.reduce(
      (state: any, event: any) => rootReducer(state, event, () => {}),
      undefined,
    );
    expect(again.orderReceipts).toEqual(s.state().orderReceipts);
    expect(again.inventory).toEqual(s.state().inventory);
    expect(s.events.at(-1).payload).toEqual({
      orderId: s.get().id,
      revision: s.get().revision - 1,
    });
  });
  it.each([0, 10])(
    "receives packs at zero available stock, preserving %i shipped units and replaying once",
    (shipped) => {
      const s = scenario();
      s.send(
        update_item({
          id: s.first,
          item: {
            ...s.state().inventory.idToItem[s.first],
            qty: shipped,
            shipped,
            pieces: 5,
          } as any,
        }),
      );
      s.confirm();
      s.saveCosts();
      const expected = s
        .get()
        .projection.rows.find((r: any) => r.jan === s.first).expected;
      expect(s.get().projection.issues).toEqual([]);
      expect(s.get().projection.packResets).toContain(s.first);
      expect(s.state().inventory.idToItem[s.first].pieces).toBe(5);
      s.complete();
      const item = s.state().inventory.idToItem[s.first];
      expect(item.pieces).toBe(1);
      expect(item.shipped).toBe(shipped);
      expect(item.qty - item.shipped).toBe(expected);
      const posted = structuredClone(s.state().inventory);
      s.complete();
      expect(s.state().inventory).toEqual(posted);
      const replay = s.events.reduce(
        (state: any, event: any) => rootReducer(state, event, () => {}),
        undefined,
      );
      expect(replay.inventory).toEqual(posted);
    },
  );
  it("rechecks zero stock at completion instead of relying on the earlier preview", () => {
    const s = scenario();
    s.send(
      update_item({
        id: s.first,
        item: {
          ...s.state().inventory.idToItem[s.first],
          qty: 0,
          shipped: 0,
          pieces: 5,
        } as any,
      }),
    );
    s.confirm();
    s.saveCosts();
    expect(s.get().projection.packResets).toContain(s.first);
    s.send(
      update_item({
        id: s.first,
        item: { ...s.state().inventory.idToItem[s.first], qty: 1 } as any,
      }),
    );
    s.complete();
    expect(s.get().completed).toBeUndefined();
    expect(s.get().projection.issues.join(" ")).toContain(
      "1 inventory units remaining",
    );
    expect(s.state().inventory.idToItem[s.first].pieces).toBe(5);
  });
  it("requires discrepancy notes, rejects pack unit ambiguity, and respects completion immutability", () => {
    const s = scenario();
    s.confirm();
    s.saveCosts();
    const row = s.get().projection.rows[0];
    s.send(
      receiptLine({
        orderId: s.get().id,
        revision: s.get().revision,
        jan: row.jan,
        decision: {
          ...row.defaultDecision,
          received: String(row.expected - 1),
          allocations: [
            {
              ...row.defaultDecision.allocations[0],
              qty: String(row.expected - 1),
            },
          ],
        },
      }),
    );
    expect(s.get().projection.issues.join(" ")).toContain(
      "explain the shortage",
    );
    s.send(
      receiptConfirm({
        orderId: s.get().id,
        revision: s.get().revision,
        jans: [row.jan],
      }),
    );
    s.send(
      update_item({
        id: s.first,
        item: { ...s.state().inventory.idToItem[s.first], pieces: 2 } as any,
      }),
    );
    s.complete();
    expect(s.get().completed).toBeUndefined();
    expect(s.get().projection.issues.join(" ")).toContain("packs/loose pieces");
  });
});

describe("receipt variant review suggestions", () => {
  const row = (expected: number, variants = ["Cat", "Dog"]): ReceiptRow => ({
    jan: "4542804050851",
    description: "Lazy Animals",
    expected,
    code: "48211010",
    unitJpy: 62,
    received: 0,
    rejected: 0,
    accepted: 0,
    missing: expected,
    confirmed: false,
    matches: variants.map((subtype) => ({
      id: "4542804050851" + subtype,
      subtype,
      available: 0,
    })),
    defaultDecision: {
      received: String(expected),
      rejected: "0",
      note: "",
      allocations: [
        {
          destination: "inventory",
          itemKey: "",
          subtype: "",
          qty: String(expected),
        },
      ],
    },
  });
  it("explains the ambiguity and suggests 18 Cat and 18 Dog without confirming", () => {
    const source = row(36);
    expect(receiptReviewPrompt(source)).toBe(
      "Split 36 units between Cat and Dog.",
    );
    const decision = receiptReviewDecision(source);
    expect(decision.allocations.map((a) => [a.itemKey, a.qty])).toEqual([
      ["4542804050851Cat", "18"],
      ["4542804050851Dog", "18"],
    ]);
    expect(source.confirmed).toBe(false);
    expect(source.defaultDecision.allocations).toHaveLength(1);
  });
  it.each([25, 2, 0])(
    "keeps whole units and preserves the total of %s across three variants",
    (expected) => {
      const allocations = receiptReviewDecision(
        row(expected, ["Cat", "Dog", "Seal"]),
      ).allocations;
      const quantities = allocations.map((a) => Number(a.qty));
      expect(quantities.every((q) => Number.isInteger(q) && q >= 0)).toBe(true);
      expect(quantities.reduce((a, b) => a + b, 0)).toBe(expected);
      expect(
        Math.max(...quantities) - Math.min(...quantities),
      ).toBeLessThanOrEqual(1);
    },
  );
  it("preserves saved counts, rejections and allocations when reopening", () => {
    const source = row(36);
    const saved = {
      received: "35",
      rejected: "1",
      note: "One missing, one damaged",
      allocations: [
        {
          destination: "inventory" as const,
          itemKey: "4542804050851Dog",
          subtype: "",
          qty: "34",
        },
      ],
    };
    const decision = receiptReviewDecision(source, saved);
    expect(decision).toEqual(saved);
    decision.allocations[0].qty = "1";
    expect(saved.allocations[0].qty).toBe("34");
  });
  it("keeps the existing default for unambiguous products", () => {
    const source = row(36, ["Cat"]);
    expect(receiptReviewDecision(source)).toEqual(source.defaultDecision);
    expect(receiptReviewPrompt(source)).toBe("Confirm count and quality.");
  });
});
