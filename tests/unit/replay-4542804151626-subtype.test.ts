import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { rootReducer } from "$lib/root-reducer";
import { makeInventoryItemKey } from "$lib/sku";

const JAN = "4542804151626";

function loadReplayActions() {
  const filePath = join(
    process.cwd(),
    "test-data",
    "4542804151626-subtype.jsonl",
  );
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("Replay 4542804151626 subtype creation", () => {
  it("ends with Blue and Green subtype items attached to the listing", () => {
    const actions = loadReplayActions();
    let state = rootReducer(undefined, { type: "@@INIT" });

    for (const action of actions) {
      state = rootReducer(state, action);
    }

    const blueKey = makeInventoryItemKey(JAN, "Blue");
    const greenKey = makeInventoryItemKey(JAN, "Green");

    const items = state.inventory.idToItem;
    const subtypeKeysForJan = Object.keys(items).filter((k) =>
      k.startsWith(JAN),
    );

    expect(
      items[blueKey],
      `Expected Blue subtype at ${blueKey}. Existing keys for JAN: ${subtypeKeysForJan.join(", ") || "(none)"}`,
    ).toBeDefined();
    expect(items[blueKey].subtype).toBe("Blue");

    expect(
      items[greenKey],
      `Expected Green subtype at ${greenKey}. Existing keys for JAN: ${subtypeKeysForJan.join(", ") || "(none)"}`,
    ).toBeDefined();
    expect(items[greenKey].subtype).toBe("Green");

    const handle = "amifa-arctic-animals-sparkle-stickers-20-4542804151626";
    expect(state.listings.idToHandle[blueKey]).toBe(handle);
    expect(state.listings.idToHandle[greenKey]).toBe(handle);
    expect(state.listings.idToHandle[JAN]).toBeUndefined();
  });
});
