import { describe, expect, it } from "vitest";
import { rootReducer as _rootReducer } from "$lib/root-reducer";
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
import { makeInventoryItemKey } from "$lib/sku";
import { readFileSync } from "fs";
import { join } from "path";

describe("Replay Toile SKU Fail", () => {
  it("synchronizes item description with listing title after approval replay", () => {
    const filePath = join(process.cwd(), "test-data", "toile-sku-fail.jsonl");
    const content = readFileSync(filePath, "utf-8");
    const lines = content
      .split(String.fromCharCode(10))
      .filter((l) => l.trim());

    let state = rootReducer(undefined, { type: "INIT" });

    lines.forEach((line) => {
      const action = JSON.parse(line);
      state = rootReducer(state, action);
    });

    // Verification
    const listingHandle = "dobutsu-toile-stationery-pouch-4542804117844";
    const listing = state.listings.handleToListing[listingHandle];
    expect(listing).toBeDefined();
    expect(listing.title).toBe("Dobutsu Toile Stationery Pouch");

    const blueVariantId = makeInventoryItemKey(
      "4542804117844",
      "Blue Toile Pattern",
    );
    const blueItem = state.inventory.idToItem[blueVariantId];
    expect(blueItem).toBeDefined();
    expect(blueItem.description).toBe(listing.title);

    const brownVariantId = makeInventoryItemKey(
      "4542804117844",
      "Brown Toile Pattern",
    );
    const brownItem = state.inventory.idToItem[brownVariantId];
    expect(brownItem).toBeDefined();
    expect(brownItem.description).toBe(listing.title);
  });
});
