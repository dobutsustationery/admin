// For each "missing" ghost-access event in the production replay, capture
// the full action, the relevant snapshot of state at the time the event was
// recorded, and the corresponding final state — so we can audit whether the
// silent miss had any real effect on realized inventory state.

import { readFileSync, writeFileSync } from "fs";
import { rootReducer } from "../src/lib/root-reducer";

const BACKUP_PATH =
  "/Users/anicolao/projects/antigravity/production-backup-apr-25/firestore-export.json";

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

function tsIso(a: any): string {
  const k = tsKey(a);
  if (!k) return "?";
  return new Date(Math.floor(k / 1_000_000)).toISOString();
}

function janOf(id: string): string | null {
  const m = (id || "").match(/^(\d+)/);
  return m ? m[1] : null;
}

function fieldOf(state: any, key: string, field?: string) {
  const item = state?.inventory?.idToItem?.[key];
  if (!item) return undefined;
  if (!field) {
    const { qty, shipped, hsCode, image, subtype, description } = item;
    return { qty, shipped, hsCode, image, subtype, description };
  }
  return item[field];
}

function snapshotForJan(state: any, jan: string, field?: string) {
  const items = state?.inventory?.idToItem || {};
  const out: Record<string, any> = {};
  for (const key of Object.keys(items)) {
    if (key.startsWith(jan)) {
      out[key] = field ? items[key][field] : fieldOf(state, key);
    }
  }
  return out;
}

function ghostsForJan(state: any, jan: string) {
  const gm = state?.keyAudit?.ghostMap || {};
  const out: Record<string, any> = {};
  for (const key of Object.keys(gm)) {
    if (key.startsWith(jan)) {
      out[key] = gm[key];
    }
  }
  return out;
}

console.error(`Loading ${BACKUP_PATH}...`);
const raw = readFileSync(BACKUP_PATH, "utf-8");
const backup = JSON.parse(raw);
const documents: BackupAction[] = backup.collections.broadcast.documents;
console.error(`Read ${documents.length} broadcast documents.`);

const actions = documents
  .map((d) => ({ id: d.id, ...d.data }))
  .sort((a: any, b: any) => tsKey(a) - tsKey(b));

// First pass: replay through everything, but at every action, after applying it,
// check if any new ghostAccessEvent with outcome="missing" was added; if so,
// snapshot pre/post state for the JAN.
let state: any = rootReducer(undefined, { type: "@@INIT" });
let lastAccessLen = 0;

const missingRecords: any[] = [];

for (let i = 0; i < actions.length; i++) {
  const action: any = actions[i];

  const preState = state;

  try {
    state = rootReducer(state, action, () => {});
  } catch (e) {
    console.error(
      `Replay error on ${action.id} (${action?.type}):`,
      (e as Error).message,
    );
  }

  const events = state?.keyAudit?.ghostAccessEvents || [];
  if (events.length > lastAccessLen) {
    const newOnes = events.slice(lastAccessLen);
    lastAccessLen = events.length;
    for (const ev of newOnes) {
      if (ev.outcome !== "missing") continue;
      const jan = janOf(ev.requestedId) || "";
      const field = action?.payload?.field;
      const orderID = action?.payload?.orderID;
      const preOrder = orderID
        ? preState?.inventory?.orderIdToOrder?.[orderID]
        : undefined;
      missingRecords.push({
        atIso: tsIso(action),
        actionType: action.type,
        actionPath: ev.actionPath,
        actionId: action.id,
        actionPayload: action.payload,
        requestedId: ev.requestedId,
        canonicalCandidate: ev.canonicalCandidate,
        knownGhost: ev.knownGhost,
        mappedCanonicalId: ev.mappedCanonicalId,
        // Pre-state snapshot for the JAN, focused on the relevant field if any.
        preStateField: field,
        preStateForJan: snapshotForJan(preState, jan, field),
        preGhostsForJan: ghostsForJan(preState, jan),
        orderID,
        preOrderItems: preOrder ? preOrder.items : undefined,
      });
    }
  }
  if ((i + 1) % 5000 === 0) console.error(`  ${i + 1}/${actions.length}`);
}

// Now state is final. Add post (final) snapshot to each record.
for (const rec of missingRecords) {
  const jan = janOf(rec.requestedId) || "";
  rec.finalStateForJan = snapshotForJan(state, jan, rec.preStateField);
  if (rec.orderID) {
    const finalOrder = state?.inventory?.orderIdToOrder?.[rec.orderID];
    rec.finalOrderItems = finalOrder ? finalOrder.items : undefined;
  }
  // Did the rename target receive the same value the action wanted?
  if (rec.actionPayload?.field && rec.actionPayload?.to !== undefined) {
    const target = rec.mappedCanonicalId
      ? state?.inventory?.idToItem?.[rec.mappedCanonicalId]
      : undefined;
    rec.targetCurrentValue = target ? target[rec.actionPayload.field] : null;
    rec.targetExists = !!target;
    rec.intentSatisfied =
      target && target[rec.actionPayload.field] === rec.actionPayload.to;
  }
}

console.error(`\nMissing records: ${missingRecords.length}`);

const outPath = `/tmp/audit-missing-15.json`;
writeFileSync(outPath, JSON.stringify(missingRecords, null, 2));
console.error(`Wrote ${outPath}`);

// Also print a compact, human-readable table to stderr.
console.error("\nCompact summary:");
for (const r of missingRecords) {
  console.error(
    `${r.atIso}  ${r.actionType.padEnd(14)} requested=${r.requestedId}  mapped=${r.mappedCanonicalId || "-"}`,
  );
  console.error(
    `   payload=${JSON.stringify(r.actionPayload)}`,
  );
  console.error(
    `   preState[${r.preStateField || "*"}] for JAN: ${JSON.stringify(r.preStateForJan)}`,
  );
  console.error(
    `   final[${r.preStateField || "*"}] for JAN: ${JSON.stringify(r.finalStateForJan)}`,
  );
  if (r.actionPayload?.field) {
    console.error(
      `   target=${r.mappedCanonicalId} exists=${r.targetExists} value=${JSON.stringify(r.targetCurrentValue)} intentSatisfied=${r.intentSatisfied}`,
    );
  }
  console.error("");
}
