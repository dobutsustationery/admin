import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { rootReducer } from "$lib/root-reducer";
import { makeInventoryItemKey } from "$lib/sku";
import { update_item, type Item } from "$lib/inventory";

const JAN = "4542804126211";
const SUSHI_VARIANT_ID = "4542804126211:Sushi:f9be83c5";
const TEA_VARIANT_ID = "4542804126211:Spa:6988fd32";

function loadReplayActions() {
  const filePath = join(
    process.cwd(),
    "test-data",
    "shiba-inu",
    "listing-creation-replay.min.jsonl",
  );
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function seedSourceInventory(state: any) {
  const sourceItem: Item = {
    janCode: JAN,
    subtype: "",
    description: "Shiba Inu Ziplock Bags",
    hsCode: "39232990",
    image: "https://example.com/shiba.jpg",
    qty: 24,
    pieces: 1,
    shipped: 0,
    creationDate: "2026-02-21",
    timestamp: 1771738000000,
  };
  return rootReducer(state, update_item({ id: JAN, item: sourceItem }));
}

describe("Replay Shiba Ziplock quantity bugs", () => {
  it("auto-populates split allocations in draft state (12/12 for shiba ziplock)", () => {
    const actions = loadReplayActions();
    let state = rootReducer(undefined, { type: "@@INIT" });
    state = seedSourceInventory(state);

    for (const action of actions) {
      state = rootReducer(state, action);
    }

    const proposal = state.listingCreation.proposals[JAN];
    expect(proposal).toBeDefined();

    const tea = proposal.variants.find((v: any) => v.id === TEA_VARIANT_ID);
    const sushi = proposal.variants.find((v: any) => v.id === SUSHI_VARIANT_ID);
    expect(tea).toBeDefined();
    expect(sushi).toBeDefined();

    // Desired behavior: initial split should persist explicit allocations in state.
    expect(tea.qty).toBe(12);
    expect(sushi.qty).toBe(12);
  });

  it("keeps both variant quantities when approving the shiba ziplock draft", () => {
    const actions = loadReplayActions();
    let state = rootReducer(undefined, { type: "@@INIT" });
    state = seedSourceInventory(state);

    for (const action of actions) {
      state = rootReducer(state, action);
    }

    // Simulate the user's manual correction to 12 + 12 before approving.
    state = rootReducer(state, {
      type: "listingCreation/update_variant_qty",
      payload: { janCode: JAN, variantId: TEA_VARIANT_ID, qty: 12 },
    });

    state = rootReducer(state, {
      type: "listingCreation/approve_proposal",
      payload: { janCode: JAN },
    });

    const sushiKey = makeInventoryItemKey(JAN, "Sushi");
    const teaKey = makeInventoryItemKey(JAN, "Tea");

    expect(state.inventory.idToItem[sushiKey]).toBeDefined();
    expect(state.inventory.idToItem[teaKey]).toBeDefined();

    // User-edited state before approval is 12 + 12; approval should preserve both.
    expect(state.inventory.idToItem[sushiKey].qty).toBe(12);
    expect(state.inventory.idToItem[teaKey].qty).toBe(12);
  });
});
