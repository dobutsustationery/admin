import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { rootReducer } from "$lib/root-reducer";
import {
  computeShopifyImportBatch,
  parseShopifyChunk,
} from "$lib/shopify-import-slice";
import { computeOrderImportBatch } from "$lib/order-import-slice";

const TARGET_JAN = "4542804105827";
const TARGET_BLUE_KEY = `${TARGET_JAN}Blue`;
const TARGET_BEIGE_KEY = `${TARGET_JAN}Beige`;
const BACKUP_PATH = join(
  process.cwd(),
  "..",
  "production-backup-mar-28",
  "firestore-export.json",
);

type BroadcastDoc = {
  id: string;
  data: Record<string, any>;
};

type ItemSnapshot = {
  qty: number;
  shipped: number;
  pieces: number;
  subtype: string;
  description: string;
} | null;

type OrderLineSnapshot = {
  orderID: string;
  itemKey: string;
  qty: number;
  product?: string;
  email?: string;
  date?: string;
};

function timestampSortValue(doc: BroadcastDoc): bigint {
  const seconds = BigInt(doc.data?.timestamp?._seconds || 0);
  const nanos = BigInt(doc.data?.timestamp?._nanoseconds || 0);
  return seconds * 1_000_000_000n + nanos;
}

function loadBroadcastDocs(): BroadcastDoc[] {
  const raw = JSON.parse(readFileSync(BACKUP_PATH, "utf-8"));
  const docs = (raw?.collections?.broadcast?.documents || []) as BroadcastDoc[];
  return [...docs].sort((a, b) => {
    const diff = timestampSortValue(a) - timestampSortValue(b);
    if (diff < 0n) return -1;
    if (diff > 0n) return 1;
    return String(a.id).localeCompare(String(b.id));
  });
}

function snapshotItem(item: any): ItemSnapshot {
  if (!item) return null;
  return {
    qty: Number(item.qty || 0),
    shipped: Number(item.shipped || 0),
    pieces: Number(item.pieces || 0),
    subtype: String(item.subtype || ""),
    description: String(item.description || ""),
  };
}

function snapshotState(state: any) {
  const orderLines: OrderLineSnapshot[] = Object.values(
    state.inventory?.orderIdToOrder || {},
  )
    .flatMap((order: any) =>
      (order.items || [])
        .filter((line: any) =>
          String(line.itemKey || "").startsWith(TARGET_JAN),
        )
        .map((line: any) => ({
          orderID: String(order.id || ""),
          itemKey: String(line.itemKey || ""),
          qty: Number(line.qty || 0),
          product: order.product,
          email: order.email,
          date:
            order.date instanceof Date
              ? order.date.toISOString()
              : String(order.date || ""),
        })),
    )
    .sort((a, b) =>
      `${a.orderID}:${a.itemKey}`.localeCompare(`${b.orderID}:${b.itemKey}`),
    );

  return {
    blue: snapshotItem(state.inventory?.idToItem?.[TARGET_BLUE_KEY]),
    beige: snapshotItem(state.inventory?.idToItem?.[TARGET_BEIGE_KEY]),
    orderLines,
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function compactPayload(type: string, payload: Record<string, any>) {
  if (type === "update_item") {
    return {
      id: payload.id,
      item: {
        janCode: payload.item?.janCode,
        subtype: payload.item?.subtype,
        qty: payload.item?.qty,
        shipped: payload.item?.shipped,
        pieces: payload.item?.pieces,
      },
    };
  }

  if (
    type === "package_item" ||
    type === "quantify_item" ||
    type === "retype_item" ||
    type === "new_order" ||
    type === "delete_empty_order"
  ) {
    return payload;
  }

  if (type === "shopifyImport/append_raw_rows") {
    const matchingRows = (payload.rawRows || []).filter((row: string) =>
      row.includes(TARGET_JAN),
    );
    return {
      rawRowCount: Array.isArray(payload.rawRows) ? payload.rawRows.length : 0,
      matchingRows,
      done: payload.done,
    };
  }

  if (type === "shopifyImport/set_header") {
    return {
      headerPrefix: String(payload).slice(0, 120),
    };
  }

  return payload;
}

function summarizeBatchUpdates(updates: any[]) {
  return updates
    .filter((update) => String(update.id || "").startsWith(TARGET_JAN))
    .map((update) => ({
      type: update.type,
      id: update.id,
      item: update.item
        ? {
            janCode: update.item.janCode,
            subtype: update.item.subtype,
            qty: update.item.qty,
            shipped: update.item.shipped,
            pieces: update.item.pieces,
            description: update.item.description,
          }
        : null,
    }));
}

function findShopifyHeader(docs: BroadcastDoc[]): string {
  const headerDoc = docs.find(
    (doc) => doc.data?.type === "shopifyImport/set_header",
  );
  return String(headerDoc?.data?.payload || "");
}

function findTargetShopifyRows(docs: BroadcastDoc[]) {
  const rows = docs
    .filter((doc) => doc.data?.type === "shopifyImport/append_raw_rows")
    .flatMap((doc) => doc.data?.payload?.rawRows || [])
    .filter((row: string) => row.includes(TARGET_JAN));

  const header = findShopifyHeader(docs);
  if (!header) return rows.map((raw) => ({ raw, parsed: null }));

  const parsed = parseShopifyChunk(header, rows, null);
  return rows.map((raw, index) => ({
    raw,
    parsed: parsed.items[index]?.item || null,
  }));
}

describe("Replay Shabby Chic shipped diagnostics", () => {
  it("replays the Mar 28 production backup for 4542804105827 and traces shipped mutations", () => {
    if (!existsSync(BACKUP_PATH)) {
      console.warn(`[shabby-chic-debug] backup not found at ${BACKUP_PATH}`);
      return;
    }

    const docs = loadBroadcastDocs();
    const trace: Array<Record<string, unknown>> = [];
    const shippedTransitions: Array<Record<string, unknown>> = [];
    const orderImportBatchUpdates: any[] = [];
    const shopifyImportBatchUpdates: any[] = [];

    let state = rootReducer(undefined, { type: "@@INIT" });

    for (const doc of docs) {
      const before = snapshotState(state);
      let generatedUpdates: any[] = [];

      if (doc.data?.type === "orderImport/import_batch") {
        generatedUpdates = computeOrderImportBatch(
          state.orderImport,
          state.inventory.idToItem,
          doc.data?.payload?.filter,
        ).updates;
        orderImportBatchUpdates.push(
          ...summarizeBatchUpdates(generatedUpdates),
        );
      }

      if (doc.data?.type === "shopifyImport/import_batch") {
        generatedUpdates = computeShopifyImportBatch(
          state.shopifyImport,
          state.inventory.idToItem,
          state.listings.handleToListing,
          doc.data?.payload?.filter,
          doc.data?.payload?.options,
          0,
        ).updates;
        shopifyImportBatchUpdates.push(
          ...summarizeBatchUpdates(generatedUpdates),
        );
      }

      state = rootReducer(state, doc.data);

      const after = snapshotState(state);
      const changed = stableStringify(before) !== stableStringify(after);
      const payload = doc.data?.payload || {};

      if (changed) {
        trace.push({
          id: doc.id,
          type: doc.data?.type,
          timestamp: doc.data?.timestamp,
          payload: compactPayload(String(doc.data?.type || ""), payload),
          generatedUpdates: summarizeBatchUpdates(generatedUpdates),
          before,
          after,
        });
      }

      if (
        before.blue?.shipped !== after.blue?.shipped ||
        before.beige?.shipped !== after.beige?.shipped
      ) {
        shippedTransitions.push({
          id: doc.id,
          type: doc.data?.type,
          timestamp: doc.data?.timestamp,
          payload: compactPayload(String(doc.data?.type || ""), payload),
          generatedUpdates: summarizeBatchUpdates(generatedUpdates),
          before,
          after,
        });
      }
    }

    const finalState = snapshotState(state);
    const targetShopifyRows = findTargetShopifyRows(docs);
    const beigeOrderQty = finalState.orderLines
      .filter((line) => line.itemKey === TARGET_BEIGE_KEY)
      .reduce((sum, line) => sum + line.qty, 0);

    console.log("[shabby-chic-debug] final snapshot");
    console.log(stableStringify(finalState));
    console.log("[shabby-chic-debug] changed-state trace");
    console.log(stableStringify(trace));
    console.log("[shabby-chic-debug] shipped transitions");
    console.log(stableStringify(shippedTransitions));
    console.log("[shabby-chic-debug] parsed Shopify rows for target JAN");
    console.log(stableStringify(targetShopifyRows));

    expect(finalState.beige).toBeDefined();
    expect(finalState.beige?.shipped).toBe(1);
    expect(beigeOrderQty).toBe(1);
    expect(
      shippedTransitions.filter((entry) => entry.type === "package_item")
        .length,
    ).toBe(1);
    expect(
      shippedTransitions.filter((entry) => entry.type === "retype_item").length,
    ).toBe(1);
    expect(
      orderImportBatchUpdates.every(
        (update) =>
          !String(update.id || "").startsWith(TARGET_JAN) ||
          update.item?.shipped === undefined,
      ),
    ).toBe(true);
    expect(
      shopifyImportBatchUpdates.every(
        (update) =>
          !String(update.id || "").startsWith(TARGET_JAN) ||
          update.item?.shipped === undefined,
      ),
    ).toBe(true);
    expect(
      shippedTransitions.every(
        (entry) =>
          !["orderImport/import_batch", "shopifyImport/import_batch"].includes(
            String(entry.type),
          ),
      ),
    ).toBe(true);
    expect(targetShopifyRows.some((row) => row.parsed?.qty === 4)).toBe(true);
  });
});
