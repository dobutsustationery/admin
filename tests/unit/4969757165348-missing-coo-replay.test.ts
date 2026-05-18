import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { rootReducer } from "$lib/root-reducer";

const TARGET_JAN = "4969757165348";

function replayFixture() {
  const actions = readFileSync(
    join(process.cwd(), "test-data", "4969757165348-missing-coo.jsonl"),
    "utf-8",
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  let state: any = rootReducer(undefined, { type: "@@INIT" });
  for (const action of actions) {
    state = rootReducer(state, action);
  }
  return state;
}

describe("4969757165348 COO/weight replay", () => {
  it("preserves missing COO and weight from stock-order metadata", () => {
    const state = replayFixture();
    const items = Object.entries(state.inventory?.idToItem || {})
      .filter(([, item]: any) => item?.janCode === TARGET_JAN)
      .map(([id, item]: any) => ({
        id,
        countryOfOrigin: item.countryOfOrigin,
        weight: item.weight,
      }));

    expect(items).toEqual(
      expect.arrayContaining([
        {
          id: `${TARGET_JAN}Blue`,
          countryOfOrigin: "JAPAN",
          weight: 25,
        },
        {
          id: `${TARGET_JAN}Purple`,
          countryOfOrigin: "JAPAN",
          weight: 25,
        },
      ]),
    );
  });
});
