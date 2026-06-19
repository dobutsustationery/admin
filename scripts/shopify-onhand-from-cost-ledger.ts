// Produce a Shopify inventory CSV that matches a downloaded inventory export but
// with the "On hand (new)" column filled from the cost-ledger-computed on-hand
// for the matching staging items. Re-importing the result into Shopify sets each
// product's on hand to what the cost ledger says it should be.
//
// On hand is the cost-ledger *visible* on-hand — exactly what
// inventory.ts::walkLedgerForVisibleQty computes (receipts add, sales subtract
// their visible qty, clamped at zero), replayed through the current code.
// Each CSV row's SKU resolves to a staging item by canonical key, then bare JAN
// (covers the single-variant key migration). Unmatched SKUs are left blank.
//
// Usage:
//   bun scripts/shopify-onhand-from-cost-ledger.ts \
//     [--csv inventory_export_1.csv] [--backup ../staging-backup-jun-18] [--out <file.csv>]

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import Papa from "papaparse";
import { rootReducer } from "../src/lib/root-reducer";
import { effectiveLedgerEntries, type LedgerEntry } from "../src/lib/cost-engine";
import {
  canonicalizeInventoryItemKey,
  canonicalizeJanCode,
} from "../src/lib/sku";

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

// Mirrors inventory.ts::walkLedgerForVisibleQty (not exported).
function visibleOnHand(ledger: LedgerEntry[]): number {
  let onHand = 0;
  const sorted = [...effectiveLedgerEntries(ledger)].sort(
    (a, b) => a.at - b.at || (a.seq || 0) - (b.seq || 0),
  );
  for (const e of sorted) {
    if (e.ignored) continue;
    if (e.kind === "receipt") {
      onHand = Math.max(0, onHand + (Number(e.qty) || 0));
    } else {
      const vis = Number((e as any).visibleQty ?? e.qty) || 0;
      onHand = Math.max(0, onHand - vis);
    }
  }
  return onHand;
}

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const csvPath = arg("--csv", "inventory_export_1.csv");
const backup = arg("--backup", "../staging-backup-jun-18");
const backupFile = backup.endsWith(".json") ? backup : join(backup, "firestore-export.json");
const outPath = arg("--out", "/tmp/inventory_export_onhand.csv");

const realError = console.error.bind(console);
const realLog = console.log.bind(console);
const realWarn = console.warn.bind(console);

// --- Replay staging to get the cost ledger ---
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
    /* skip jailed/invalid actions */
  }
  if ((i + 1) % 5000 === 0) realError(`  replayed ${i + 1}/${actions.length}`);
}
console.log = realLog;
console.warn = realWarn;

const idToItem: Record<string, any> = state.inventory?.idToItem || {};
const costLedger: Record<string, LedgerEntry[]> = state.inventory?.costLedger || {};

function resolveKey(sku: string): string | null {
  const c = canonicalizeInventoryItemKey(sku);
  if (idToItem[c]) return c;
  const jan = canonicalizeJanCode((sku.match(/^(\d+)/) || [])[1] || "");
  if (jan && idToItem[jan]) return jan;
  if (idToItem[sku]) return sku;
  return null;
}

// --- Rewrite the CSV ---
const csvText = readFileSync(csvPath, "utf-8");
const parsed = Papa.parse<Record<string, string>>(csvText, {
  header: true,
  skipEmptyLines: true,
});
const fields = parsed.meta.fields || [];
const NEW = "On hand (new)";
const SKU = "SKU";
if (!fields.includes(NEW) || !fields.includes(SKU)) {
  realError(`CSV is missing required columns (need "${SKU}" and "${NEW}"). Got: ${fields.join(", ")}`);
  process.exit(1);
}

let matched = 0;
let unmatched = 0;
const unmatchedSkus: string[] = [];
for (const row of parsed.data) {
  const sku = String(row[SKU] || "").trim();
  const key = sku ? resolveKey(sku) : null;
  if (key) {
    row[NEW] = String(visibleOnHand(costLedger[key] || []));
    matched++;
  } else {
    row[NEW] = ""; // leave unchanged on import
    unmatched++;
    if (unmatchedSkus.length < 20) unmatchedSkus.push(sku);
  }
}

// Match the source file's line endings (Shopify's export uses LF).
const out = Papa.unparse({ fields, data: parsed.data }, { newline: "\n" });
writeFileSync(outPath, out + "\n");

realError(
  `Rows: ${parsed.data.length}; matched to staging cost ledger: ${matched}; unmatched (left blank): ${unmatched}`,
);
if (unmatchedSkus.length) realError(`Unmatched SKUs (sample): ${unmatchedSkus.join(", ")}`);
realError(`Wrote ${outPath}`);
