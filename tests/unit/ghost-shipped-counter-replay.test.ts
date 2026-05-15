import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { rootReducer } from "$lib/root-reducer";

const BACKUP_PATH = join(
  process.cwd(),
  "..",
  "production-backup-apr-25",
  "firestore-export.json",
);

// Row 7/9 in docs/investigations/GHOST_MISSING_15_AUDIT.md:
//   - Order 5XX72156AK696890X-2of3 carries one Swan via a package+retype sequence
//     that routed through the non-existent "Purple" subtype.
//   - The reducer's both-keys-must-exist guard on retype_item silently skipped
//     the shipped accumulator for the renamed-into Swan key.
const SWAN_ORDER_ID = "5XX72156AK696890X-2of3";
const SWAN_KEY = "4542804130904Swan";

// Rows 10–14: Helen3 order, JAN 4542804112832, two retypes from the renamed-away
// "Orange" subtype that the audit shows should have moved 1 → Strawberry and
// 3 → Cherry.
const HELEN3_ORDER_ID = "Helen3";
const STRAWBERRY_KEY = "4542804112832Strawberry";
const CHERRY_KEY = "4542804112832Cherry";

type BroadcastDoc = {
  id: string;
  data: Record<string, any>;
};

function timestampSortValue(doc: BroadcastDoc): bigint {
  const seconds = BigInt(doc.data?.timestamp?._seconds || 0);
  const nanos = BigInt(doc.data?.timestamp?._nanoseconds || 0);
  return seconds * 1_000_000_000n + nanos;
}

function loadActions(): Array<{ id: string } & Record<string, any>> {
  const raw = JSON.parse(readFileSync(BACKUP_PATH, "utf-8"));
  const docs = (raw?.collections?.broadcast?.documents || []) as BroadcastDoc[];
  return [...docs]
    .sort((a, b) => {
      const diff = timestampSortValue(a) - timestampSortValue(b);
      if (diff < 0n) return -1;
      if (diff > 0n) return 1;
      return String(a.id).localeCompare(String(b.id));
    })
    .map((doc) => ({ id: doc.id, ...(doc.data as any) }));
}

function findOrderLineQty(
  state: any,
  orderID: string,
  itemKey: string,
): number {
  const order = state?.inventory?.orderIdToOrder?.[orderID];
  if (!order) return 0;
  const line = (order.items || []).find((i: any) => i.itemKey === itemKey);
  return line ? Number(line.qty || 0) : 0;
}

function shippedOf(state: any, itemKey: string): number {
  const item = state?.inventory?.idToItem?.[itemKey];
  return item ? Number(item.shipped || 0) : 0;
}

describe("Ghost-shipped-counter replay (Apr 25 backup)", () => {
  it("credits shipped on the canonical key for renamed-away retypes", () => {
    if (!existsSync(BACKUP_PATH)) {
      console.warn(`[ghost-shipped] backup not found at ${BACKUP_PATH}`);
      return;
    }

    const actions = loadActions();
    let state: any = rootReducer(undefined, { type: "@@INIT" });
    for (const action of actions) {
      try {
        state = rootReducer(state, action as any, () => {});
      } catch (e) {
        // Mirror audit-page tolerance: per-action errors do not abort replay.
        console.warn(
          `[ghost-shipped] replay error on ${action.id} (${action?.type}):`,
          (e as Error).message,
        );
      }
    }

    // --- Swan case (rows 7+9) ---
    // The order ended up carrying one Swan line; inventory shipped must reflect it.
    expect(findOrderLineQty(state, SWAN_ORDER_ID, SWAN_KEY)).toBe(1);
    expect(shippedOf(state, SWAN_KEY)).toBe(1);

    // --- Helen3 case (rows 10–14) ---
    // Final order carries Strawberry qty=3 and Cherry qty=3 against this JAN.
    // The Helen3 contribution to shipped is +1 Strawberry (row 11) and
    // +3 Cherry (row 14). The Strawberry baseline at row-14 time is 2, so
    // the post-fix final reads Strawberry shipped = 3, Cherry shipped = 3.
    expect(findOrderLineQty(state, HELEN3_ORDER_ID, STRAWBERRY_KEY)).toBe(3);
    expect(findOrderLineQty(state, HELEN3_ORDER_ID, CHERRY_KEY)).toBe(3);
    expect(shippedOf(state, STRAWBERRY_KEY)).toBe(3);
    expect(shippedOf(state, CHERRY_KEY)).toBe(3);
  }, 180_000);
});
