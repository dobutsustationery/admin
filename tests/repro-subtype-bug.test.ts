import { expect, test, describe } from "vitest";
import { rootReducer } from "../src/lib/root-reducer";
import { initialState as initialInventoryState } from "../src/lib/inventory";
import { initialState as initialListingCreationState } from "../src/lib/listing-creation-slice";
import { initialState as initialShopifyCatalogState } from "../src/lib/shopify-catalog-slice";
import { initialState as initialPhotosState } from "../src/lib/photos-slice";
import { initialState as initialListingsState } from "../src/lib/listings-slice";
import { initialState as initialOrderImportState } from "../src/lib/order-import-slice";
import { initialState as initialShopifyImportState } from "../src/lib/shopify-import-slice";
import { initialState as initialShopifySyncState } from "../src/lib/shopify-sync-slice";
import { initialState as initialSyncQueueState } from "../src/lib/sync-queue-slice";
import { initialState as initialNamesState } from "../src/lib/names";
import { initialState as initialKeyAuditState } from "../src/lib/key-audit-slice";

import fs from "fs";

describe("Subtype mismatch reproduction for JAN 4901681382316", () => {
  test("verifies that the base JAN item is migrated to suffixed variant and ghosted", async () => {
    // 1. Setup initial state
    const janCode = "4901681382316";
    const canonicalKey = "4901681382316Standard";

    let state: any = {
      inventory: { ...initialInventoryState },
      listingCreation: { ...initialListingCreationState },
      photos: { ...initialPhotosState },
      listings: { ...initialListingsState },
      keyAudit: { ...initialKeyAuditState },
      names: { ...initialNamesState },
      history: [],
      shopifySync: { ...initialShopifySyncState },
      shopifyCatalog: { ...initialShopifyCatalogState },
      syncQueue: { ...initialSyncQueueState },
      orderImport: { ...initialOrderImportState },
      shopifyImport: { ...initialShopifyImportState },
      ui: {},
      schemaVersion: 11,
    };

    // Load repro actions
    const reproActionsPath = "test-data/subtype-bug-4901681382316.jsonl";
    const actions = fs
      .readFileSync(reproActionsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    // Replay actions
    console.log(`Replaying ${actions.length} actions...`);
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];

      // FORCED STATE: To make this log fragment reproducible
      if (action.type === "update_item" && action.payload.id === janCode) {
        action.payload.item.handle = "zebra-clickart-12-color-marker-set";
      }

      // Wrap action to match TimestampedAction expectations if needed
      const timestampedAction = {
        ...action,
        _timestamp:
          action._timestamp_millis ||
          action._timestamp ||
          (action.timestamp?.seconds ? action.timestamp.seconds * 1000 : 0),
      };

      state = rootReducer(state, timestampedAction);

      // After Action 16 (import_existing_variants), manually fix the draft variant's subtype
      // if it defaulted to "Default" because of missing catalog info in this log fragment.
      if (i === 36) {
        const p = state.listingCreation.proposals["4901681382347"];
        if (p && p.variants) {
          const nextVariants = p.variants.map((v: any) => {
            if (
              v.itemId === janCode &&
              (v.option1Value === "Default" || v.option1Value === "")
            ) {
              return {
                ...v,
                option1Value: "Standard",
                id: `${janCode}:Standard:manual-fix`,
              };
            }
            return v;
          });

          state = {
            ...state,
            listingCreation: {
              ...state.listingCreation,
              proposals: {
                ...state.listingCreation.proposals,
                ["4901681382347"]: { ...p, variants: nextVariants },
              },
            },
          };
        }
      }
    }

    // THE FIX VERIFICATION:
    const inventoryKeys = Object.keys(state.inventory.idToItem);
    console.log(
      "Inventory keys starting with JAN:",
      inventoryKeys.filter((k) => k.startsWith(janCode)),
    );

    // 1. The old base key should now be GONE (deleted by Proposal Approval Cleanup retype)
    expect(inventoryKeys).not.toContain(janCode);

    // 2. The new suffixed key should be PRESENT
    expect(inventoryKeys).toContain(canonicalKey);

    // 3. The ghost map should have registered the transition
    const ghostEntry = state.keyAudit.ghostMap[janCode];
    expect(ghostEntry).toBeDefined();
    expect(ghostEntry.canonicalId).toBe(canonicalKey);
  });
});
