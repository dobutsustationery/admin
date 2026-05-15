// Capture the relevant slices of the final replay state for the
// proposal-handle slugification fix. Intended to be run twice — once
// with the patched reducer on the branch (fixed) and once with main
// (unfixed) — then diff the two output files.
//
// Usage:
//   bun run scripts/handle-slugify-blast-radius.ts /tmp/handles-after.json
//
// Then on main:
//   git stash
//   bun run scripts/handle-slugify-blast-radius.ts /tmp/handles-before.json
//   git stash pop
//
// And diff with:
//   bun run scripts/handle-slugify-blast-radius.ts --diff \
//     /tmp/handles-before.json /tmp/handles-after.json

import { readFileSync, writeFileSync } from "fs";
import { rootReducer } from "../src/lib/root-reducer";

const BACKUP =
  "/Users/anicolao/projects/antigravity/production-backup-apr-25/firestore-export.json";

function tsKey(a: any): number {
  const ts = a?.timestamp;
  if (typeof ts?._seconds === "number")
    return ts._seconds * 1_000_000_000 + (Number(ts._nanoseconds) || 0);
  if (typeof ts?.seconds === "number")
    return ts.seconds * 1_000_000_000 + (Number(ts.nanoseconds) || 0);
  return 0;
}

interface Snapshot {
  proposalsHandle: Record<string, string>; // janCode -> proposal.handle
  proposalsTitle: Record<string, string>; // janCode -> proposal.title (context)
  inventoryHandle: Record<string, string>; // itemKey -> idToItem[itemKey].handle
  idToHandle: Record<string, string>; // itemKey -> listings.idToHandle[itemKey]
  handleToListingKeys: string[]; // sorted keys of listings.handleToListing
}

function captureSnapshot(state: any): Snapshot {
  const proposals = state?.listingCreation?.proposals || {};
  const proposalsHandle: Record<string, string> = {};
  const proposalsTitle: Record<string, string> = {};
  for (const jan of Object.keys(proposals)) {
    proposalsHandle[jan] = proposals[jan].handle || "";
    proposalsTitle[jan] = proposals[jan].title || "";
  }
  const inv = state?.inventory?.idToItem || {};
  const inventoryHandle: Record<string, string> = {};
  for (const k of Object.keys(inv)) {
    if (inv[k]?.handle) inventoryHandle[k] = inv[k].handle;
  }
  const id2h = state?.listings?.idToHandle || {};
  const idToHandle: Record<string, string> = {};
  for (const k of Object.keys(id2h)) idToHandle[k] = id2h[k];
  const h2l = state?.listings?.handleToListing || {};
  const handleToListingKeys = Object.keys(h2l).sort();
  return {
    proposalsHandle,
    proposalsTitle,
    inventoryHandle,
    idToHandle,
    handleToListingKeys,
  };
}

function diffMaps(
  label: string,
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const lines: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of [...keys].sort()) {
    const b = before[k] ?? "<absent>";
    const a = after[k] ?? "<absent>";
    if (b !== a) {
      lines.push(`  ${label}[${JSON.stringify(k)}]`);
      lines.push(`    before: ${JSON.stringify(b)}`);
      lines.push(`    after:  ${JSON.stringify(a)}`);
    }
  }
  return lines;
}

function diffSets(
  label: string,
  before: string[],
  after: string[],
): string[] {
  const bSet = new Set(before);
  const aSet = new Set(after);
  const onlyBefore = [...bSet].filter((k) => !aSet.has(k)).sort();
  const onlyAfter = [...aSet].filter((k) => !bSet.has(k)).sort();
  const lines: string[] = [];
  if (onlyBefore.length || onlyAfter.length) {
    lines.push(`  ${label}:`);
    for (const k of onlyBefore) lines.push(`    - ${JSON.stringify(k)}  (only in BEFORE)`);
    for (const k of onlyAfter) lines.push(`    + ${JSON.stringify(k)}  (only in AFTER)`);
  }
  return lines;
}

function run() {
  const args = process.argv.slice(2);

  // Diff mode
  if (args[0] === "--diff") {
    const beforePath = args[1];
    const afterPath = args[2];
    if (!beforePath || !afterPath) {
      console.error(
        "Usage: --diff <before.json> <after.json>",
      );
      process.exit(1);
    }
    const before = JSON.parse(readFileSync(beforePath, "utf-8")) as Snapshot;
    const after = JSON.parse(readFileSync(afterPath, "utf-8")) as Snapshot;

    console.log(`# Blast-radius diff: ${beforePath} -> ${afterPath}\n`);

    const propLines = diffMaps(
      "listingCreation.proposals.handle",
      before.proposalsHandle,
      after.proposalsHandle,
    );
    console.log(`## proposals[*].handle  (${propLines.length / 3} changed)`);
    if (propLines.length === 0) console.log("  (no change)");
    else console.log(propLines.join("\n"));

    const invLines = diffMaps(
      "inventory.idToItem[*].handle",
      before.inventoryHandle,
      after.inventoryHandle,
    );
    console.log(
      `\n## inventory.idToItem[*].handle  (${invLines.length / 3} changed)`,
    );
    if (invLines.length === 0) console.log("  (no change)");
    else console.log(invLines.join("\n"));

    const id2hLines = diffMaps(
      "listings.idToHandle",
      before.idToHandle,
      after.idToHandle,
    );
    console.log(
      `\n## listings.idToHandle  (${id2hLines.length / 3} changed)`,
    );
    if (id2hLines.length === 0) console.log("  (no change)");
    else console.log(id2hLines.join("\n"));

    const h2lLines = diffSets(
      "listings.handleToListing keys",
      before.handleToListingKeys,
      after.handleToListingKeys,
    );
    console.log(`\n## listings.handleToListing key set`);
    if (h2lLines.length === 0) console.log("  (no change)");
    else console.log(h2lLines.join("\n"));

    // Quick summary
    const changeBuckets = {
      proposals: propLines.length / 3,
      inventory: invLines.length / 3,
      idToHandle: id2hLines.length / 3,
      h2lKeys:
        (h2lLines.length > 0 ? h2lLines.length - 1 : 0), // minus the header line
    };
    console.log(
      `\n## Summary: ${JSON.stringify(changeBuckets)}`,
    );
    return;
  }

  // Capture mode
  const outPath = args[0] || "/tmp/handles-snapshot.json";
  console.error(`Replaying ${BACKUP} ...`);
  const raw = readFileSync(BACKUP, "utf-8");
  const docs = JSON.parse(raw).collections.broadcast.documents;
  const actions = docs
    .map((d: any) => ({ id: d.id, ...d.data }))
    .sort((a: any, b: any) => tsKey(a) - tsKey(b));

  let state: any = rootReducer(undefined, { type: "@@INIT" });
  for (let i = 0; i < actions.length; i++) {
    try {
      state = rootReducer(state, actions[i] as any, () => {});
    } catch {
      /* mirror audit-page tolerance */
    }
    if ((i + 1) % 5000 === 0) console.error(`  ${i + 1}/${actions.length}`);
  }
  console.error(`Replay finished.`);

  const snap = captureSnapshot(state);
  writeFileSync(outPath, JSON.stringify(snap, null, 2));
  console.error(`Wrote ${outPath}`);
  console.error(
    `proposals: ${Object.keys(snap.proposalsHandle).length}, ` +
      `inventory rows with handle: ${Object.keys(snap.inventoryHandle).length}, ` +
      `idToHandle: ${Object.keys(snap.idToHandle).length}, ` +
      `handleToListing keys: ${snap.handleToListingKeys.length}`,
  );
}

run();
