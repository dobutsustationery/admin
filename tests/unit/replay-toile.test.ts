import { describe, expect, it } from "vitest";
import { rootReducer } from "$lib/root-reducer";
import { readFileSync } from "fs";
import { join } from "path";

describe("Replay Toile SKU Fail", () => {
  it("synchronizes item description with listing title after approval replay", () => {
    const filePath = join(process.cwd(), "test-data", "toile-sku-fail.jsonl");
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split(String.fromCharCode(10)).filter(l => l.trim());

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

    const blueVariantId = "4542804117844BlueToilePattern";
    const blueItem = state.inventory.idToItem[blueVariantId];
    expect(blueItem).toBeDefined();
    expect(blueItem.description).toBe(listing.title);

    const brownVariantId = "4542804117844BrownToilePattern";
    const brownItem = state.inventory.idToItem[brownVariantId];
    expect(brownItem).toBeDefined();
    expect(brownItem.description).toBe(listing.title);
  });
});