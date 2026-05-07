// Investigate ghost access outcomes by replaying the production backup
// (../production-backup-apr-25/firestore-export.json) through rootReducer.
//
// This script does NOT modify state in production; it just runs the same
// pure replay the audit page does, and reports a summary plus the
// "missing" rows of state.keyAudit.ghostAccessEvents.

import { readFileSync } from "fs";
import { rootReducer } from "../src/lib/root-reducer";

const BACKUP_PATH =
  "/Users/anicolao/projects/antigravity/production-backup-apr-25/firestore-export.json";

interface BackupAction {
  id: string;
  data: {
    type: string;
    payload?: any;
    creator?: string;
    timestamp?: {
      _timestamp?: boolean;
      _seconds: number;
      _nanoseconds: number;
    };
  };
}

function tsKey(a: any): number {
  const ts = a?.timestamp;
  if (typeof ts?._seconds === "number") {
    return (
      ts._seconds * 1_000_000_000 + (Number(ts._nanoseconds) || 0)
    );
  }
  if (typeof ts?.seconds === "number") {
    return ts.seconds * 1_000_000_000 + (Number(ts.nanoseconds) || 0);
  }
  return 0;
}

console.log(`Loading ${BACKUP_PATH}...`);
const raw = readFileSync(BACKUP_PATH, "utf-8");
const backup = JSON.parse(raw);
const documents: BackupAction[] = backup.collections.broadcast.documents;
console.log(`Read ${documents.length} broadcast documents.`);

const actions = documents
  .map((d) => ({ id: d.id, ...d.data }))
  .sort((a, b) => tsKey(a) - tsKey(b));

console.log(`Replaying ${actions.length} actions...`);
let state: any = rootReducer(undefined, { type: "@@INIT" });
const t0 = Date.now();
for (let i = 0; i < actions.length; i++) {
  try {
    state = rootReducer(state, actions[i] as any, () => {});
  } catch (e) {
    // Mirror audit page behavior: tolerate replay errors per action.
    console.warn(
      `Replay error on action ${i} (${(actions[i] as any)?.type}):`,
      (e as Error).message,
    );
  }
  if ((i + 1) % 5000 === 0) {
    console.log(`  ${i + 1}/${actions.length} replayed`);
  }
}
console.log(`Replay finished in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

const keyAudit = state?.keyAudit;
if (!keyAudit) {
  console.error("No keyAudit slice in final state.");
  process.exit(1);
}

const events = keyAudit.ghostAccessEvents || [];
const outcomeCounts: Record<string, number> = {};
const knownGhostByOutcome: Record<string, number> = {};
for (const e of events) {
  outcomeCounts[e.outcome] = (outcomeCounts[e.outcome] || 0) + 1;
  if (e.knownGhost) {
    knownGhostByOutcome[e.outcome] =
      (knownGhostByOutcome[e.outcome] || 0) + 1;
  }
}

console.log("\nGhost access events:", events.length);
console.log("Outcome counts:", outcomeCounts);
console.log("knownGhost=true counts by outcome:", knownGhostByOutcome);

const missing = events.filter((e: any) => e.outcome === "missing");
console.log(`\nMissing rows (${missing.length}):`);
for (const e of missing) {
  const at = new Date(e.atMs).toISOString();
  console.log(
    JSON.stringify({
      atMs: at,
      actionType: e.actionType,
      actionPath: e.actionPath,
      requestedId: e.requestedId,
      canonicalCandidate: e.canonicalCandidate,
      knownGhost: e.knownGhost,
      mappedCanonicalId: e.mappedCanonicalId,
    }),
  );
}

const ghostMapSize = Object.keys(keyAudit.ghostMap || {}).length;
const collisionCount = Object.keys(keyAudit.canonicalCollisions || {}).length;
console.log(`\nghostMap entries: ${ghostMapSize}`);
console.log(`canonicalCollisions: ${collisionCount}`);
