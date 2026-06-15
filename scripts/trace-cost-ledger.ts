// Focused cost-ledger trace: replay a production backup through rootReducer,
// then dump the final cost ledger entries for the requested item keys plus the
// stock-order registry metadata for any stock orders those keys reference.
//
// Usage: bun scripts/trace-cost-ledger.ts <backupDir> <key> [key...]

import { readFileSync } from "fs";
import { rootReducer } from "../src/lib/root-reducer";

const backupDir = process.argv[2] || "../production-backup-jun-11";
const keys = process.argv.slice(3);
if (keys.length === 0) {
  console.error("Provide at least one item key to trace.");
  process.exit(1);
}

const BACKUP_PATH = `${backupDir}/firestore-export.json`;

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

console.error(`Loading ${BACKUP_PATH}...`);
const backup = JSON.parse(readFileSync(BACKUP_PATH, "utf-8"));
const documents = backup.collections.broadcast.documents as {
  id: string;
  data: any;
}[];
const actions = documents
  .map((d) => ({ id: d.id, ...d.data }))
  .sort((a: any, b: any) => tsKey(a) - tsKey(b));
console.error(`Replaying ${actions.length} actions...`);

let state: any = rootReducer(undefined, { type: "@@INIT" });
let errors = 0;
for (const action of actions) {
  try {
    state = rootReducer(state, action as any, () => {});
  } catch (e) {
    errors++;
  }
}
console.error(`Replay done. errors=${errors}`);

const inv = state.inventory;
const iso = (ms: any) =>
  Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : ms;

const referencedOrders = new Set<string>();

for (const key of keys) {
  console.log(`\n================ ${key} ================`);
  const item = inv.idToItem?.[key];
  console.log(
    `item: ${item ? `qty=${item.qty} shipped=${item.shipped} cost=${item.cost} jan=${item.janCode} subtype="${item.subtype}"` : "MISSING"}`,
  );
  const ledger = inv.costLedger?.[key] || [];
  console.log(`ledger entries: ${ledger.length}`);
  for (const e of ledger) {
    if (e.costOrderId) referencedOrders.add(e.costOrderId);
    if (typeof e.source === "string" && e.source.startsWith("stockOrder:")) {
      referencedOrders.add(e.source.slice("stockOrder:".length));
    }
    const parts = [
      e.kind,
      `at=${iso(e.at)}`,
      `seq=${e.seq}`,
      `qty=${e.qty}`,
    ];
    if (e.kind === "receipt") {
      parts.push(
        `unitCostJpy=${e.unitCostJpy}`,
        `unitCostEur=${e.unitCostEur}`,
        `costOrderId=${e.costOrderId ?? "-"}`,
      );
    }
    parts.push(`source=${e.source ?? "-"}`);
    if (e.ignored) parts.push(`IGNORED(${e.ignoreReason ?? ""})`);
    console.log("  - " + parts.join(" "));
  }
}

console.log(`\n================ stock-order registry ================`);
for (const orderId of referencedOrders) {
  const meta = inv.stockOrderRegistry?.[orderId];
  console.log(`\norder ${orderId}: ${meta ? "" : "MISSING"}`);
  if (!meta) continue;
  console.log(
    `  name=${meta.name ?? "-"} receivedAt=${iso(meta.receivedAt)} usesZeroedQuantities=${meta.usesZeroedQuantities}`,
  );
  console.log(
    `  valueOfOrderJpy=${meta.valueOfOrderJpy} paidAmount=${meta.paidAmount} paidCurrency=${meta.paidCurrency} totalOrderEur=${meta.totalOrderEur}`,
  );
  const costRows = meta.costRows || [];
  console.log(`  costRows: ${costRows.length}`);
  for (const r of costRows)
    console.log(`    row jan=${r.jan} qty=${r.qty} unitCostJpy=${r.unitCostJpy}`);
  const nr = meta.notReceivedRows || [];
  if (nr.length) {
    console.log(`  notReceivedRows: ${nr.length}`);
    for (const r of nr)
      console.log(`    nr jan=${r.jan} qty=${r.qty} unitCostJpy=${r.unitCostJpy}`);
  }
  const issues = meta.costIssues || [];
  console.log(`  costIssues: ${issues.length}`);
  for (const i of issues)
    console.log(
      `    ${i.kind} jan=${i.jan} itemKey=${i.itemKey ?? "-"} qty=${i.qty} expected=${i.expectedQty} matched=${i.matchedQty} unitCostJpy=${i.unitCostJpy} scanAt=${iso(i.scanAt)} source=${i.source ?? "-"}`,
    );
}
