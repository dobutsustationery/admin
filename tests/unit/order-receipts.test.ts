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
