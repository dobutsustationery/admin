import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { rootReducer } from "$lib/root-reducer";

// Reproduction: 4901681506606 (Zebra MCF-12C marker) ends a replay of
// the Kanegen "Working on this for automation" import with no weight.
// Diagnosis pattern mirrors 9736eec / fd271b2.
const TARGET_JAN = "4901681506606";

function replayFixture() {
  const actions = readFileSync(
    join(process.cwd(), "test-data", "4901681506606-missing-weight.jsonl"),
    "utf-8",
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  let state: any = rootReducer(undefined, { type: "@@INIT" });
  for (const action of actions) state = rootReducer(state, action);
  return state;
}

describe("4901681506606 missing-weight replay", () => {
  it("reproduces: the item has no weight after replay", () => {
    const state = replayFixture();
    const items = Object.entries(state.inventory?.idToItem || {})
      .filter(([, it]: any) => it?.janCode === TARGET_JAN)
      .map(([id, it]: any) => ({ id, weight: it.weight }));

    // Document current (buggy) reality so the diagnosis is pinned.
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.weight).toBeFalsy();
    }
  });
});
