// Dump all broadcast actions referencing a given JAN (substring match), sorted
// ascending by timestamp. Also runs a focused replay tracking just that JAN's
// state and prints the relevant transitions.

import { readFileSync } from "fs";
import { rootReducer } from "../src/lib/root-reducer";

const BACKUP_PATH =
  "/Users/anicolao/projects/antigravity/production-backup-apr-25/firestore-export.json";

const JAN = process.argv[2] || "4542804044119";

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

console.error(`Loading ${BACKUP_PATH}...`);
const raw = readFileSync(BACKUP_PATH, "utf-8");
const backup = JSON.parse(raw);
const documents: BackupAction[] = backup.collections.broadcast.documents;
console.error(`Read ${documents.length} broadcast documents.`);

const allActions = documents
  .map((d) => ({ id: d.id, ...d.data }))
  .sort((a: any, b: any) => tsKey(a) - tsKey(b));

const matches = allActions.filter((a: any) =>
  JSON.stringify(a).includes(JAN),
);
console.error(
  `\nActions referencing "${JAN}": ${matches.length} of ${allActions.length}`,
);

// Track per-action the keys for this JAN in state.idToItem and the relevant
// fragments of state.keyAudit.
let state: any = rootReducer(undefined, { type: "@@INIT" });
const matchSet = new Set(matches.map((a: any) => a.id));

const trace: any[] = [];
for (let i = 0; i < allActions.length; i++) {
  const action: any = allActions[i];
  const beforeKeys = state?.inventory?.idToItem
    ? Object.keys(state.inventory.idToItem).filter((k) => k.includes(JAN))
    : [];
  const beforeGhostMap = state?.keyAudit?.ghostMap || {};
  const beforeGhostsForJan = Object.keys(beforeGhostMap).filter((k) =>
    k.includes(JAN),
  );
  const beforeAccessLen = state?.keyAudit?.ghostAccessEvents?.length || 0;

  try {
    state = rootReducer(state, action, () => {});
  } catch (e) {
    console.error(`Replay error on ${action.id}:`, (e as Error).message);
  }

  const afterKeys = state?.inventory?.idToItem
    ? Object.keys(state.inventory.idToItem).filter((k) => k.includes(JAN))
    : [];
  const afterGhostMap = state?.keyAudit?.ghostMap || {};
  const afterGhostsForJan = Object.keys(afterGhostMap).filter((k) =>
    k.includes(JAN),
  );
  const newAccessEvents = (state?.keyAudit?.ghostAccessEvents || []).slice(
    beforeAccessLen,
  );
  const accessEventsForJan = newAccessEvents.filter(
    (e: any) =>
      e?.requestedId?.includes(JAN) ||
      e?.canonicalCandidate?.includes(JAN) ||
      e?.mappedCanonicalId?.includes(JAN),
  );

  const becameGhost = afterGhostsForJan.filter(
    (g) => !beforeGhostsForJan.includes(g),
  );
  const inventoryAdded = afterKeys.filter((k) => !beforeKeys.includes(k));
  const inventoryRemoved = beforeKeys.filter((k) => !afterKeys.includes(k));

  const isMatch = matchSet.has(action.id);
  if (
    isMatch ||
    becameGhost.length ||
    inventoryAdded.length ||
    inventoryRemoved.length ||
    accessEventsForJan.length
  ) {
    trace.push({
      i,
      id: action.id,
      type: action.type,
      at: tsIso(action),
      isMatchByPayload: isMatch,
      beforeKeys,
      afterKeys,
      inventoryAdded,
      inventoryRemoved,
      beforeGhostsForJan,
      afterGhostsForJan,
      becameGhost,
      newGhostAccessForJan: accessEventsForJan,
      // Deep dump of action so we can inspect payload fully.
      action,
    });
  }
}

console.error(
  `\nTrace entries: ${trace.length} (matches by payload: ${matches.length})`,
);

// Print as JSON to stdout for downstream tooling; also human-friendly summary
// to stderr.
console.error(`\n--- Summary (chronological) ---`);
for (const t of trace) {
  const flags = [
    t.isMatchByPayload ? "PAYLOAD" : "",
    t.becameGhost.length ? `GHOST(+${t.becameGhost.join(",")})` : "",
    t.inventoryAdded.length ? `INV+${t.inventoryAdded.join(",")}` : "",
    t.inventoryRemoved.length ? `INV-${t.inventoryRemoved.join(",")}` : "",
    t.newGhostAccessForJan.length
      ? `ACCESS×${t.newGhostAccessForJan.length}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  console.error(
    `${t.i.toString().padStart(5)} ${t.at} ${t.type.padEnd(40)} ${flags}`,
  );
}

import { writeFileSync } from "fs";
const outPath = process.argv[3] || `/tmp/trace-${JAN}.json`;
writeFileSync(outPath, JSON.stringify(trace, null, 2));
console.error(`\nWrote trace JSON to ${outPath}`);
