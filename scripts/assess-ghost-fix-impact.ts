// Replay the Apr 25 backup and report every retype_item where the new
// behavior credits a shipped counter that the previous reducer would have
// skipped (because the old key did not exist in idToItem at retype time).
//
// Run AFTER the fix is applied. The script does not need a parallel
// "unfixed" reducer — it derives the delta directly from the action stream
// and the pre-action idToItem snapshot, which is what the previous guard
// looked at.

import { readFileSync } from "fs";
import { rootReducer } from "../src/lib/root-reducer";

const BACKUP_PATH =
  "/Users/anicolao/projects/antigravity/production-backup-apr-25/firestore-export.json";

function tsKey(a: any): number {
  const ts = a?.timestamp;
  if (typeof ts?._seconds === "number")
    return ts._seconds * 1_000_000_000 + (Number(ts._nanoseconds) || 0);
  if (typeof ts?.seconds === "number")
    return ts.seconds * 1_000_000_000 + (Number(ts.nanoseconds) || 0);
  return 0;
}
function tsIso(a: any): string {
  const k = tsKey(a);
  return k ? new Date(Math.floor(k / 1_000_000)).toISOString() : "?";
}

const raw = readFileSync(BACKUP_PATH, "utf-8");
const backup = JSON.parse(raw);
const documents = backup.collections.broadcast.documents;
const actions = documents
  .map((d: any) => ({ id: d.id, ...d.data }))
  .sort((a: any, b: any) => tsKey(a) - tsKey(b));

let state: any = rootReducer(undefined, { type: "@@INIT" });

type Delta = {
  atIso: string;
  actionId: string;
  orderID: string;
  itemKey: string;
  newItemKey: string;
  qty: number;
  oldExistedBefore: boolean;
  newExistedBefore: boolean;
  oldExistedAfter: boolean;
  newExistedAfter: boolean;
  newShippedBefore: number | null;
  newShippedAfter: number | null;
  moveQty: number;
  fixCreditsTo: string | null;
};

const deltas: Delta[] = [];

for (const action of actions) {
  const preInv = state?.inventory?.idToItem || {};
  const preOrder = action?.payload?.orderID
    ? state?.inventory?.orderIdToOrder?.[action.payload.orderID]
    : null;
  let preNewShipped: number | null = null;
  let preNewExisted = false;
  let preOldExisted = false;
  let preMoveQty = 0;
  if (action.type === "retype_item") {
    const itemKey = action.payload?.itemKey;
    const newItemKey = (
      String(action.payload?.janCode || "").trim() +
      (action.payload?.subtype || "").trim()
    );
    preOldExisted = !!preInv[itemKey];
    preNewExisted = !!preInv[newItemKey];
    preNewShipped = preInv[newItemKey]
      ? Number(preInv[newItemKey].shipped || 0)
      : null;
    const oldLine = (preOrder?.items || []).find(
      (i: any) => i.itemKey === itemKey,
    );
    if (oldLine) {
      preMoveQty = Math.min(Number(oldLine.qty || 0), Number(action.payload?.qty || 0));
    }
  }

  try {
    state = rootReducer(state, action as any, () => {});
  } catch (e) {
    // ignore — match audit behavior
  }

  if (action.type === "retype_item") {
    const itemKey = action.payload?.itemKey;
    const newItemKey = (
      String(action.payload?.janCode || "").trim() +
      (action.payload?.subtype || "").trim()
    );
    const postInv = state?.inventory?.idToItem || {};
    const postNewShipped = postInv[newItemKey]
      ? Number(postInv[newItemKey].shipped || 0)
      : null;

    // The fix credits shipped to the new key when the old key did NOT exist
    // before the action, but the new key did, and the order line for the
    // old key contributed moveQty > 0. Detect that condition.
    let fixCreditsTo: string | null = null;
    if (preMoveQty > 0) {
      if (!preOldExisted && preNewExisted) {
        // Fix path: previous code skipped both; new code credits +moveQty to new.
        fixCreditsTo = newItemKey;
      } else if (preOldExisted && !preNewExisted) {
        // Edge of the same change: previous code skipped; new code subtracts moveQty
        // from old but leaves new alone (since new doesn't exist).
        fixCreditsTo = `-${itemKey}`;
      }
    }

    if (fixCreditsTo) {
      deltas.push({
        atIso: tsIso(action),
        actionId: action.id,
        orderID: action.payload?.orderID,
        itemKey,
        newItemKey,
        qty: Number(action.payload?.qty || 0),
        oldExistedBefore: preOldExisted,
        newExistedBefore: preNewExisted,
        oldExistedAfter: !!postInv[itemKey],
        newExistedAfter: !!postInv[newItemKey],
        newShippedBefore: preNewShipped,
        newShippedAfter: postNewShipped,
        moveQty: preMoveQty,
        fixCreditsTo,
      });
    }
  }
}

console.log(`Retype actions whose shipped behavior changes under the fix: ${deltas.length}`);
for (const d of deltas) {
  console.log(JSON.stringify(d));
}

// Net shipped delta per (key, sign) attributable to the fix
const netByKey: Record<string, number> = {};
for (const d of deltas) {
  if (d.fixCreditsTo?.startsWith("-")) {
    const k = d.fixCreditsTo.slice(1);
    netByKey[k] = (netByKey[k] || 0) - d.moveQty;
  } else if (d.fixCreditsTo) {
    netByKey[d.fixCreditsTo] = (netByKey[d.fixCreditsTo] || 0) + d.moveQty;
  }
}
console.log("\nNet shipped delta per key (post-fix minus pre-fix):");
for (const [k, v] of Object.entries(netByKey).sort()) {
  console.log(`  ${k}: ${v >= 0 ? "+" : ""}${v}`);
}

// Final shipped readings for the three remediation rows from the audit doc
const checks = [
  "4542804130904Swan",
  "4542804112832Strawberry",
  "4542804112832Cherry",
];
console.log("\nFinal shipped for audit's three remediation targets:");
for (const k of checks) {
  const item = state?.inventory?.idToItem?.[k];
  console.log(`  ${k}: shipped=${item?.shipped} qty=${item?.qty}`);
}

// Also confirm the audit page outcome counts
const events = state?.keyAudit?.ghostAccessEvents || [];
const counts: Record<string, number> = {};
for (const e of events) counts[e.outcome] = (counts[e.outcome] || 0) + 1;
console.log(`\nGhost access outcomes (audit-page view): ${JSON.stringify(counts)}`);
