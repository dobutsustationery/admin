// Replay a production backup through the current rootReducer and list every
// product variant that is LIVE on Shopify (an active listing in the synced
// Shopify catalog) but is out of (or nearly out of) stock — one or fewer on
// hand, or oversold (sold more than was ever received). Outputs TSV.
//
// "Live on Shopify" = the variant appears in state.shopifyCatalog.handleToListing
// under a listing whose status is "active" (the catalog actually synced from
// Shopify — NOT the local listing-editor slice). Each Shopify variant resolves
// to an inventory item by SKU (canonical key), then janCode+subtype, then bare
// JAN (covers the single-variant key migration). On hand = item.qty -
// item.shipped (the cost-ledger-authoritative visible count). Oversold =
// cost-engine ledgerOversold (sold beyond received).
//
// Usage:
//   bun scripts/shopify-zero-inventory.ts [--backup <dir|firestore-export.json>] [--out <file.tsv>]

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { rootReducer } from "../src/lib/root-reducer";
import { ledgerOversold } from "../src/lib/cost-engine";
import {
  canonicalizeInventoryItemKey,
  canonicalizeJanCode,
  makeInventoryItemKey,
} from "../src/lib/sku";

function timestampKey(action: any): bigint {
  const ts = action?.timestamp;
  if (typeof ts?._seconds === "number") {
    return BigInt(ts._seconds) * 1_000_000_000n + BigInt(Number(ts._nanoseconds) || 0);
  }
  if (typeof ts?.seconds === "number") {
    return BigInt(ts.seconds) * 1_000_000_000n + BigInt(Number(ts.nanoseconds) || 0);
  }
  if (typeof action?._timestamp_millis === "number") {
    return BigInt(action._timestamp_millis) * 1_000_000n;
  }
  if (typeof action?._timestamp === "number") {
    return BigInt(action._timestamp) * 1_000_000n;
  }
  return 0n;
}

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const backup = arg("--backup", "../production-backup-jun-18");
const backupFile = backup.endsWith(".json") ? backup : join(backup, "firestore-export.json");
const outPath = arg("--out", "/tmp/shopify-zero-inventory.tsv");

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

const realError = console.error.bind(console);
const realLog = console.log.bind(console);
const realWarn = console.warn.bind(console);
console.log = () => {};
console.warn = () => {};
realError(`Replaying ${actions.length} actions from ${backupFile}...`);
let state: any = rootReducer(undefined, { type: "@@INIT" });
for (let i = 0; i < actions.length; i++) {
  try {
    state = rootReducer(state, actions[i], () => {});
  } catch {
    /* skip jailed/invalid actions, same as the app */
  }
  if ((i + 1) % 5000 === 0) realError(`  replayed ${i + 1}/${actions.length}`);
}
console.log = realLog;
console.warn = realWarn;

const inv = state.inventory || {};
const idToItem: Record<string, any> = inv.idToItem || {};
const costLedger: Record<string, any[]> = inv.costLedger || {};
const catalog = state.shopifyCatalog || {};
const handleToListing: Record<string, any> = catalog.handleToListing || {};

// Resolve a Shopify variant to its inventory item key (covers the single-variant
// JAN migration: a "JAN+subtype" SKU may now live under the bare JAN key).
function resolveInventoryKey(sku: string, janCode: string, subtype: string): string | null {
  const candidates = [
    sku ? canonicalizeInventoryItemKey(sku) : "",
    janCode ? makeInventoryItemKey(janCode, subtype) : "",
    janCode ? canonicalizeJanCode(janCode) : "",
  ];
  for (const c of candidates) {
    if (c && idToItem[c]) return c;
  }
  return candidates.find((c) => c) || null;
}

type Row = {
  key: string;
  jan: string;
  subtype: string;
  description: string;
  handle: string;
  title: string;
  sku: string;
  shopifyQty: number;
  qty: number;
  shipped: number;
  onHand: number;
  oversoldQty: number | "";
  oversoldOrders: string;
};

const rows: Row[] = [];
let liveListings = 0;
let liveVariants = 0;
const seen = new Set<string>();

for (const listing of Object.values(handleToListing)) {
  if (!listing || listing.status !== "active") continue; // live on Shopify only
  liveListings++;
  for (const v of listing.variants || []) {
    liveVariants++;
    const sku = String(v.sku || "");
    const jan = String(v.janCode || "");
    const subtype = String(v.subtype || "");
    const key = resolveInventoryKey(sku, jan, subtype) || sku || jan;
    const dedupe = `${listing.handle}|${sku || key}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    const item = idToItem[key];
    const qty = Number(item?.qty) || 0;
    const shipped = Number(item?.shipped) || 0;
    const onHand = qty - shipped;
    const oversold = ledgerOversold(costLedger[key] || []);

    if (onHand <= 1 || oversold) {
      rows.push({
        key,
        jan: item?.janCode || jan,
        subtype: item?.subtype || subtype,
        description: item?.description || listing.title || "",
        handle: listing.handle,
        title: listing.title || "",
        sku,
        shopifyQty: Number(v.inventoryQuantity) || 0,
        qty,
        shipped,
        onHand,
        oversoldQty: oversold ? oversold.oversoldQty : "",
        oversoldOrders: oversold ? oversold.offendingOrders.join("; ") : "",
      });
    }
  }
}

// Oversold first, then lowest on hand, then key.
rows.sort(
  (a, b) =>
    (b.oversoldQty !== "" ? 1 : 0) - (a.oversoldQty !== "" ? 1 : 0) ||
    a.onHand - b.onHand ||
    a.key.localeCompare(b.key),
);

const header = [
  "Key",
  "JAN",
  "Subtype",
  "Description",
  "Handle",
  "Title",
  "SKU",
  "Shopify qty",
  "Qty",
  "Shipped",
  "On hand",
  "Oversold qty",
  "Oversold orders",
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
      r.handle,
      r.title,
      r.sku,
      r.shopifyQty,
      r.qty,
      r.shipped,
      r.onHand,
      r.oversoldQty,
      r.oversoldOrders,
    ]
      .map(clean)
      .join("\t"),
  );
}
writeFileSync(outPath, lines.join("\n") + "\n");

realError(
  `Active Shopify listings: ${liveListings}; live variants: ${liveVariants}; ` +
    `flagged (<=1 on hand or oversold): ${rows.length}; oversold: ${rows.filter((r) => r.oversoldQty !== "").length}`,
);
realError(`Wrote ${outPath}`);
