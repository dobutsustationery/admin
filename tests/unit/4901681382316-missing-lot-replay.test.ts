import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

import { lotMatchesOrder } from "$lib/cost-engine";
import { start_session } from "$lib/order-import-slice";
import { rootReducer } from "$lib/root-reducer";

const TARGET_JAN = "4901681382316";
const ORDER_1 = "1QROjGhUdlPsSvamuegVl3r7K8qoAzCv_";
const ORDER_2 = "1eK9UoCJrEkRTg3gyg7pNYRkQh2DdXmxK";

function replayFixtureThroughKanegenImports() {
  const actions = readFileSync(
    join(process.cwd(), "test-data", "4901681382316-missing-lot.jsonl"),
    "utf-8",
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .sort((a, b) => {
      return (
        (a._timestamp_millis ?? a._timestamp ?? 0) -
        (b._timestamp_millis ?? b._timestamp ?? 0)
      );
    });

  let state: any = rootReducer(undefined, { type: "@@INIT" });
  for (const action of actions) {
    if (action.id === "LpJIQvFOLLzZBclNn8MQ") {
      state = rootReducer(
        state,
        withActionTimestamp(
          start_session({
            id: ORDER_1,
            name: "Kanegan #1 (Order 1)",
          }),
          action,
        ),
      );
    } else if (action.id === "T4C9mhvbQntq35qHCGuN") {
      state = rootReducer(
        state,
        withActionTimestamp(
          start_session({
            id: ORDER_2,
            name: "Kanegan #2 (Order 3)",
          }),
          action,
        ),
      );
    }
    state = rootReducer(state, action);
    if (action.id === "51rDmHLmg38fBquQxJfG") break;
  }
  return state;
}

function withActionTimestamp(action: any, timestampSource: any) {
  return {
    ...action,
    timestamp: timestampSource.timestamp,
    _timestamp: timestampSource._timestamp,
    _timestamp_millis: timestampSource._timestamp_millis,
  };
}

describe("4901681382316 stock-order lot replay", () => {
  it("attributes the first scanned lot to order 1 and the next scanned lot to order 2", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const state = replayFixtureThroughKanegenImports();
      const ledger = state.inventory.costLedger[TARGET_JAN];
      const receipts = ledger.filter((e: any) => e.kind === "receipt");

      expect(receipts.map((e: any) => e.qty)).toEqual([4, 10, 10]);

      const order1Receipts = receipts.filter((e: any) =>
        lotMatchesOrder(e, ORDER_1),
      );
      const order2Receipts = receipts.filter((e: any) =>
        lotMatchesOrder(e, ORDER_2),
      );

      expect(order1Receipts.map((e: any) => [e.qty, e.unitCostJpy])).toEqual([
        [4, 726],
      ]);
      expect(order2Receipts.map((e: any) => [e.qty, e.unitCostJpy])).toEqual([
        [10, 636],
      ]);
      expect(order1Receipts[0].costOrderId).toBe(ORDER_1);
      expect(order2Receipts[0].costOrderId).toBe(ORDER_2);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
