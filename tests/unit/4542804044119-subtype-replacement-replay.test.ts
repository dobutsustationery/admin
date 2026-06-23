import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

import { effectiveLedgerEntries, walkLedger } from "$lib/cost-engine";
import { rootReducer } from "$lib/root-reducer";

const JAN = "4542804044119";
const FIXTURE = "4542804044119-subtype-merge-loss.jsonl";

const REPLACEMENTS = [
  {
    sourceKey: "4542804044119Multi  checks",
    targetKey: "4542804044119Blue",
  },
  {
    sourceKey: "4542804044119Multi abstract",
    targetKey: "4542804044119Blue",
  },
  {
    sourceKey: "4542804044119Purple",
    targetKey: "4542804044119Yellow",
  },
  {
    sourceKey: "4542804044119Stripes",
    targetKey: "4542804044119Yellow",
  },
] as const;

function loadReplayActions() {
  return readFileSync(join(process.cwd(), "test-data", FIXTURE), "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function replay(actions: any[]) {
  let state: any = rootReducer(undefined, { type: "@@INIT" });
  for (const action of actions) state = rootReducer(state, action, () => {});
  return state;
}

function itemCounts(state: any, key: string) {
  const item = state.inventory.idToItem[key];
  return {
    qty: Number(item?.qty) || 0,
    shipped: Number(item?.shipped) || 0,
    onHand: (Number(item?.qty) || 0) - (Number(item?.shipped) || 0),
  };
}

function ledgerOnHand(state: any, key: string) {
  return walkLedger(
    effectiveLedgerEntries(state.inventory.costLedger[key] || []),
  ).onHand;
}

function janOnHand(state: any) {
  return Object.entries(state.inventory.idToItem)
    .filter(([key]) => key.startsWith(JAN))
    .reduce((sum, [key]) => sum + itemCounts(state, key).onHand, 0);
}

describe("4542804044119 subtype replacement replay", () => {
  it("replaces zero-residue source subtypes without losing target recount inventory", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const actions = loadReplayActions();
      const firstReplacement = actions.findIndex(
        (action) => action.type === "replace_subtype",
      );
      expect(firstReplacement).toBeGreaterThan(0);

      const before = replay(actions.slice(0, firstReplacement));
      const after = replay(actions);

      const expectedByTarget = new Map<
        string,
        { qty: number; shipped: number; onHand: number; ledgerOnHand: number }
      >();
      for (const { sourceKey, targetKey } of REPLACEMENTS) {
        const source = itemCounts(before, sourceKey);
        const target = expectedByTarget.get(targetKey) || {
          ...itemCounts(before, targetKey),
          ledgerOnHand: ledgerOnHand(before, targetKey),
        };
        target.qty += source.qty;
        target.shipped += source.shipped;
        target.onHand += source.onHand;
        target.ledgerOnHand += ledgerOnHand(before, sourceKey);
        expectedByTarget.set(targetKey, target);
      }

      for (const { sourceKey } of REPLACEMENTS) {
        expect(after.inventory.idToItem[sourceKey]).toBeUndefined();
        expect(after.inventory.costLedger[sourceKey]).toBeUndefined();
      }

      for (const [targetKey, expected] of expectedByTarget) {
        expect(itemCounts(after, targetKey)).toMatchObject({
          qty: expected.qty,
          shipped: expected.shipped,
          onHand: expected.onHand,
        });
        expect(ledgerOnHand(after, targetKey)).toBeCloseTo(
          expected.ledgerOnHand,
          9,
        );
      }

      expect(janOnHand(after)).toBeCloseTo(janOnHand(before), 9);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
