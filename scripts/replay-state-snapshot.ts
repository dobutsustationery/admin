// Replay the production backup through the current rootReducer and
// snapshot the resulting state to /tmp/replay-state-<label>.json so we
// can diff before/after a reducer-side change.
//
// Usage:
//   bun scripts/replay-state-snapshot.ts before
//   bun scripts/replay-state-snapshot.ts after

import { readFileSync, writeFileSync } from "fs";
import { rootReducer } from "../src/lib/root-reducer";

const BACKUP_PATH =
  "/Users/anicolao/projects/antigravity/production-backup-apr-25/firestore-export.json";

const label = process.argv[2];
if (!label) {
  console.error("Usage: bun scripts/replay-state-snapshot.ts <label>");
  process.exit(1);
}

interface BackupAction {
  id: string;
  data: any;
}

function tsKey(a: any): number {
  const ts = a?.timestamp;
  if (typeof ts?._seconds === "number") {
    return ts._seconds * 1_000_000_000 + (Number(ts._nanoseconds) || 0);
  }
  if (typeof ts?.seconds === "number") {
    return ts.seconds * 1_000_000_000 + (Number(ts.nanoseconds) || 0);
  }
  return 0;
}

console.error(`Loading ${BACKUP_PATH}…`);
const raw = readFileSync(BACKUP_PATH, "utf-8");
const backup = JSON.parse(raw);
const documents: BackupAction[] = backup.collections.broadcast.documents;
console.error(`Read ${documents.length} broadcast documents.`);

const actions = documents
  .map((d) => ({ id: d.id, ...d.data }))
  .sort((a: any, b: any) => tsKey(a) - tsKey(b));

console.error(`Replaying ${actions.length} actions…`);
let state: any = rootReducer(undefined, { type: "@@INIT" });
const t0 = Date.now();
for (let i = 0; i < actions.length; i++) {
  try {
    state = rootReducer(state, actions[i] as any, () => {});
  } catch (e) {
    // Mirror audit page: tolerate per-action errors.
    console.error(
      `Replay error on action ${i} (${(actions[i] as any)?.type}):`,
      (e as Error).message,
    );
  }
  if ((i + 1) % 5000 === 0) {
    console.error(`  ${i + 1}/${actions.length}`);
  }
}
console.error(`Replay finished in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

// Build a compact snapshot suitable for diffing.
const items = state?.inventory?.idToItem || {};
const inventoryRows: Record<string, any> = {};
for (const [key, val] of Object.entries(items)) {
  const it = val as any;
  inventoryRows[key] = {
    janCode: it.janCode,
    subtype: it.subtype,
    qty: it.qty,
    shipped: it.shipped,
    handle: it.handle || "",
    price: it.price ?? null,
  };
}

const orderIds = Object.keys(state?.inventory?.orderIdToOrder || {});
const orderKeyCounts: Record<string, number> = {};
for (const id of orderIds) {
  const prefix = id.split(":")[0] || "(other)";
  orderKeyCounts[prefix] = (orderKeyCounts[prefix] || 0) + 1;
}

// Per-prefix order-item key churn would balloon the snapshot.  Just track
// a count of order line items referencing each inventory key.
const orderRefsByItemKey: Record<string, number> = {};
for (const id of orderIds) {
  const order = state.inventory.orderIdToOrder[id];
  for (const line of order.items || []) {
    const k = line.itemKey || "";
    orderRefsByItemKey[k] = (orderRefsByItemKey[k] || 0) + Number(line.qty || 0);
  }
}

const keyAudit = state?.keyAudit || {};
const audit = {
  ghostMap: Object.keys(keyAudit.ghostMap || {}).length,
  ghostAccessEvents: (keyAudit.ghostAccessEvents || []).length,
  ghostAccessByOutcome: ((keyAudit.ghostAccessEvents || []) as any[]).reduce(
    (acc: Record<string, number>, ev: any) => {
      acc[ev.outcome] = (acc[ev.outcome] || 0) + 1;
      return acc;
    },
    {},
  ),
  canonicalCollisions: Object.keys(keyAudit.canonicalCollisions || {}).length,
};

const snapshot = {
  label,
  capturedAt: new Date().toISOString(),
  totals: {
    inventoryItems: Object.keys(inventoryRows).length,
    orders: orderIds.length,
    orderRefs: Object.keys(orderRefsByItemKey).length,
  },
  audit,
  orderKeyCounts,
  inventoryRows,
  orderRefsByItemKey,
};

const outPath = `/tmp/replay-state-${label}.json`;
writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
console.error(`\nSnapshot written to ${outPath}`);
console.error("Totals:", snapshot.totals);
console.error("Audit:", snapshot.audit);
