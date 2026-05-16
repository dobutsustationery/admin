// Before/after blast-radius for the "canonicalize on write in
// applyInventoryUpdate" fix. Captures the relevant inventory state plus
// a console.error tally from a full Apr 25 backup replay. Run on main
// (before) and on the branch (after), then --diff.
//
//   bun run scripts/canonicalize-write-blast-radius.ts /tmp/cw-after.json
//   git stash && bun run scripts/canonicalize-write-blast-radius.ts /tmp/cw-before.json && git stash pop
//   bun run scripts/canonicalize-write-blast-radius.ts --diff /tmp/cw-before.json /tmp/cw-after.json

import { readFileSync, writeFileSync } from "fs";

const realError = console.error.bind(console);
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
  consoleErrorCount: number;
  // itemKey -> "jan|subtype|qty|shipped|handle"
  idToItem: Record<string, string>;
  idToHistoryKeys: string[];
  // orderID -> sorted "itemKey:qty" lines
  orderLines: Record<string, string[]>;
}

function fingerprint(it: any): string {
  return [
    it?.janCode ?? "",
    it?.subtype ?? "",
    it?.qty ?? 0,
    it?.shipped ?? 0,
    it?.handle ?? "",
  ].join("|");
}

function capture(state: any, consoleErrorCount: number): Snapshot {
  const inv = state?.inventory?.idToItem || {};
  const idToItem: Record<string, string> = {};
  for (const k of Object.keys(inv)) idToItem[k] = fingerprint(inv[k]);
  const idToHistoryKeys = Object.keys(
    state?.inventory?.idToHistory || {},
  ).sort();
  const orders = state?.inventory?.orderIdToOrder || {};
  const orderLines: Record<string, string[]> = {};
  for (const oid of Object.keys(orders)) {
    const lines = (orders[oid]?.items || [])
      .map((l: any) => `${l.itemKey}:${l.qty}`)
      .sort();
    orderLines[oid] = lines;
  }
  return { consoleErrorCount, idToItem, idToHistoryKeys, orderLines };
}

function diffMap(
  label: string,
  before: Record<string, string>,
  after: Record<string, string>,
): { added: string[]; removed: string[]; changed: string[] } {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const k of [...keys].sort()) {
    const b = before[k];
    const a = after[k];
    if (b === undefined && a !== undefined) added.push(k);
    else if (b !== undefined && a === undefined) removed.push(k);
    else if (b !== a) changed.push(k);
  }
  return { added, removed, changed };
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--diff") {
    const before = JSON.parse(readFileSync(args[1], "utf-8")) as Snapshot;
    const after = JSON.parse(readFileSync(args[2], "utf-8")) as Snapshot;
    console.log(`# canonicalize-on-write blast radius`);
    console.log(`\n## console.error`);
    console.log(`  before: ${before.consoleErrorCount}`);
    console.log(`  after : ${after.consoleErrorCount}`);

    const inv = diffMap("idToItem", before.idToItem, after.idToItem);
    console.log(`\n## inventory.idToItem`);
    console.log(
      `  keys added: ${inv.added.length}, removed: ${inv.removed.length}, fingerprint-changed: ${inv.changed.length}`,
    );
    for (const k of inv.added.slice(0, 60))
      console.log(`  + ${JSON.stringify(k)}  ${after.idToItem[k]}`);
    if (inv.added.length > 60) console.log(`  … +${inv.added.length - 60} more added`);
    for (const k of inv.removed.slice(0, 60))
      console.log(`  - ${JSON.stringify(k)}  ${before.idToItem[k]}`);
    if (inv.removed.length > 60)
      console.log(`  … +${inv.removed.length - 60} more removed`);
    for (const k of inv.changed.slice(0, 40)) {
      console.log(`  ~ ${JSON.stringify(k)}`);
      console.log(`      before: ${before.idToItem[k]}`);
      console.log(`      after : ${after.idToItem[k]}`);
    }
    if (inv.changed.length > 40)
      console.log(`  … +${inv.changed.length - 40} more changed`);

    const histKeysBefore = new Set(before.idToHistoryKeys);
    const histKeysAfter = new Set(after.idToHistoryKeys);
    const histAdded = [...histKeysAfter].filter((k) => !histKeysBefore.has(k));
    const histRemoved = [...histKeysBefore].filter((k) => !histKeysAfter.has(k));
    console.log(`\n## inventory.idToHistory keys`);
    console.log(
      `  added: ${histAdded.length}, removed: ${histRemoved.length}`,
    );

    // Order lines: count orders whose sorted line set differs.
    const orderIds = new Set([
      ...Object.keys(before.orderLines),
      ...Object.keys(after.orderLines),
    ]);
    let changedOrders = 0;
    const sampleChangedOrders: string[] = [];
    for (const oid of orderIds) {
      const b = JSON.stringify(before.orderLines[oid] || []);
      const a = JSON.stringify(after.orderLines[oid] || []);
      if (b !== a) {
        changedOrders++;
        if (sampleChangedOrders.length < 20) sampleChangedOrders.push(oid);
      }
    }
    console.log(`\n## inventory.orderIdToOrder line sets`);
    console.log(`  orders with changed line set: ${changedOrders}`);
    for (const oid of sampleChangedOrders) {
      console.log(`  ~ ${oid}`);
      console.log(`      before: ${JSON.stringify(before.orderLines[oid] || [])}`);
      console.log(`      after : ${JSON.stringify(after.orderLines[oid] || [])}`);
    }

    console.log(
      `\n## Summary: ${JSON.stringify({
        consoleErrorBefore: before.consoleErrorCount,
        consoleErrorAfter: after.consoleErrorCount,
        idToItemAdded: inv.added.length,
        idToItemRemoved: inv.removed.length,
        idToItemChanged: inv.changed.length,
        historyAdded: histAdded.length,
        historyRemoved: histRemoved.length,
        ordersChanged: changedOrders,
      })}`,
    );
    return;
  }

  const outPath = args[0] || "/tmp/cw-snapshot.json";
  let consoleErrorCount = 0;
  console.error = () => {
    consoleErrorCount++;
  };
  const { rootReducer } = await import("../src/lib/root-reducer");
  const docs = JSON.parse(readFileSync(BACKUP, "utf-8")).collections.broadcast
    .documents;
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
  }
  const snap = capture(state, consoleErrorCount);
  console.error = realError;
  writeFileSync(outPath, JSON.stringify(snap, null, 2));
  realError(
    `Wrote ${outPath} — console.error=${consoleErrorCount}, ` +
      `idToItem=${Object.keys(snap.idToItem).length}, ` +
      `idToHistory=${snap.idToHistoryKeys.length}, ` +
      `orders=${Object.keys(snap.orderLines).length}`,
  );
}

main();
