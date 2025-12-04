import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InventoryState } from "$lib/inventory";
import { initialState, inventory } from "$lib/inventory";
import { describe, expect, it } from "vitest";

interface FirestoreTimestamp {
  _timestamp: boolean;
  _seconds: number;
  _nanoseconds: number;
}

interface BroadcastAction {
  id: string;
  data: {
    type: string;
    payload: any;
    creator: string;
    timestamp: FirestoreTimestamp;
  };
}

interface FirestoreExport {
  exportedAt: string;
  collections: {
    broadcast: BroadcastAction[];
  };
}

// Inventory action types handled by the inventory reducer
const INVENTORY_ACTION_TYPES = new Set([
  "update_item",
  "update_field",
  "new_order",
  "package_item",
  "quantify_item",
  "retype_item",
  "rename_subtype",
  "delete_empty_order",
  "archive_inventory",
  "hide_archive",
  "make_sales",
]);

/**
 * Converts a Firestore timestamp to the format expected by the reducer
 */
function convertTimestamp(timestamp: FirestoreTimestamp) {
  return {
    seconds: timestamp._seconds,
    nanoseconds: timestamp._nanoseconds,
  };
}

/**
 * Loads the test data from the firestore-export.json file
 */
function loadTestData(): BroadcastAction[] {
  const testDataPath = join(
    process.cwd(),
    "test-data",
    "firestore-export.json",
  );
  const fileContent = readFileSync(testDataPath, "utf-8");
  const data: FirestoreExport = JSON.parse(fileContent);
  return data.collections.broadcast;
}

describe("inventory reducer immutability", () => {
  it("maintains immutability across all 3700 actions - verifies state objects change", () => {
    // Load test data
    const actions = loadTestData();
    expect(actions.length).toBe(3700);

    // Sort actions by timestamp to ensure correct order
    const sortedActions = [...actions].sort((a, b) => {
      const tsA = a.data.timestamp?._seconds || 0;
      const tsB = b.data.timestamp?._seconds || 0;
      if (tsA !== tsB) return tsA - tsB;
      return (
        (a.data.timestamp?._nanoseconds || 0) -
        (b.data.timestamp?._nanoseconds || 0)
      );
    });

    // Filter to inventory-related actions
    const inventoryActions = sortedActions.filter((action) =>
      INVENTORY_ACTION_TYPES.has(action.data.type),
    );

    console.log(
      `\nTesting immutability across ${inventoryActions.length} actions...`,
    );

    // Track all state references to ensure they're all different
    const stateReferences = new Set<InventoryState>();
    let state = initialState;
    stateReferences.add(state);

    let stateChanges = 0;
    let stateReused = 0;
    let duplicateReferences = 0;

    const startTime = performance.now();

    // Process each action and verify new state objects are created
    for (let i = 0; i < inventoryActions.length; i++) {
      const action = inventoryActions[i];
      const reduxAction = {
        type: action.data.type,
        payload: action.data.payload,
        timestamp: action.data.timestamp
          ? convertTimestamp(action.data.timestamp)
          : undefined,
      };

      const previousState = state;
      const newState = inventory(state, reduxAction);

      // Check if state reference changed (it should for most actions)
      if (newState !== previousState) {
        stateChanges++;

        // Verify this state reference hasn't been seen before
        if (stateReferences.has(newState)) {
          duplicateReferences++;
          console.error(
            `❌ Duplicate state reference at action ${i} (${action.data.type})`,
          );
        } else {
          stateReferences.add(newState);
        }
      } else {
        stateReused++;
      }

      state = newState;

      // Progress indicator
      if ((i + 1) % 1000 === 0) {
        console.log(`  Processed ${i + 1}/${inventoryActions.length} actions`);
      }
    }

    const endTime = performance.now();
    const elapsedTime = endTime - startTime;

    console.log(`\n=== Immutability Test Results ===`);
    console.log(`Total actions processed: ${inventoryActions.length}`);
    console.log(`Processing time: ${elapsedTime.toFixed(2)}ms`);
    console.log(`Unique state objects: ${stateReferences.size}`);
    console.log(`State changes (new object): ${stateChanges}`);
    console.log(`State reused (same object): ${stateReused}`);
    console.log(`Duplicate references: ${duplicateReferences}`);
    console.log(
      `Change rate: ${((stateChanges / inventoryActions.length) * 100).toFixed(1)}%`,
    );

    if (duplicateReferences > 0) {
      console.error(`\n❌ IMMUTABILITY TEST FAILED`);
      console.error(
        `Found ${duplicateReferences} cases where a state reference was reused`,
      );
    } else if (stateChanges < inventoryActions.length * 0.5) {
      console.error(`\n⚠️  WARNING: Low state change rate`);
      console.error(
        `Only ${((stateChanges / inventoryActions.length) * 100).toFixed(1)}% of actions created new state`,
      );
    } else {
      console.log(`\n✅ IMMUTABILITY TEST PASSED`);
      console.log(
        `All state changes created new objects (${stateReferences.size} unique states)`,
      );
    }

    // Verify final state is valid
    expect(Object.keys(state.idToItem).length).toBeGreaterThan(0);
    expect(Object.keys(state.idToHistory).length).toBeGreaterThan(0);

    // Assert no duplicate references (immutability violation)
    expect(duplicateReferences).toBe(0);

    // Most actions should create new state objects
    expect(stateChanges).toBeGreaterThan(inventoryActions.length * 0.5);
  });

  it("verifies nested object immutability with spot checks", () => {
    // This test does deeper immutability checks on a sample of actions
    const actions = loadTestData();
    const sortedActions = [...actions].sort((a, b) => {
      const tsA = a.data.timestamp?._seconds || 0;
      const tsB = b.data.timestamp?._seconds || 0;
      if (tsA !== tsB) return tsA - tsB;
      return (
        (a.data.timestamp?._nanoseconds || 0) -
        (b.data.timestamp?._nanoseconds || 0)
      );
    });

    const inventoryActions = sortedActions
      .filter((action) => INVENTORY_ACTION_TYPES.has(action.data.type))
      .slice(0, 500); // Test first 500 actions for deeper checks

    console.log(
      `\nTesting nested immutability for ${inventoryActions.length} actions...`,
    );

    let state = initialState;
    let violations = 0;

    for (let i = 0; i < inventoryActions.length; i++) {
      const action = inventoryActions[i];
      const reduxAction = {
        type: action.data.type,
        payload: action.data.payload,
        timestamp: action.data.timestamp
          ? convertTimestamp(action.data.timestamp)
          : undefined,
      };

      const previousState = state;
      const newState = inventory(state, reduxAction);

      // If state changed, verify nested objects also changed where modified
      if (newState !== previousState && action.data.type === "update_item") {
        const itemId = action.data.payload.id;

        // If the item exists in both states, the reference should be different
        if (previousState.idToItem[itemId] && newState.idToItem[itemId]) {
          if (previousState.idToItem[itemId] === newState.idToItem[itemId]) {
            violations++;
            console.error(
              `❌ Item ${itemId} was mutated in place at action ${i}`,
            );
          }
        }
      }

      state = newState;

      if ((i + 1) % 100 === 0) {
        console.log(`  Checked ${i + 1}/${inventoryActions.length} actions`);
      }
    }

    console.log(`\n=== Nested Immutability Results ===`);
    console.log(`Actions checked: ${inventoryActions.length}`);
    console.log(`Nested violations: ${violations}`);

    if (violations === 0) {
      console.log(`✅ No nested object mutations detected`);
    }

    expect(violations).toBe(0);
  });
});
