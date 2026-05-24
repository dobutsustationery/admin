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
  bulk_import_items,
  split_inventory_item,
  update_item,
  type Item,
} from "../../src/lib/inventory";
import { makeInventoryItemKey } from "../../src/lib/sku";

describe("Listing Creation - Split Inventory", () => {
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
});
