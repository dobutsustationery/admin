// Report every item whose cost-ledger on-hand disagrees with the stored on-hand
// quantity, after replaying a backup through the current code.
//
// The cost ledger is supposed to be authoritative: reconcileItemQtyFromCostLedger
// sets item.qty = item.shipped + walkLedgerForVisibleQty(ledger).onHand, so when
// reconciled, (item.qty - item.shipped) should equal the cost-ledger visible
// on-hand. This finds the items where they don't match — the cost ledger says
// one thing and the stored quantity says another.
//
// Columns: cost-ledger visible on-hand (the authoritative figure), the perpetual
// cost-engine on-hand (cost units; differs from visible only for loose pieces),
// the stored item.qty / shipped / (qty-shipped), and the delta.
//
// Usage:
//   bun scripts/cost-ledger-vs-onhand.ts [--backup ../staging-backup-jun-18] [--out <file.tsv>]

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { rootReducer } from "../src/lib/root-reducer";
import { walkLedger, effectiveLedgerEntries, type LedgerEntry } from "../src/lib/cost-engine";

function timestampKey(action: any): bigint {
  const ts = action?.timestamp;
  if (typeof ts?._seconds === "number")
    return BigInt(ts._seconds) * 1_000_000_000n + BigInt(Number(ts._nanoseconds) || 0);
  if (typeof ts?.seconds === "number")
    return BigInt(ts.seconds) * 1_000_000_000n + BigInt(Number(ts.nanoseconds) || 0);
  if (typeof action?._timestamp_millis === "number")
    return BigInt(action._timestamp_millis) * 1_000_000n;
  if (typeof action?._timestamp === "number")
    return BigInt(action._timestamp) * 1_000_000n;
  return 0n;
}

// Mirrors inventory.ts::walkLedgerForVisibleQty (the figure the qty reconciler uses).
function visibleOnHand(ledger: LedgerEntry[]): number {
  let onHand = 0;
  const sorted = [...effectiveLedgerEntries(ledger)].sort(
    (a, b) => a.at - b.at || (a.seq || 0) - (b.seq || 0),
  );
  for (const e of sorted) {
    if (e.ignored) continue;
    if (e.kind === "receipt") onHand = Math.max(0, onHand + (Number(e.qty) || 0));
    else onHand = Math.max(0, onHand - (Number((e as any).visibleQty ?? e.qty) || 0));
  }
  return onHand;
}

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const backup = arg("--backup", "../staging-backup-jun-18");
const backupFile = backup.endsWith(".json") ? backup : join(backup, "firestore-export.json");
const outPath = arg("--out", "/tmp/cost-ledger-vs-onhand.tsv");
const eps = 1e-6;

const realError = console.error.bind(console);
const realLog = console.log.bind(console);
const realWarn = console.warn.bind(console);

const data = JSON.parse(readFileSync(backupFile, "utf-8"));
const docs = data?.collections?.broadcast?.documents || [];
const actions = docs
  .map((d: any) => ({ id: d.id, ...d.data }))
  .sort((a: any, b: any) => {
    const diff = timestampKey(a) - timestampKey(b);
    if (diff < 0n) return -1;
    if (diff > 0n) return 1;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });

console.log = () => {};
console.warn = () => {};
realError(`Replaying ${actions.length} actions from ${backupFile}...`);
let state: any = rootReducer(undefined, { type: "@@INIT" });
for (let i = 0; i < actions.length; i++) {
  try {
    state = rootReducer(state, actions[i], () => {});
  } catch {
    /* skip jailed/invalid */
  }
  if ((i + 1) % 5000 === 0) realError(`  replayed ${i + 1}/${actions.length}`);
}
console.log = realLog;
console.warn = realWarn;

const idToItem: Record<string, any> = state.inventory?.idToItem || {};
const costLedger: Record<string, LedgerEntry[]> = state.inventory?.costLedger || {};

type Row = {
  key: string;
  jan: string;
  subtype: string;
  description: string;
  itemQty: number;
  shipped: number;
  itemOnHand: number;
  ledgerVisibleOnHand: number;
  costEngineOnHand: number;
  delta: number;
};

const rows: Row[] = [];
const keys = new Set([...Object.keys(idToItem), ...Object.keys(costLedger)]);
for (const key of keys) {
  const item = idToItem[key];
  const ledger = costLedger[key] || [];
  const itemQty = Number(item?.qty) || 0;
  const shipped = Number(item?.shipped) || 0;
  const itemOnHand = itemQty - shipped;
  const ledgerVisibleOnHand = visibleOnHand(ledger);
  const costEngineOnHand = walkLedger(ledger).onHand;
  // The itemhistory page shows two figures that should match but don't:
  //   - summary card on hand   = item.qty - item.shipped               (itemOnHand)
  //   - bottom of cost ledger  = walkLedger(ledger).onHand             (costEngineOnHand)
  // Flag where those two disagree (the reconciler keeps the *visible* walk in
  // sync, but the perpetual cost-engine walk can still diverge).
  const delta = costEngineOnHand - itemOnHand;
  if (Math.abs(delta) > eps) {
    rows.push({
      key,
      jan: item?.janCode || (key.match(/^(\d+)/) || [])[1] || key,
      subtype: item?.subtype || "",
      description: item?.description || "",
      itemQty,
      shipped,
      itemOnHand,
      ledgerVisibleOnHand,
      costEngineOnHand,
      delta,
    });
  }
}

rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.key.localeCompare(b.key));

const header = [
  "Key",
  "JAN",
  "Subtype",
  "Description",
  "Item qty",
  "Shipped",
  "Summary-card on hand (qty-shipped)",
  "Cost-ledger bottom on hand (walkLedger)",
  "Cost-ledger visible on hand (reconciler)",
  "Delta (cost-ledger - summary)",
];
const clean = (v: unknown) => String(v ?? "").replace(/[\t\n\r]+/g, " ");
const lines = [header.join("\t")];
for (const r of rows) {
  lines.push(
    [
      r.key,
      r.jan,
      r.subtype,
      r.description,
      r.itemQty,
      r.shipped,
      r.itemOnHand,
      r.costEngineOnHand,
      r.ledgerVisibleOnHand,
      Math.round(r.delta * 1000) / 1000,
    ]
      .map(clean)
      .join("\t"),
  );
}
writeFileSync(outPath, lines.join("\n") + "\n");

realError(
  `Items checked: ${keys.size}; disagreements (cost ledger != on-hand qty): ${rows.length}`,
);
realError(`Wrote ${outPath}`);
