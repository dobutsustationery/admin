import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { rootReducer } from "../src/lib/root-reducer";

// Diff logic to track state changes
type Value = boolean | number | string | undefined;
type Patch = { [k: string]: any } | Value | null;

function clone(o: any) {
  if (typeof o === "object" && o !== null) {
    const ret = Array.isArray(o) ? [...o] : { ...o };
    for (const k in ret) {
      ret[k] = clone(ret[k]);
    }
    return ret;
  }
  return o;
}

function diff<T extends Value | object>(a: T, b: T): Patch {
  if (a === b) {
    return null;
  }
  if (a === undefined || b === undefined) {
    return b;
  }
  if (a === null || b === null) {
    return b;
  }
  if (typeof a !== "object" || typeof b !== "object" || typeof b !== typeof a) {
    return b;
  }
  const oldA = a as Record<string, any>;
  const newA = b as Record<string, any>;
  const ret: { [k: string]: any } = {};
  let entries = 0;

  const keys = new Set<string>([...Object.keys(oldA), ...Object.keys(newA)]);

  for (const key of keys) {
    const hasNew = Object.prototype.hasOwnProperty.call(newA, key);
    if (!hasNew) {
      ++entries;
      ret[key] = null;
      continue;
    }
    const d = diff(oldA[key], newA[key]);
    if (d !== null) {
      ++entries;
      ret[key] = d;
    }
  }

  if (entries === 0) return null;
  return clone(ret);
}

const SHOPIFY_ACTION_TYPES = [
  "shopify_order_created",
  "shopify_order_updated",
  "shopify_order_cancelled",
  "shopify_refund_created",
  "shopify_order_reconciled",
];

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  console.log(`Connecting to Firestore emulator at ${host}...`);

  const app = initializeApp({ projectId: "dobutsu-admin" });
  const db = getFirestore(app);
  db.settings({ host, ssl: false });

  console.log("Fetching actions from broadcast collection...");
  const snapshot = await db
    .collection("broadcast")
    .orderBy("timestamp", "asc")
    .get();

  const actions = snapshot.docs.map((doc) => doc.data());
  console.log(`Found ${actions.length} actions in the log.`);

  const shopifyActionsCount = actions.filter((a) =>
    SHOPIFY_ACTION_TYPES.includes(a.type),
  ).length;
  console.log(`Found ${shopifyActionsCount} Shopify actions to dry-run.`);

  console.log("\nReplaying action log to reconstruct state...");
  let state = rootReducer(undefined, { type: "INIT" });

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const prevState = clone(state);
    
    try {
      state = rootReducer(state, action);
    } catch (e) {
      console.error(`Error processing action ${i + 1} (${action.type}):`, e);
      continue;
    }

    if (SHOPIFY_ACTION_TYPES.includes(action.type)) {
      const orderId = action.payload?.raw?.id || "Unknown";
      console.log(`\n--- Dry Run: ${action.type} (Order ID: ${orderId}) ---`);
      
      const inventoryPatch = diff(prevState.inventory, state.inventory);
      
      if (inventoryPatch === null) {
        console.log(`Order ${orderId}: No inventory state changes would occur.`);
      } else {
        let hasMeaningfulChange = false;

        // Summarize item updates (e.g. shipped counts)
        if (inventoryPatch.idToItem) {
          for (const itemKey of Object.keys(inventoryPatch.idToItem)) {
            const itemDiff = inventoryPatch.idToItem[itemKey];
            if (itemDiff === null) continue;
            
            const prevItem = prevState.inventory.idToItem[itemKey];
            const nextItem = state.inventory.idToItem[itemKey];
            
            if (itemDiff.shipped !== undefined) {
              const oldShipped = prevItem ? prevItem.shipped : 0;
              const newShipped = nextItem ? nextItem.shipped : 0;
              const delta = newShipped - oldShipped;
              
              if (delta > 0) {
                console.log(`  -> Would INCREASE shipped count of ${itemKey} by ${delta} (from ${oldShipped} to ${newShipped})`);
                hasMeaningfulChange = true;
              } else if (delta < 0) {
                console.log(`  -> Would DECREASE shipped count of ${itemKey} by ${Math.abs(delta)} (from ${oldShipped} to ${newShipped})`);
                hasMeaningfulChange = true;
              }
            }
          }
        }

        // Check if there were exceptions recorded
        if (inventoryPatch.shopifyExceptions && inventoryPatch.shopifyExceptions[`shopify:${orderId}`]) {
           const exceptions = state.inventory.shopifyExceptions[`shopify:${orderId}`];
           if (exceptions && exceptions.length > 0) {
             console.log(`  -> Would record exceptions:`);
             for (const ex of exceptions) {
                console.log(`       - ${ex}`);
             }
             hasMeaningfulChange = true;
           }
        }

        if (!hasMeaningfulChange) {
           console.log(`Order ${orderId}: Only internal metadata (like facts or history) would change.`);
        }
      }
    }
  }

  console.log("\nDry run complete. No actions were broadcasted or written to Firestore.");
}

main().catch(console.error);
