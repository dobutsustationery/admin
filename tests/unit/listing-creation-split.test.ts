import { describe, expect, it } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { rootReducer as _rootReducer } from "../../src/lib/root-reducer";
// Fixtures omit the per-action timestamp that every replayed action
// carries in production; stamp one (deriveCreationTimestampMs fails
// loudly on a missing timestamp).
const rootReducer = (s: any, a: any) =>
  _rootReducer(
    s,
    a && typeof a === "object" && a.type && !("timestamp" in a)
      ? { ...a, timestamp: { _seconds: 1_700_000_000, _nanoseconds: 0 } }
      : a,
  );
import {
  approve_proposal_thunk,
  add_proposals_internal,
} from "../../src/lib/listing-creation-slice";
import {
  archive_inventory,
  bulk_import_items,
  package_item,
  split_inventory_item,
  update_item,
  type Item,
} from "../../src/lib/inventory";
import type { LedgerEntry } from "../../src/lib/cost-engine";
import { makeInventoryItemKey } from "../../src/lib/sku";

describe("Listing Creation - Split Inventory", () => {
  const dispatchAt = (
    store: ReturnType<typeof configureStore>,
    action: any,
    ms: number,
  ) =>
    store.dispatch({
      ...action,
      timestamp: {
        seconds: Math.floor(ms / 1000),
        _seconds: Math.floor(ms / 1000),
        nanoseconds: 0,
        _nanoseconds: 0,
      },
    });

  it("should remove source item when split into variants", () => {
    const store = configureStore({ reducer: rootReducer });
    const janCode = "4542804117844";
    const itemId = janCode;

    // 1. Setup Inventory (Source Item)
    const item: Item = {
      janCode,
      subtype: "",
      description: "Source Product",
      qty: 20,
      price: 0,
      handle: "",
      shipped: 0,
      pieces: 1,
      creationDate: "2024-01-01",
      timestamp: Date.now(),
      hsCode: "1234.56",
      image: "",
    };
    store.dispatch(update_item({ id: itemId, item }));

    // 2. Setup Proposal with multiple variants for the SAME itemId
    store.dispatch(
      add_proposals_internal([
        {
          janCode,
          inventoryItemIds: [itemId],
          photoGroupIds: [janCode],
          title: "Split Product",
          handle: "split-handle",
          bodyHtml: "<p>Description</p>",
          productCategory: "Stationery",
          vendor: "Dobutsu",
          tags: ["tag1"],
          option1Name: "Subtype",
          variants: [
            { id: "v-blue", itemId, option1Value: "Blue", qty: 10 },
            { id: "v-brown", itemId, option1Value: "Brown", qty: 10 },
          ],
          status: "draft",
          price: 1500,
        },
      ]),
    );

    // 3. Approve
    store.dispatch(approve_proposal_thunk(janCode) as any);

    // 4. Verify Inventory
    const state = store.getState().inventory;

    // New items should exist
    expect(state.idToItem[janCode + "Blue"]).toBeDefined();
    expect(state.idToItem[janCode + "Brown"]).toBeDefined();
    expect(state.idToItem[janCode + "Blue"].qty).toBe(10);
    expect(state.idToItem[janCode + "Brown"].qty).toBe(10);

    // Original item should be gone
    expect(state.idToItem[itemId]).toBeUndefined();
  });

  it("should use canonical subtype keys when splitting variants with spaces", () => {
    const store = configureStore({ reducer: rootReducer });
    const janCode = "4952270291472";
    const itemId = janCode;

    const item: Item = {
      janCode,
      subtype: "",
      description: "Source Product",
      qty: 4,
      price: 0,
      handle: "",
      shipped: 0,
      pieces: 1,
      creationDate: "2024-01-01",
      timestamp: Date.now(),
      hsCode: "48211010",
      image: "",
    };
    store.dispatch(update_item({ id: itemId, item }));

    store.dispatch(
      add_proposals_internal([
        {
          janCode,
          inventoryItemIds: [itemId],
          photoGroupIds: [janCode],
          title: "Split Product",
          handle: "split-handle",
          bodyHtml: "<p>Description</p>",
          productCategory: "Stationery",
          vendor: "Dobutsu",
          tags: ["tag1"],
          option1Name: "Subtype",
          variants: [
            { id: "v-deco", itemId, option1Value: "Deco Seals", qty: 2 },
            { id: "v-memo", itemId, option1Value: "Memo Pad", qty: 2 },
          ],
          status: "draft",
          price: 1500,
        },
      ]),
    );

    store.dispatch(approve_proposal_thunk(janCode) as any);

    const state = store.getState().inventory;
    const decoKey = makeInventoryItemKey(janCode, "Deco Seals");
    const memoKey = makeInventoryItemKey(janCode, "Memo Pad");

    expect(decoKey).toBe(janCode + "Deco Seals");
    expect(state.idToItem[decoKey]).toBeDefined();
    expect(state.idToItem[memoKey]).toBeDefined();
    expect(state.idToItem[janCode + "DecoSeals"]).toBeUndefined();
    expect(state.idToItem[decoKey].subtype).toBe("Deco Seals");
  });

  it("should split receipt ledger quantities according to variant quantities", () => {
    const store = configureStore({ reducer: rootReducer });
    const janCode = "4571207041944";
    const itemId = janCode;

    const item: Item = {
      janCode,
      subtype: "",
      description: "Source Product",
      qty: 24,
      price: 0,
      handle: "",
      shipped: 0,
      pieces: 1,
      creationDate: "2026-03-02",
      timestamp: 1772483113814,
      hsCode: "82130000",
      image: "",
      cost: 74,
    };

    store.dispatch(
      bulk_import_items({
        items: [
          {
            type: "new",
            id: itemId,
            item,
            stockOrder: {
              orderId: "stock-order-1",
              unitCostJpy: 74,
              unitCostEur: 0,
              receivedAt: 1772483113814,
              orderedQty: 24,
            },
          },
        ],
      }),
    );

    store.dispatch(
      add_proposals_internal([
        {
          janCode,
          inventoryItemIds: [itemId],
          photoGroupIds: [janCode],
          title: "Split Product",
          handle: "split-handle",
          bodyHtml: "<p>Description</p>",
          productCategory: "Stationery",
          vendor: "Dobutsu",
          tags: ["tag1"],
          option1Name: "Subtype",
          variants: [
            { id: "v-pink", itemId, option1Value: "Pink", qty: 8 },
            { id: "v-purple", itemId, option1Value: "Purple", qty: 8 },
            { id: "v-green", itemId, option1Value: "Green", qty: 8 },
          ],
          status: "draft",
          price: 4,
        },
      ]),
    );

    store.dispatch(approve_proposal_thunk(janCode) as any);

    const state = store.getState().inventory;
    expect(state.idToItem[itemId]).toBeUndefined();
    expect(state.costLedger[itemId]).toBeUndefined();
    expect(state.costLedger[janCode + "Pink"][0].qty).toBe(8);
    expect(state.costLedger[janCode + "Purple"][0].qty).toBe(8);
    expect(state.costLedger[janCode + "Green"][0].qty).toBe(8);
    expect(state.costLedger[janCode + "Pink"][0].unitCostJpy).toBe(74);
    expect(state.costLedger[janCode + "Pink"][0].auditComment).toContain(
      `from ${itemId} to ${janCode}Pink`,
    );
  });

  it("should ignore a zero-quantity split back into the same item", () => {
    const store = configureStore({ reducer: rootReducer });
    const blueKey = makeInventoryItemKey("4969757165348", "Blue");
    const item: Item = {
      janCode: "4969757165348",
      subtype: "Blue",
      description: "Source Product",
      qty: 10,
      price: 0,
      handle: "",
      shipped: 0,
      pieces: 1,
      creationDate: "2026-03-02",
      timestamp: 1772483113814,
      hsCode: "49090000",
      image: "",
      cost: 65,
    };

    store.dispatch(
      bulk_import_items({
        items: [
          {
            type: "new",
            id: blueKey,
            item,
            stockOrder: {
              orderId: "stock-order-1",
              unitCostJpy: 65,
              unitCostEur: 0,
              receivedAt: 1772483113814,
              orderedQty: 10,
            },
          },
        ],
      }),
    );

    store.dispatch(
      split_inventory_item({
        sourceId: blueKey,
        splits: [
          {
            newId: blueKey,
            qty: 0,
            subtype: "Blue",
          },
        ],
      }),
    );

    const ledger = store.getState().inventory.costLedger[blueKey];
    expect(store.getState().inventory.idToItem[blueKey].qty).toBe(10);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].qty).toBe(10);
    expect(ledger[0].unitCostJpy).toBe(65);
    expect(ledger[0].auditComment).toBeUndefined();
  });

  it("should not duplicate source ledger rows when retaining source as a split target", () => {
    const store = configureStore({ reducer: rootReducer });
    const blueKey = makeInventoryItemKey("4969757165348", "Blue");
    const purpleKey = makeInventoryItemKey("4969757165348", "Purple");
    const item: Item = {
      janCode: "4969757165348",
      subtype: "Blue",
      description: "Source Product",
      qty: 10,
      price: 0,
      handle: "",
      shipped: 0,
      pieces: 1,
      creationDate: "2026-03-02",
      timestamp: 1772483113814,
      hsCode: "49090000",
      image: "",
      cost: 65,
    };

    store.dispatch(
      bulk_import_items({
        items: [
          {
            type: "new",
            id: blueKey,
            item,
            stockOrder: {
              orderId: "stock-order-1",
              unitCostJpy: 65,
              unitCostEur: 0,
              receivedAt: 1772483113814,
              orderedQty: 10,
            },
          },
        ],
      }),
    );

    store.dispatch(
      split_inventory_item({
        sourceId: blueKey,
        splits: [
          {
            newId: blueKey,
            qty: 5,
            subtype: "Blue",
          },
          {
            newId: purpleKey,
            qty: 5,
            subtype: "Purple",
          },
        ],
      }),
    );

    const state = store.getState().inventory;
    expect(state.idToItem[blueKey].qty).toBe(5);
    expect(state.idToItem[purpleKey].qty).toBe(5);
    expect(state.costLedger[blueKey]).toHaveLength(1);
    expect(state.costLedger[purpleKey]).toHaveLength(1);
    expect(state.costLedger[blueKey][0].qty).toBe(5);
    expect(state.costLedger[purpleKey][0].qty).toBe(5);
  });

  it("should split only open receipt lots after historical source receipts were consumed", () => {
    const store = configureStore({ reducer: rootReducer });
    const janCode = "4977564680084";
    const sourceKey = makeInventoryItemKey(janCode, "");
    const bearKey = makeInventoryItemKey(janCode, "Bear");
    const hedgehogKey = makeInventoryItemKey(janCode, "Hedgehog");
    const sourceItem: Item = {
      janCode,
      subtype: "",
      description: "Source Product",
      qty: 7,
      price: 0,
      handle: "",
      shipped: 0,
      pieces: 1,
      creationDate: "2023-11-12",
      timestamp: Date.UTC(2023, 10, 12),
      hsCode: "39261000",
      image: "",
      cost: 0,
    };

    dispatchAt(
      store,
      bulk_import_items({
        items: [
          {
            type: "new",
            id: sourceKey,
            item: sourceItem,
            stockOrder: {
              orderId: "old-zero-cost-scan",
              unitCostJpy: 0,
              unitCostEur: 0,
              receivedAt: Date.UTC(2023, 10, 12),
              orderedQty: 7,
            },
          },
        ],
      }),
      Date.UTC(2023, 10, 12),
    );

    dispatchAt(
      store,
      package_item({ orderID: "sale-1", itemKey: sourceKey, qty: 1 }),
      Date.UTC(2024, 0, 21),
    );
    dispatchAt(
      store,
      package_item({ orderID: "sale-2", itemKey: sourceKey, qty: 1 }),
      Date.UTC(2024, 0, 21, 1),
    );
    dispatchAt(
      store,
      package_item({ orderID: "sale-3", itemKey: sourceKey, qty: 1 }),
      Date.UTC(2024, 9, 26),
    );
    dispatchAt(
      store,
      package_item({ orderID: "sale-4", itemKey: sourceKey, qty: 1 }),
      Date.UTC(2024, 9, 26, 1),
    );
    dispatchAt(
      store,
      archive_inventory({ archiveName: "Japan Festival 2025" }),
      Date.UTC(2025, 4, 2),
    );

    dispatchAt(
      store,
      bulk_import_items({
        items: [
          {
            type: "update",
            id: sourceKey,
            item: { ...sourceItem, qty: 40, shipped: 0, cost: 66 },
            stockOrder: {
              orderId: "new-stock-order",
              unitCostJpy: 66,
              unitCostEur: 0.37,
              receivedAt: Date.UTC(2025, 11, 3),
              orderedQty: 40,
            },
          },
        ],
      }),
      Date.UTC(2026, 2, 2),
    );

    dispatchAt(
      store,
      split_inventory_item({
        sourceId: sourceKey,
        splits: [
          { newId: bearKey, qty: 20, subtype: "Bear" },
          { newId: hedgehogKey, qty: 20, subtype: "Hedgehog" },
        ],
      }),
      Date.UTC(2026, 2, 15),
    );

    const state = store.getState().inventory;
    expect(state.idToItem[sourceKey]).toBeUndefined();
    expect(state.costLedger[bearKey]).toHaveLength(1);
    expect(state.costLedger[hedgehogKey]).toHaveLength(1);
    expect(state.costLedger[bearKey][0]).toMatchObject({
      kind: "receipt",
      qty: 20,
      unitCostJpy: 66,
      source: "stockOrder:new-stock-order",
    });
    expect(state.costLedger[hedgehogKey][0]).toMatchObject({
      kind: "receipt",
      qty: 20,
      unitCostJpy: 66,
      source: "stockOrder:new-stock-order",
    });
    expect(
      state.costLedger[bearKey].some(
        (entry: LedgerEntry) =>
          entry.kind === "receipt" && entry.unitCostJpy === 0,
      ),
    ).toBe(false);
    expect(
      state.costLedger[hedgehogKey].some(
        (entry: LedgerEntry) =>
          entry.kind === "receipt" && entry.unitCostJpy === 0,
      ),
    ).toBe(false);
  });

  it("should preserve the source ledger when a split moves zero quantity", () => {
    const store = configureStore({ reducer: rootReducer });
    const janCode = "4542804050851";
    const catKey = makeInventoryItemKey(janCode, "Cat");
    const dogKey = makeInventoryItemKey(janCode, "dog");
    const item: Item = {
      janCode,
      subtype: "Cat",
      description: "Source Product",
      qty: 24,
      price: 0,
      handle: "",
      shipped: 0,
      pieces: 1,
      creationDate: "2024-10-09",
      timestamp: Date.UTC(2024, 9, 9),
      hsCode: "48211010",
      image: "",
      cost: 65,
    };

    dispatchAt(
      store,
      bulk_import_items({
        items: [
          {
            type: "new",
            id: catKey,
            item: { ...item, qty: 12 },
            stockOrder: {
              orderId: "old-stock-order",
              unitCostJpy: 65,
              unitCostEur: 0,
              receivedAt: Date.UTC(2024, 9, 9),
              orderedQty: 12,
            },
          },
        ],
      }),
      Date.UTC(2024, 9, 9),
    );

    dispatchAt(
      store,
      bulk_import_items({
        items: [
          {
            type: "update",
            id: catKey,
            item: { ...item, qty: 24, cost: 62 },
            stockOrder: {
              orderId: "new-stock-order",
              unitCostJpy: 62,
              unitCostEur: 0,
              receivedAt: Date.UTC(2025, 8, 25),
              orderedQty: 24,
            },
          },
        ],
      }),
      Date.UTC(2025, 8, 25),
    );

    dispatchAt(
      store,
      package_item({ orderID: "sale-1", itemKey: catKey, qty: 1 }),
      Date.UTC(2025, 11, 7),
    );

    const beforeLedger = structuredClone(
      store.getState().inventory.costLedger[catKey],
    );
    const beforeQty = store.getState().inventory.idToItem[catKey].qty;

    dispatchAt(
      store,
      split_inventory_item({
        sourceId: catKey,
        splits: [{ newId: dogKey, qty: 0, subtype: "dog" }],
      }),
      Date.UTC(2026, 2, 19),
    );

    const state = store.getState().inventory;
    expect(state.idToItem[catKey].qty).toBe(beforeQty);
    expect(state.idToItem[dogKey].qty).toBe(0);
    expect(state.costLedger[catKey]).toEqual(beforeLedger);
    expect(state.costLedger[dogKey]).toBeUndefined();
  });
});
