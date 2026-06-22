// Replay a Firestore backup through rootReducer and dump the complete Redux
// state. A diff mode summarizes before/after blast radius for reducer fixes,
// with inventory/cost-ledger specialization plus an exhaustive full-state
// leaf-path diff artifact.
//
// Capture:
//   bun scripts/inventory-replay-dump.ts capture --backup ../production-backup-may-16 --out /tmp/inventory-before.json
//
// Diff:
//   bun scripts/inventory-replay-dump.ts diff /tmp/inventory-before.json /tmp/inventory-after.json --out /tmp/inventory-diff.md

import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import {
  valueAt,
  effectiveLedgerEntries,
  type LedgerEntry,
} from "../src/lib/cost-engine";
import { performance } from "perf_hooks";

type JsonObject = Record<string, any>;

interface BackupDoc {
  id: string;
  data: JsonObject;
}

interface Dump {
  schema:
    | "inventory-replay-dump/v1"
    | "inventory-replay-dump/v2"
    | "inventory-replay-dump/v3";
  meta: {
    backupPath: string;
    capturedAt: string;
    actionCount: number;
    replayMs: number;
    replayErrors: number;
    consoleCounts: { log: number; warn: number; error: number };
  };
  totals: JsonObject;
  stateTotals?: JsonObject;
  state?: JsonObject;
  inventory: JsonObject;
  orderValueSummary?: OrderValueSummaryRow[];
  inventoryValueReport?: InventoryValueReportRow[];
}

type StateDiffKind = "added" | "removed" | "changed";

interface StateLeafDiff {
  path: string;
  kind: StateDiffKind;
  before?: any;
  after?: any;
}

interface ListingVariantDisplayRow {
  id: string;
  janCode: string;
  inventorySubtype: string;
  listingOption: string;
  displayLabel: string;
}

interface ListingVariantDisplayDiff {
  handle: string;
  before: ListingVariantDisplayRow[];
  after: ListingVariantDisplayRow[];
  defaultRegression: boolean;
}

interface OrderValueSummaryRow {
  orderId: string;
  orderName: string;
  orderDate?: number;
  firstScanAt?: number;
  lastScanAt?: number;
  valuationAt?: number;
  valuationReason: string;
  orderValueJpy: number;
  notReceivedValueJpy: number;
  receivedOrderValueJpy: number;
  cumulativeOrderValueJpy: number;
  cumulativeInventoryValueJpy: number;
  mismatchJpy: number;
  matchedOrderValueJpy: number;
  notReceivedCount: number;
}

interface InventoryValueReportRow {
  asOf: number;
  dateIso: string;
  kind: string;
  label: string;
  valueJpy: number;
  valueEur: number;
  cumulativeInventoryValueJpy: number;
  cumulativeInventoryValueEur: number;
  cumulativeSoldValueJpy: number;
  cumulativeSoldValueEur: number;
  residualJpy?: number;
}

type CostEngineModule = {
  effectiveLedgerEntries?: (entries: any[]) => any[];
  lotMatchesOrder: (entry: any, orderId: string) => boolean;
};

type InventoryValueModule = {
  totalCumulativeValues: (
    ledgers: any[][],
    asOf: number,
  ) => { inventoryJpy: number; inventoryEur: number };
  buildInventoryValueReport?: (
    inventory: JsonObject,
    nowMs: number,
  ) => InventoryValueReportRow[];
};

function targetLedgerEntries(
  costEngine: CostEngineModule,
  entries: any[] = [],
): any[] {
  return costEngine.effectiveLedgerEntries
    ? costEngine.effectiveLedgerEntries(entries)
    : entries;
}

const usage = () => {
  console.error(
    [
      "Usage:",
      "  bun scripts/inventory-replay-dump.ts capture --backup <backup-dir|firestore-export.json> --out <dump.json> [--app-root <repo-worktree>]",
      "  bun scripts/inventory-replay-dump.ts diff <before.json> <after.json> [--out <report.md>] [--detail-limit <rows, default 20; 0 for full>]",
    ].join("\n"),
  );
};

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function numberArg(args: string[], name: string, fallback: number): number {
  const value = argValue(args, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return Math.floor(parsed);
}

function limitedRows<T>(rows: T[], detailLimit: number): T[] {
  return detailLimit === 0 ? rows : rows.slice(0, detailLimit);
}

function omittedCount(total: number, detailLimit: number): number {
  if (detailLimit === 0) return 0;
  return Math.max(0, total - detailLimit);
}

function fullDetailCommand(
  beforePath: string,
  afterPath: string,
  outPath: string | undefined,
): string {
  const fullOut = outPath
    ? resolve(outPath).replace(/\.md$/i, ".full.md")
    : "/tmp/inventory-replay-full.md";
  return `bun scripts/inventory-replay-dump.ts diff ${resolve(beforePath)} ${resolve(afterPath)} --out ${fullOut} --detail-limit 0`;
}

function resolveBackupPath(input: string): string {
  const p = resolve(input);
  if (!existsSync(p)) throw new Error(`Backup path does not exist: ${p}`);
  if (statSync(p).isDirectory()) return join(p, "firestore-export.json");
  return p;
}

function timestampKey(action: any): bigint {
  const ts = action?.timestamp;
  if (typeof ts?._seconds === "number") {
    return (
      BigInt(ts._seconds) * 1_000_000_000n +
      BigInt(Number(ts._nanoseconds) || 0)
    );
  }
  if (typeof ts?.seconds === "number") {
    return (
      BigInt(ts.seconds) * 1_000_000_000n + BigInt(Number(ts.nanoseconds) || 0)
    );
  }
  if (typeof action?._timestamp_millis === "number") {
    return BigInt(action._timestamp_millis) * 1_000_000n;
  }
  if (typeof action?._timestamp === "number") {
    return BigInt(action._timestamp) * 1_000_000n;
  }
  return 0n;
}

function timestampMillis(action: any): number {
  const ts = action?.timestamp;
  if (typeof ts?._seconds === "number") {
    return (
      ts._seconds * 1000 + Math.floor((Number(ts._nanoseconds) || 0) / 1e6)
    );
  }
  if (typeof ts?.seconds === "number") {
    return ts.seconds * 1000 + Math.floor((Number(ts.nanoseconds) || 0) / 1e6);
  }
  if (typeof action?._timestamp_millis === "number") {
    return action._timestamp_millis;
  }
  if (typeof action?._timestamp === "number") {
    return action._timestamp;
  }
  return 0;
}

function loadActions(backupPath: string): JsonObject[] {
  const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
  const docs = (backup?.collections?.broadcast?.documents || []) as BackupDoc[];
  return docs
    .map((doc) => ({ id: doc.id, ...doc.data }))
    .sort((a, b) => {
      const diff = timestampKey(a) - timestampKey(b);
      if (diff < 0n) return -1;
      if (diff > 0n) return 1;
      return String(a.id || "").localeCompare(String(b.id || ""));
    });
}

function countOrderLines(orders: JsonObject): number {
  let n = 0;
  for (const order of Object.values(orders || {})) {
    n += Array.isArray((order as any)?.items) ? (order as any).items.length : 0;
  }
  return n;
}

function buildTotals(inventory: JsonObject): JsonObject {
  const idToItem = inventory?.idToItem || {};
  const idToHistory = inventory?.idToHistory || {};
  const orderIdToOrder = inventory?.orderIdToOrder || {};
  const costLedger = inventory?.costLedger || {};
  const stockOrderRegistry = inventory?.stockOrderRegistry || {};
  const hiddenExceptions = inventory?.hiddenExceptions || {};

  let missingCountryOfOrigin = 0;
  let missingWeight = 0;
  for (const item of Object.values(idToItem)) {
    const it = item as any;
    if (!String(it?.countryOfOrigin || "").trim()) missingCountryOfOrigin++;
    if (!(Number(it?.weight) > 0)) missingWeight++;
  }

  return {
    inventoryItems: Object.keys(idToItem).length,
    historyKeys: Object.keys(idToHistory).length,
    orders: Object.keys(orderIdToOrder).length,
    orderLines: countOrderLines(orderIdToOrder),
    costLedgerKeys: Object.keys(costLedger).length,
    stockOrders: Object.keys(stockOrderRegistry).length,
    hiddenExceptions: Object.keys(hiddenExceptions).length,
    missingCountryOfOrigin,
    missingWeight,
  };
}

function buildStateTotals(state: JsonObject): JsonObject {
  const totals: JsonObject = {};
  for (const [key, value] of Object.entries(state || {})) {
    if (value && typeof value === "object") {
      totals[key] = Array.isArray(value)
        ? value.length
        : Object.keys(value).length;
    } else {
      totals[key] = value === undefined ? "undefined" : typeof value;
    }
  }
  return totals;
}

function stable(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
    .join(",")}}`;
}

function itemLabel(key: string, item: any): string {
  const jan = item?.janCode || "";
  const subtype = item?.subtype || "";
  const desc = String(item?.description || "")
    .replace(/\s+/g, " ")
    .trim();
  return `${key} (${jan}${subtype ? ` / ${subtype}` : ""}${desc ? `: ${desc}` : ""})`;
}

function valueForReport(value: any): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

function valueForDiffReport(value: any): string {
  const raw = valueForReport(value);
  if (raw.length <= 180) return raw;
  return `${raw.slice(0, 177)}...`;
}

function pathPart(part: string | number): string {
  if (typeof part === "number") return `[${part}]`;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)) return `.${part}`;
  return `[${JSON.stringify(part)}]`;
}

function joinPath(parent: string, part: string | number): string {
  return `${parent}${pathPart(part)}`;
}

function isPlainDiffObject(value: any): boolean {
  return value !== null && typeof value === "object";
}

function collectLeaves(
  value: any,
  path: string,
  kind: "added" | "removed",
  out: StateLeafDiff[],
) {
  if (!isPlainDiffObject(value)) {
    out.push(
      kind === "added"
        ? { path, kind, after: value }
        : { path, kind, before: value },
    );
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(
        kind === "added"
          ? { path, kind, after: value }
          : { path, kind, before: value },
      );
      return;
    }
    value.forEach((entry, index) =>
      collectLeaves(entry, joinPath(path, index), kind, out),
    );
    return;
  }

  const keys = Object.keys(value).sort();
  if (keys.length === 0) {
    out.push(
      kind === "added"
        ? { path, kind, after: value }
        : { path, kind, before: value },
    );
    return;
  }
  keys.forEach((key) =>
    collectLeaves(value[key], joinPath(path, key), kind, out),
  );
}

function collectStateLeafDiffs(
  before: any,
  after: any,
  path = "state",
  out: StateLeafDiff[] = [],
): StateLeafDiff[] {
  if (stable(before) === stable(after)) return out;

  const beforeIsObject = isPlainDiffObject(before);
  const afterIsObject = isPlainDiffObject(after);
  if (!beforeIsObject || !afterIsObject) {
    out.push({ path, kind: "changed", before, after });
    return out;
  }

  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after)) {
      out.push({ path, kind: "changed", before, after });
      return out;
    }
    const max = Math.max(before.length, after.length);
    for (let i = 0; i < max; i++) {
      const nextPath = joinPath(path, i);
      if (i >= before.length) collectLeaves(after[i], nextPath, "added", out);
      else if (i >= after.length)
        collectLeaves(before[i], nextPath, "removed", out);
      else collectStateLeafDiffs(before[i], after[i], nextPath, out);
    }
    return out;
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    const nextPath = joinPath(path, key);
    if (!(key in before)) collectLeaves(after[key], nextPath, "added", out);
    else if (!(key in after))
      collectLeaves(before[key], nextPath, "removed", out);
    else collectStateLeafDiffs(before[key], after[key], nextPath, out);
  }
  return out;
}

function stateSliceFromPath(path: string): string {
  const match =
    /^state(?:\.([A-Za-z_$][A-Za-z0-9_$]*)|\[("[^"]+"|'[^']+'|[^\]]+)\])/.exec(
      path,
    );
  if (!match) return "(unknown)";
  if (match[1]) return match[1];
  const raw = match[2] || "";
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^['"]|['"]$/g, "");
  }
}

function statePrefix(path: string, depth: number): string {
  const parts: string[] = [];
  const re = /\.([A-Za-z_$][A-Za-z0-9_$]*)|\[("([^"]+)"|'([^']+)'|([^\]]+))\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(path)) && parts.length < depth) {
    parts.push(match[1] || match[3] || match[4] || match[5] || "");
  }
  return `state.${parts.join(".")}`;
}

function summarizeStateDiffs(diffs: StateLeafDiff[]) {
  const bySlice = new Map<
    string,
    { added: number; removed: number; changed: number; total: number }
  >();
  const byPrefix = new Map<string, number>();
  for (const diff of diffs) {
    const slice = stateSliceFromPath(diff.path);
    const row = bySlice.get(slice) || {
      added: 0,
      removed: 0,
      changed: 0,
      total: 0,
    };
    row[diff.kind]++;
    row.total++;
    bySlice.set(slice, row);

    const prefix = statePrefix(diff.path, 3);
    byPrefix.set(prefix, (byPrefix.get(prefix) || 0) + 1);
  }
  return {
    bySlice: [...bySlice.entries()].sort(
      (a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]),
    ),
    byPrefix: [...byPrefix.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    ),
  };
}

function writeFullStateDiffArtifact(
  reportPath: string | undefined,
  before: Dump,
  after: Dump,
  diffs: StateLeafDiff[],
) {
  if (!reportPath) return undefined;
  const out = resolve(reportPath.replace(/\.md$/i, ".full-state-diff.json"));
  const summary = summarizeStateDiffs(diffs);
  writeFileSync(
    out,
    JSON.stringify(
      {
        schema: "redux-full-state-diff/v1",
        before: {
          capturedAt: before.meta.capturedAt,
          backupPath: before.meta.backupPath,
          actionCount: before.meta.actionCount,
        },
        after: {
          capturedAt: after.meta.capturedAt,
          backupPath: after.meta.backupPath,
          actionCount: after.meta.actionCount,
        },
        totals: {
          leafDiffs: diffs.length,
          bySlice: Object.fromEntries(summary.bySlice),
        },
        diffs,
      },
      null,
      2,
    ),
  );
  return out;
}

function listingVariantOptionDiffs(diffs: StateLeafDiff[]): StateLeafDiff[] {
  return diffs.filter(
    (diff) =>
      diff.path.includes(".listings.handleToListing") &&
      (diff.path.includes(".variantOptionsByItemId") ||
        diff.path.endsWith(".option1Name") ||
        diff.path.includes(".variants") ||
        diff.path.endsWith(".subtype")),
  );
}

function listingVariantDisplayRows(
  state: JsonObject,
): Record<string, ListingVariantDisplayRow[]> {
  const out: Record<string, ListingVariantDisplayRow[]> = {};
  const idToHandle = state?.listings?.idToHandle || {};
  const handleToListing = state?.listings?.handleToListing || {};
  const idToItem = state?.inventory?.idToItem || {};

  for (const [id, handleValue] of Object.entries(idToHandle)) {
    const handle = String(handleValue || "");
    if (!handle) continue;
    const item = idToItem[id];
    if (!item) continue;
    const listing = handleToListing[handle] || {};
    const listingOption = String(
      listing?.variantOptionsByItemId?.[id] || "",
    ).trim();
    const inventorySubtype = String(item?.subtype || "").trim();
    const displayLabel = listingOption || inventorySubtype || "Default";
    if (!out[handle]) out[handle] = [];
    out[handle].push({
      id,
      janCode: String(item?.janCode || ""),
      inventorySubtype,
      listingOption,
      displayLabel,
    });
  }

  for (const rows of Object.values(out)) {
    rows.sort(
      (a, b) =>
        a.displayLabel.localeCompare(b.displayLabel) ||
        a.id.localeCompare(b.id),
    );
  }
  return out;
}

function diffListingVariantDisplayRows(
  beforeState: JsonObject,
  afterState: JsonObject,
): ListingVariantDisplayDiff[] {
  const before = listingVariantDisplayRows(beforeState);
  const after = listingVariantDisplayRows(afterState);
  const handles = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs: ListingVariantDisplayDiff[] = [];
  for (const handle of [...handles].sort()) {
    const b = before[handle] || [];
    const a = after[handle] || [];
    if (stable(b) === stable(a)) continue;
    const beforeLabels = new Set(b.map((row) => row.displayLabel));
    const defaultRegression =
      a.some((row) => row.displayLabel === "Default") &&
      !beforeLabels.has("Default");
    diffs.push({ handle, before: b, after: a, defaultRegression });
  }
  return diffs.sort((a, b) => {
    if (a.defaultRegression !== b.defaultRegression) {
      return a.defaultRegression ? -1 : 1;
    }
    return a.handle.localeCompare(b.handle);
  });
}

function listingRowsForReport(rows: ListingVariantDisplayRow[]): string {
  if (!rows.length) return "—";
  return rows
    .map((row) => {
      const parts = [
        `id=${row.id}`,
        `label=${JSON.stringify(row.displayLabel)}`,
      ];
      if (row.listingOption) {
        parts.push(`listingOption=${JSON.stringify(row.listingOption)}`);
      }
      if (row.inventorySubtype) {
        parts.push(`inventorySubtype=${JSON.stringify(row.inventorySubtype)}`);
      }
      return parts.join(" ");
    })
    .join("<br>");
}

function topLevelChangedFields(before: any, after: any): string[] {
  const keys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ]);
  return [...keys]
    .filter((key) => stable(before?.[key]) !== stable(after?.[key]))
    .sort();
}

function multisetDiff(before: any[] = [], after: any[] = []) {
  const beforeCounts = new Map<string, number>();
  const afterCounts = new Map<string, number>();
  const beforeByKey = new Map<string, any>();
  const afterByKey = new Map<string, any>();
  for (const entry of before) {
    const key = stable(entry) ?? "undefined";
    beforeCounts.set(key, (beforeCounts.get(key) || 0) + 1);
    beforeByKey.set(key, entry);
  }
  for (const entry of after) {
    const key = stable(entry) ?? "undefined";
    afterCounts.set(key, (afterCounts.get(key) || 0) + 1);
    afterByKey.set(key, entry);
  }

  const added: any[] = [];
  const removed: any[] = [];
  for (const [key, count] of afterCounts) {
    const delta = count - (beforeCounts.get(key) || 0);
    for (let i = 0; i < delta; i++) added.push(afterByKey.get(key));
  }
  for (const [key, count] of beforeCounts) {
    const delta = count - (afterCounts.get(key) || 0);
    for (let i = 0; i < delta; i++) removed.push(beforeByKey.get(key));
  }
  return { added, removed };
}

function historyEntryLabel(entry: any): string {
  if (!entry) return "";
  return `${entry.date || ""}: ${entry.desc || ""}`;
}

function asNumber(value: any): number {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function roundQty(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

const LATE_SCAN_GAP_MS = 30 * 24 * 60 * 60 * 1000;

function orderCostRowsValue(meta: any): number {
  const costRowsValue = ((meta?.costRows || []) as any[]).reduce((sum, row) => {
    const qty = Number(row?.qty);
    const unitCostJpy = Number(row?.unitCostJpy);
    return sum + (qty > 0 && unitCostJpy > 0 ? qty * unitCostJpy : 0);
  }, 0);
  return costRowsValue || meta?.valueOfGoodsJpy || meta?.valueOfOrderJpy || 0;
}

function orderNotReceivedValue(meta: any): number {
  return ((meta?.notReceivedRows || []) as any[]).reduce((sum, row) => {
    const qty = Number(row?.qty);
    const unitCostJpy = Number(row?.unitCostJpy);
    return sum + (qty > 0 && unitCostJpy > 0 ? qty * unitCostJpy : 0);
  }, 0);
}

function monthEndMs(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1;
}

function orderScanReceipts(
  inventory: JsonObject,
  orderId: string,
  costEngine: CostEngineModule,
) {
  const scans: Array<{ itemKey: string; at: number; qty: number }> = [];
  for (const [itemKey, ledger] of Object.entries(inventory?.costLedger || {})) {
    for (const entry of targetLedgerEntries(
      costEngine,
      (ledger as any[]) || [],
    )) {
      if (
        entry?.kind !== "receipt" ||
        entry?.ignored ||
        !costEngine.lotMatchesOrder(entry, orderId) ||
        String(entry?.source || "").startsWith("stockOrder:") ||
        !Number.isFinite(entry?.at) ||
        entry.at <= 0
      ) {
        continue;
      }
      scans.push({
        itemKey,
        at: entry.at,
        qty: Number(entry.qty) || 0,
      });
    }
  }
  return scans.sort(
    (a, b) => a.at - b.at || a.itemKey.localeCompare(b.itemKey),
  );
}

function scanWindowForOrder(
  inventory: JsonObject,
  orderId: string,
  costEngine: CostEngineModule,
) {
  const scans = orderScanReceipts(inventory, orderId, costEngine);
  const firstScanAt = scans[0]?.at;
  const lastScanAt = scans.at(-1)?.at;
  const hasLargeGap =
    firstScanAt != null &&
    lastScanAt != null &&
    lastScanAt - firstScanAt > LATE_SCAN_GAP_MS;
  const valuationAt =
    hasLargeGap && firstScanAt != null ? monthEndMs(firstScanAt) : lastScanAt;
  return {
    firstScanAt,
    lastScanAt,
    valuationAt,
    hasLargeGap,
  };
}

function cumulativeInventoryValueJpyAsOf(
  inventory: JsonObject,
  asOf: number,
  inventoryValue: InventoryValueModule,
): number {
  return inventoryValue.totalCumulativeValues(
    Object.values(inventory?.costLedger || {}) as any[][],
    asOf,
  ).inventoryJpy;
}

function matchedOrderReceiptValueJpy(
  inventory: JsonObject,
  orderId: string,
  costEngine: CostEngineModule,
): number {
  let total = 0;
  for (const ledger of Object.values(inventory?.costLedger || {})) {
    for (const entry of targetLedgerEntries(
      costEngine,
      (ledger as any[]) || [],
    )) {
      if (
        entry?.kind !== "receipt" ||
        entry?.ignored ||
        !costEngine.lotMatchesOrder(entry, orderId)
      ) {
        continue;
      }
      total += (Number(entry.qty) || 0) * (Number(entry.unitCostJpy) || 0);
    }
  }
  return total;
}

function buildOrderValueSummary(
  inventory: JsonObject,
  costEngine: CostEngineModule,
  inventoryValue: InventoryValueModule,
): OrderValueSummaryRow[] {
  const rows = Object.entries(inventory?.stockOrderRegistry || {})
    .map(([orderId, meta]) => {
      const orderValueJpy = orderCostRowsValue(meta);
      const notReceivedValueJpy = orderNotReceivedValue(meta);
      const receivedOrderValueJpy = Math.max(
        0,
        orderValueJpy - notReceivedValueJpy,
      );
      const scanWindow = scanWindowForOrder(inventory, orderId, costEngine);
      const valuationAt = scanWindow.valuationAt || (meta as any)?.receivedAt;
      const valuationReason = scanWindow.hasLargeGap
        ? "month end after first scan"
        : scanWindow.lastScanAt
          ? "last scan"
          : "order date";
      return {
        orderId,
        orderName: (meta as any)?.name || (meta as any)?.supplier || "",
        orderDate: (meta as any)?.receivedAt,
        firstScanAt: scanWindow.firstScanAt,
        lastScanAt: scanWindow.lastScanAt,
        valuationAt,
        valuationReason,
        orderValueJpy,
        notReceivedValueJpy,
        receivedOrderValueJpy,
        cumulativeOrderValueJpy: 0,
        cumulativeInventoryValueJpy: 0,
        mismatchJpy: 0,
        matchedOrderValueJpy: matchedOrderReceiptValueJpy(
          inventory,
          orderId,
          costEngine,
        ),
        notReceivedCount: ((meta as any)?.notReceivedRows || []).length,
      };
    })
    .sort((a, b) => {
      const aDate = a.orderDate || Number.MAX_SAFE_INTEGER;
      const bDate = b.orderDate || Number.MAX_SAFE_INTEGER;
      return aDate - bDate || a.orderId.localeCompare(b.orderId);
    });

  let cumulativeOrderValueJpy = 0;
  for (const row of rows) {
    const asOf = row.valuationAt || 0;
    cumulativeOrderValueJpy += row.receivedOrderValueJpy;
    row.cumulativeOrderValueJpy = Math.round(cumulativeOrderValueJpy);
    row.cumulativeInventoryValueJpy =
      asOf > 0
        ? Math.round(
            cumulativeInventoryValueJpyAsOf(inventory, asOf, inventoryValue),
          )
        : 0;
    row.mismatchJpy =
      row.cumulativeInventoryValueJpy - row.cumulativeOrderValueJpy;
  }

  return rows;
}

function buildInventoryValueReportRows(
  inventory: JsonObject,
  inventoryValue: InventoryValueModule,
  nowMs: number,
): InventoryValueReportRow[] {
  if (!inventoryValue.buildInventoryValueReport) return [];
  return inventoryValue
    .buildInventoryValueReport(inventory, nowMs)
    .map((row) => ({
      ...row,
      residualJpy:
        row.cumulativeInventoryValueJpy -
        row.valueJpy -
        row.cumulativeSoldValueJpy,
    }));
}

function formatDate(ms?: number): string {
  if (!ms) return "-";
  return new Date(ms).toISOString().slice(0, 10);
}

// Authoritative valuation via the cost engine (perpetual weighted-average with
// archive carry) — the same walk the app uses for item cost and inventory
// value. Returns on-hand, value, and average cost in both currencies.
function materializeLedger(entries: any[] = []) {
  const v = valueAt(entries as LedgerEntry[]);
  return {
    openQty: roundQty(v.onHand),
    valueJpy: roundMoney(v.valueJpy),
    valueEur: round4(v.valueEur),
    avgJpy: roundMoney(v.avgJpy),
    avgEur: round4(v.avgEur),
  };
}

// Cost basis of everything received into the ledger (the within-ledger average
// cost), independent of what is currently on hand. Walks the effective entries
// (qty corrections applied, adjustment rows folded in) and weights each priced
// receipt lot by its quantity. Catches per-lot unit-cost changes (e.g. a
// recount lot going ¥0 -> ¥65) that the final on-hand average can mask when the
// open position happens to blend to the same number.
function receiptBasis(entries: any[] = []) {
  let qty = 0;
  let valueJpy = 0;
  let valueEur = 0;
  for (const e of effectiveLedgerEntries(entries as LedgerEntry[])) {
    if (e.kind !== "receipt" || e.ignored) continue;
    const q = asNumber(e.qty);
    if (q <= 0) continue;
    qty += q;
    valueJpy += q * asNumber(e.unitCostJpy);
    valueEur += q * asNumber(e.unitCostEur);
  }
  return {
    recvQty: roundQty(qty),
    recvValueJpy: roundMoney(valueJpy),
    avgRecvJpy: qty ? roundMoney(valueJpy / qty) : 0,
    avgRecvEur: qty ? round4(valueEur / qty) : 0,
  };
}

function materializedLedgerChanged(before: any, after: any): boolean {
  return (
    before.openQty !== after.openQty ||
    before.valueJpy !== after.valueJpy ||
    before.valueEur !== after.valueEur ||
    before.avgJpy !== after.avgJpy ||
    before.avgEur !== after.avgEur
  );
}

async function capture(args: string[]) {
  const backupInput =
    argValue(args, "--backup") || "../production-backup-may-16";
  const outPath = argValue(args, "--out");
  const appRoot = resolve(argValue(args, "--app-root") || ".");
  if (!outPath) {
    usage();
    process.exit(1);
  }

  const backupPath = resolveBackupPath(backupInput);
  const actions = loadActions(backupPath);
  const reportNowMs =
    actions.reduce(
      (max, action) => Math.max(max, timestampMillis(action)),
      0,
    ) || Date.now();
  const reducerUrl = pathToFileURL(
    resolve(appRoot, "src/lib/root-reducer.ts"),
  ).href;
  const costEngineUrl = pathToFileURL(
    resolve(appRoot, "src/lib/cost-engine.ts"),
  ).href;
  const inventoryValueUrl = pathToFileURL(
    resolve(appRoot, "src/lib/inventory-value.ts"),
  ).href;
  const [{ rootReducer }, costEngine, inventoryValue] = await Promise.all([
    import(reducerUrl),
    import(costEngineUrl) as Promise<CostEngineModule>,
    import(inventoryValueUrl) as Promise<InventoryValueModule>,
  ]);

  const realLog = console.log.bind(console);
  const realWarn = console.warn.bind(console);
  const realError = console.error.bind(console);
  const consoleCounts = { log: 0, warn: 0, error: 0 };
  console.log = () => {
    consoleCounts.log++;
  };
  console.warn = () => {
    consoleCounts.warn++;
  };
  console.error = () => {
    consoleCounts.error++;
  };

  let replayErrors = 0;
  let state: any = rootReducer(undefined, { type: "@@INIT" });
  const t0 = performance.now();
  for (let i = 0; i < actions.length; i++) {
    try {
      state = rootReducer(state, actions[i], () => {});
    } catch {
      replayErrors++;
    }
    if ((i + 1) % 5000 === 0) {
      realError(`  replayed ${i + 1}/${actions.length}`);
    }
  }
  const replayMs = performance.now() - t0;

  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;

  const inventory = state?.inventory || {};
  const dump: Dump = {
    schema: "inventory-replay-dump/v3",
    meta: {
      backupPath,
      capturedAt: new Date().toISOString(),
      actionCount: actions.length,
      replayMs,
      replayErrors,
      consoleCounts,
    },
    totals: buildTotals(inventory),
    stateTotals: buildStateTotals(state || {}),
    state,
    inventory,
    orderValueSummary: buildOrderValueSummary(
      inventory,
      costEngine,
      inventoryValue,
    ),
    inventoryValueReport: buildInventoryValueReportRows(
      inventory,
      inventoryValue,
      reportNowMs,
    ),
  };

  writeFileSync(resolve(outPath), JSON.stringify(dump, null, 2));
  realError(`Wrote ${resolve(outPath)}`);
  realError(
    `Actions=${actions.length}, inventoryItems=${dump.totals.inventoryItems}, ` +
      `missingCOO=${dump.totals.missingCountryOfOrigin}, missingWeight=${dump.totals.missingWeight}, ` +
      `replay=${(replayMs / 1000).toFixed(1)}s`,
  );
}

function diff(args: string[]) {
  const [beforePath, afterPath] = args.filter((arg) => !arg.startsWith("--"));
  const outPath = argValue(args, "--out");
  const detailLimit = numberArg(args, "--detail-limit", 20);
  if (!beforePath || !afterPath) {
    usage();
    process.exit(1);
  }

  const before = JSON.parse(readFileSync(resolve(beforePath), "utf-8")) as Dump;
  const after = JSON.parse(readFileSync(resolve(afterPath), "utf-8")) as Dump;
  const beforeState = before.state || { inventory: before.inventory || {} };
  const afterState = after.state || { inventory: after.inventory || {} };
  const fullStateDiffs = collectStateLeafDiffs(beforeState, afterState);
  const fullStateSummary = summarizeStateDiffs(fullStateDiffs);
  const listingDisplayDiffs = diffListingVariantDisplayRows(
    beforeState,
    afterState,
  );
  const fullStateDiffPath = writeFullStateDiffArtifact(
    outPath,
    before,
    after,
    fullStateDiffs,
  );
  const lines: string[] = [];
  const push = (line = "") => lines.push(line);

  push("# Inventory Replay Diff");
  push("");
  push(`- Before: ${before.meta.capturedAt} (${before.meta.backupPath})`);
  push(`- After: ${after.meta.capturedAt} (${after.meta.backupPath})`);
  push(`- Actions: ${before.meta.actionCount} -> ${after.meta.actionCount}`);
  if (fullStateDiffPath) {
    push(`- Full Redux state diff: ${fullStateDiffPath}`);
  }
  if (detailLimit > 0) {
    push(`- Detail limit: ${detailLimit} rows per broad table.`);
    push(
      `- Full Markdown detail: \`${fullDetailCommand(beforePath, afterPath, outPath)}\``,
    );
  } else {
    push("- Detail limit: full report.");
  }
  push("");

  push("## Full Redux State Diff Coverage");
  push("");
  push(
    `Leaf-path diffs: **${fullStateDiffs.length}**. The adjacent ` +
      `\`.full-state-diff.json\` artifact contains every added, removed, or changed ` +
      `leaf path in the replayed Redux state; the sections below are summaries.`,
  );
  push("");
  push("| Slice | Added leaves | Removed leaves | Changed leaves | Total |");
  push("|---|---:|---:|---:|---:|");
  for (const [slice, counts] of fullStateSummary.bySlice) {
    push(
      `| ${slice} | ${counts.added} | ${counts.removed} | ${counts.changed} | ${counts.total} |`,
    );
  }
  push("");
  if (fullStateSummary.byPrefix.length > 0) {
    push("Top changed state prefixes:");
    push("");
    push("| Prefix | Leaf diffs |");
    push("|---|---:|");
    for (const [prefix, count] of limitedRows(
      fullStateSummary.byPrefix,
      detailLimit,
    )) {
      push(`| \`${prefix}\` | ${count} |`);
    }
    const omitted = omittedCount(fullStateSummary.byPrefix.length, detailLimit);
    if (omitted > 0) {
      push(`| ... | ${omitted} more prefixes |`);
    }
    push("");
  }

  const optionDiffs = listingVariantOptionDiffs(fullStateDiffs);
  push("### Listing Variant / Option State Diffs");
  push("");
  push(
    `Listing variant/option leaf diffs: **${optionDiffs.length}**. ` +
      `These are included to catch UI-visible changes such as an option pill ` +
      `changing to "Default".`,
  );
  push("");
  if (optionDiffs.length > 0) {
    const omitted = omittedCount(optionDiffs.length, detailLimit);
    if (omitted > 0) {
      push(
        `Showing ${detailLimit} examples. Generate the full detail report with: ` +
          `\`${fullDetailCommand(beforePath, afterPath, outPath)}\`.`,
      );
      push("");
    }
    push("| Path | Kind | Before | After |");
    push("|---|---|---|---|");
    for (const diff of limitedRows(optionDiffs, detailLimit)) {
      push(
        `| \`${diff.path}\` | ${diff.kind} | ${valueForDiffReport(diff.before)} | ${valueForDiffReport(diff.after)} |`,
      );
    }
    if (omitted > 0) {
      push(`| ... | ${omitted} more | | |`);
    }
    push("");
  }

  push("### Listing Detail Variant Label Changes");
  push("");
  push(
    `Listings whose detail-page variant labels change: **${listingDisplayDiffs.length}**. ` +
      `Default regressions: **${listingDisplayDiffs.filter((row) => row.defaultRegression).length}**.`,
  );
  push("");
  if (listingDisplayDiffs.length > 0) {
    const omitted = omittedCount(listingDisplayDiffs.length, detailLimit);
    if (omitted > 0) {
      push(
        `Showing ${detailLimit} examples. Generate the full detail report with: ` +
          `\`${fullDetailCommand(beforePath, afterPath, outPath)}\`.`,
      );
      push("");
    }
    push("| Handle | Risk | Before labels | After labels |");
    push("|---|---|---|---|");
    for (const row of limitedRows(listingDisplayDiffs, detailLimit)) {
      push(
        `| \`${row.handle}\` | ${row.defaultRegression ? "Default regression" : "changed"} | ${listingRowsForReport(row.before)} | ${listingRowsForReport(row.after)} |`,
      );
    }
    if (omitted > 0) {
      push(`| ... | ${omitted} more | | |`);
    }
    push("");
  }

  push("## Totals");
  push("| Metric | Before | After | Delta |");
  push("|---|---:|---:|---:|");
  const totalKeys = new Set([
    ...Object.keys(before.totals || {}),
    ...Object.keys(after.totals || {}),
  ]);
  for (const key of [...totalKeys].sort()) {
    const b = Number(before.totals[key] || 0);
    const a = Number(after.totals[key] || 0);
    push(`| ${key} | ${b} | ${a} | ${a - b >= 0 ? "+" : ""}${a - b} |`);
  }
  push("");

  const beforeOrderSummary = before.orderValueSummary || [];
  const afterOrderSummary = after.orderValueSummary || [];
  const beforeOrderById = new Map(
    beforeOrderSummary.map((row) => [row.orderId, row]),
  );
  const afterOrderById = new Map(
    afterOrderSummary.map((row) => [row.orderId, row]),
  );
  const orderIds = new Set([
    ...beforeOrderById.keys(),
    ...afterOrderById.keys(),
  ]);
  const changedOrderRows = [...orderIds]
    .map((orderId) => ({
      orderId,
      before: beforeOrderById.get(orderId),
      after: afterOrderById.get(orderId),
    }))
    .filter((row) => stable(row.before) !== stable(row.after))
    .sort((a, b) => {
      const aDate =
        a.before?.orderDate || a.after?.orderDate || Number.MAX_SAFE_INTEGER;
      const bDate =
        b.before?.orderDate || b.after?.orderDate || Number.MAX_SAFE_INTEGER;
      return aDate - bDate || a.orderId.localeCompare(b.orderId);
    });

  push("## Order Value Summary");
  push("");
  push(
    `Rows changed: **${changedOrderRows.length}**. Mismatch vector before: ` +
      `\`${beforeOrderSummary.map((row) => row.mismatchJpy).join(", ")}\`; ` +
      `after: \`${afterOrderSummary.map((row) => row.mismatchJpy).join(", ")}\`.`,
  );
  push("");
  if (changedOrderRows.length > 0) {
    const omitted = omittedCount(changedOrderRows.length, detailLimit);
    if (omitted > 0) {
      push(
        `Showing ${detailLimit} rows. Generate the full detail report with: ` +
          `\`${fullDetailCommand(beforePath, afterPath, outPath)}\`.`,
      );
      push("");
    }
    push(
      "| Order date | Order | Valuation date | Cumulative order JPY | Cumulative inventory JPY | Mismatch JPY | Matched receipt JPY | Reason |",
    );
    push("|---|---|---|---:|---:|---:|---:|---|");
    for (const row of limitedRows(changedOrderRows, detailLimit)) {
      const beforeRow = row.before;
      const afterRow = row.after;
      const label = afterRow?.orderName || beforeRow?.orderName || row.orderId;
      const beforeMismatch = beforeRow?.mismatchJpy ?? "missing";
      const afterMismatch = afterRow?.mismatchJpy ?? "missing";
      push(
        `| ${formatDate(afterRow?.orderDate || beforeRow?.orderDate)} | \`${label}\` | ${formatDate(beforeRow?.valuationAt)} -> ${formatDate(afterRow?.valuationAt)} | ${beforeRow?.cumulativeOrderValueJpy ?? "missing"} -> ${afterRow?.cumulativeOrderValueJpy ?? "missing"} | ${beforeRow?.cumulativeInventoryValueJpy ?? "missing"} -> ${afterRow?.cumulativeInventoryValueJpy ?? "missing"} | ${beforeMismatch} -> ${afterMismatch} | ${roundMoney(beforeRow?.matchedOrderValueJpy || 0)} -> ${roundMoney(afterRow?.matchedOrderValueJpy || 0)} | ${beforeRow?.valuationReason || "missing"} -> ${afterRow?.valuationReason || "missing"} |`,
      );
    }
    if (omitted > 0) {
      push(`| ... | ${omitted} more | | | | | | |`);
    }
    push("");
  }

  const beforeInventoryValue = before.inventoryValueReport || [];
  const afterInventoryValue = after.inventoryValueReport || [];
  const inventoryValueKey = (row: InventoryValueReportRow) =>
    `${row.asOf}:${row.kind}:${row.label}`;
  const beforeInventoryValueByKey = new Map(
    beforeInventoryValue.map((row) => [inventoryValueKey(row), row]),
  );
  const afterInventoryValueByKey = new Map(
    afterInventoryValue.map((row) => [inventoryValueKey(row), row]),
  );
  const inventoryValueKeys = new Set([
    ...beforeInventoryValueByKey.keys(),
    ...afterInventoryValueByKey.keys(),
  ]);
  const changedInventoryValueRows = [...inventoryValueKeys]
    .map((key) => ({
      key,
      before: beforeInventoryValueByKey.get(key),
      after: afterInventoryValueByKey.get(key),
    }))
    .filter((row) => stable(row.before) !== stable(row.after))
    .sort((a, b) => {
      const aDate = a.before?.asOf || a.after?.asOf || Number.MAX_SAFE_INTEGER;
      const bDate = b.before?.asOf || b.after?.asOf || Number.MAX_SAFE_INTEGER;
      return aDate - bDate || a.key.localeCompare(b.key);
    });

  push("## Inventory Value Report");
  push("");
  if (beforeInventoryValue.length === 0 && afterInventoryValue.length === 0) {
    push("Inventory-value rows were not captured in either dump.");
    push("");
  } else {
    const beforeCurrent = beforeInventoryValue.at(-1);
    const afterCurrent = afterInventoryValue.at(-1);
    push(
      `Rows changed: **${changedInventoryValueRows.length}**. Current residual JPY before: ` +
        `\`${beforeCurrent?.residualJpy ?? "missing"}\`; after: ` +
        `\`${afterCurrent?.residualJpy ?? "missing"}\`.`,
    );
    push("");
    if (changedInventoryValueRows.length > 0) {
      const omitted = omittedCount(
        changedInventoryValueRows.length,
        detailLimit,
      );
      if (omitted > 0) {
        push(
          `Showing ${detailLimit} rows. Generate the full detail report with: ` +
            `\`${fullDetailCommand(beforePath, afterPath, outPath)}\`.`,
        );
        push("");
      }
      push(
        "| Date | Type | Event | Value JPY | Cumulative inventory JPY | Cumulative sold JPY | Residual JPY |",
      );
      push("|---|---|---|---:|---:|---:|---:|");
      for (const row of limitedRows(changedInventoryValueRows, detailLimit)) {
        const beforeRow = row.before;
        const afterRow = row.after;
        const label = afterRow?.label || beforeRow?.label || row.key;
        push(
          `| ${afterRow?.dateIso || beforeRow?.dateIso || "-"} | ${afterRow?.kind || beforeRow?.kind || "-"} | \`${label}\` | ${beforeRow?.valueJpy ?? "missing"} -> ${afterRow?.valueJpy ?? "missing"} | ${beforeRow?.cumulativeInventoryValueJpy ?? "missing"} -> ${afterRow?.cumulativeInventoryValueJpy ?? "missing"} | ${beforeRow?.cumulativeSoldValueJpy ?? "missing"} -> ${afterRow?.cumulativeSoldValueJpy ?? "missing"} | ${beforeRow?.residualJpy ?? "missing"} -> ${afterRow?.residualJpy ?? "missing"} |`,
        );
      }
      if (omitted > 0) {
        push(`| ... | ${omitted} more | | | | | |`);
      }
      push("");
    }
  }

  const beforeItems = before.inventory?.idToItem || {};
  const afterItems = after.inventory?.idToItem || {};
  const itemKeys = new Set([
    ...Object.keys(beforeItems),
    ...Object.keys(afterItems),
  ]);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{
    key: string;
    before: any;
    after: any;
    fields: string[];
  }> = [];
  const changedFieldCounts: Record<string, number> = {};

  for (const key of [...itemKeys].sort()) {
    const b = beforeItems[key];
    const a = afterItems[key];
    if (b === undefined) added.push(key);
    else if (a === undefined) removed.push(key);
    else if (stable(b) !== stable(a)) {
      const fields = topLevelChangedFields(b, a);
      for (const field of fields) {
        changedFieldCounts[field] = (changedFieldCounts[field] || 0) + 1;
      }
      changed.push({ key, before: b, after: a, fields });
    }
  }

  push("## inventory.idToItem");
  push(
    `Keys added: ${added.length}; removed: ${removed.length}; changed: ${changed.length}`,
  );
  push("");
  if (Object.keys(changedFieldCounts).length > 0) {
    push("| Changed field | Item count |");
    push("|---|---:|");
    for (const [field, count] of Object.entries(changedFieldCounts).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )) {
      push(`| ${field} | ${count} |`);
    }
    push("");
  }

  const visibleCountChanged = changed
    .map((row) => {
      const beforeOnHand =
        asNumber(row.before?.qty) - asNumber(row.before?.shipped);
      const afterOnHand =
        asNumber(row.after?.qty) - asNumber(row.after?.shipped);
      return {
        key: row.key,
        before: row.before,
        after: row.after,
        beforeOnHand: roundQty(beforeOnHand),
        afterOnHand: roundQty(afterOnHand),
        delta: roundQty(afterOnHand - beforeOnHand),
      };
    })
    .filter(
      (row) =>
        asNumber(row.before?.qty) !== asNumber(row.after?.qty) ||
        asNumber(row.before?.shipped) !== asNumber(row.after?.shipped) ||
        row.beforeOnHand !== row.afterOnHand,
    )
    .sort(
      (a, b) =>
        Math.abs(b.delta) - Math.abs(a.delta) || a.key.localeCompare(b.key),
    );

  if (visibleCountChanged.length > 0) {
    push("### Visible On-Hand Changes");
    push("");
    const omitted = omittedCount(visibleCountChanged.length, detailLimit);
    if (omitted > 0) {
      push(
        `Showing ${detailLimit} examples. Generate the full detail report with: ` +
          `\`${fullDetailCommand(beforePath, afterPath, outPath)}\`.`,
      );
      push("");
    }
    push(
      "| Key | Qty before -> after | Shipped before -> after | On hand before -> after | Delta |",
    );
    push("|---|---:|---:|---:|---:|");
    for (const row of limitedRows(visibleCountChanged, detailLimit)) {
      push(
        `| \`${itemLabel(row.key, row.after || row.before)}\` | ${asNumber(row.before?.qty)} -> ${asNumber(row.after?.qty)} | ${asNumber(row.before?.shipped)} -> ${asNumber(row.after?.shipped)} | ${row.beforeOnHand} -> ${row.afterOnHand} | ${row.delta >= 0 ? "+" : ""}${row.delta} |`,
      );
    }
    if (omitted > 0) {
      push(`| ... | ${omitted} more | | | |`);
    }
    push("");
  }

  if (changed.length > 0) {
    const omitted = omittedCount(changed.length, detailLimit);
    if (omitted > 0) {
      push(
        `Showing ${detailLimit} changed item examples. Generate the full detail report with: ` +
          `\`${fullDetailCommand(beforePath, afterPath, outPath)}\`.`,
      );
      push("");
    }
    push("| Key | Fields | Before | After |");
    push("|---|---|---|---|");
    for (const row of limitedRows(changed, detailLimit)) {
      const beforeVals = row.fields
        .map((field) => `${field}: ${valueForReport(row.before?.[field])}`)
        .join("<br>");
      const afterVals = row.fields
        .map((field) => `${field}: ${valueForReport(row.after?.[field])}`)
        .join("<br>");
      push(
        `| \`${itemLabel(row.key, row.after || row.before)}\` | ${row.fields.join(", ")} | ${beforeVals} | ${afterVals} |`,
      );
    }
    if (omitted > 0) push(`| ... | ${omitted} more | | |`);
    push("");
  }

  const beforeLedger = before.inventory?.costLedger || {};
  const afterLedger = after.inventory?.costLedger || {};
  const ledgerKeys = new Set([
    ...Object.keys(beforeLedger),
    ...Object.keys(afterLedger),
  ]);
  const ledgerAddedKeys: string[] = [];
  const ledgerRemovedKeys: string[] = [];
  const ledgerChanged: Array<{
    key: string;
    added: any[];
    removed: any[];
    beforeOpen: ReturnType<typeof materializeLedger>;
    afterOpen: ReturnType<typeof materializeLedger>;
  }> = [];
  let ledgerAddedEntries = 0;
  let ledgerRemovedEntries = 0;
  let ledgerMaterializedChanged = 0;
  const avgChanged: Array<{
    key: string;
    beforeOpen: ReturnType<typeof materializeLedger>;
    afterOpen: ReturnType<typeof materializeLedger>;
  }> = [];
  const basisChanged: Array<{
    key: string;
    before: ReturnType<typeof receiptBasis>;
    after: ReturnType<typeof receiptBasis>;
  }> = [];
  // Total inventory value across every cost-ledger key (incl. added/removed),
  // valued with the authoritative cost engine on each side's stored ledger.
  let beforeValueJpy = 0;
  let beforeValueEur = 0;
  let afterValueJpy = 0;
  let afterValueEur = 0;
  for (const entries of Object.values(beforeLedger)) {
    const v = materializeLedger((entries as any[]) || []);
    beforeValueJpy += v.valueJpy;
    beforeValueEur += v.valueEur;
  }
  for (const entries of Object.values(afterLedger)) {
    const v = materializeLedger((entries as any[]) || []);
    afterValueJpy += v.valueJpy;
    afterValueEur += v.valueEur;
  }

  for (const key of [...ledgerKeys].sort()) {
    if (beforeLedger[key] === undefined) {
      ledgerAddedKeys.push(key);
      ledgerAddedEntries += Array.isArray(afterLedger[key])
        ? afterLedger[key].length
        : 0;
      continue;
    }
    if (afterLedger[key] === undefined) {
      ledgerRemovedKeys.push(key);
      ledgerRemovedEntries += Array.isArray(beforeLedger[key])
        ? beforeLedger[key].length
        : 0;
      continue;
    }

    const delta = multisetDiff(beforeLedger[key] || [], afterLedger[key] || []);
    const beforeOpen = materializeLedger(beforeLedger[key] || []);
    const afterOpen = materializeLedger(afterLedger[key] || []);
    const openChanged = materializedLedgerChanged(beforeOpen, afterOpen);
    if (openChanged) ledgerMaterializedChanged++;
    if (
      beforeOpen.avgJpy !== afterOpen.avgJpy ||
      beforeOpen.avgEur !== afterOpen.avgEur
    ) {
      avgChanged.push({ key, beforeOpen, afterOpen });
    }
    const beforeBasis = receiptBasis(beforeLedger[key] || []);
    const afterBasis = receiptBasis(afterLedger[key] || []);
    if (
      beforeBasis.avgRecvJpy !== afterBasis.avgRecvJpy ||
      beforeBasis.avgRecvEur !== afterBasis.avgRecvEur
    ) {
      basisChanged.push({ key, before: beforeBasis, after: afterBasis });
    }
    if (delta.added.length || delta.removed.length || openChanged) {
      ledgerAddedEntries += delta.added.length;
      ledgerRemovedEntries += delta.removed.length;
      ledgerChanged.push({ key, ...delta, beforeOpen, afterOpen });
    }
  }

  ledgerChanged.sort((a, b) => {
    const aMaterialized = materializedLedgerChanged(a.beforeOpen, a.afterOpen);
    const bMaterialized = materializedLedgerChanged(b.beforeOpen, b.afterOpen);
    if (aMaterialized !== bMaterialized) return aMaterialized ? -1 : 1;
    const aValueDelta = Math.abs(a.afterOpen.valueJpy - a.beforeOpen.valueJpy);
    const bValueDelta = Math.abs(b.afterOpen.valueJpy - b.beforeOpen.valueJpy);
    if (aValueDelta !== bValueDelta) return bValueDelta - aValueDelta;
    const aEntryDelta = a.added.length + a.removed.length;
    const bEntryDelta = b.added.length + b.removed.length;
    return bEntryDelta - aEntryDelta || a.key.localeCompare(b.key);
  });

  push("## inventory.costLedger");
  push(
    `Keys added: ${ledgerAddedKeys.length}; removed: ${ledgerRemovedKeys.length}; changed: ${ledgerChanged.length}`,
  );
  push(
    `Entry deltas: +${ledgerAddedEntries} / -${ledgerRemovedEntries}; materialized open value changed: ${ledgerMaterializedChanged}`,
  );
  push("");

  if (ledgerChanged.length > 0) {
    const omitted = omittedCount(ledgerChanged.length, detailLimit);
    if (omitted > 0) {
      push(
        `Showing ${detailLimit} ledger examples. Generate the full detail report with: ` +
          `\`${fullDetailCommand(beforePath, afterPath, outPath)}\`.`,
      );
      push("");
    }
    push(
      "| Key | Entry delta | Open qty before -> after | Open value JPY before -> after | Avg JPY before -> after |",
    );
    push("|---|---:|---:|---:|---:|");
    for (const row of limitedRows(ledgerChanged, detailLimit)) {
      const item = afterItems[row.key] || beforeItems[row.key] || {};
      push(
        `| \`${itemLabel(row.key, item)}\` | +${row.added.length} / -${row.removed.length} | ${row.beforeOpen.openQty} -> ${row.afterOpen.openQty} | ${row.beforeOpen.valueJpy} -> ${row.afterOpen.valueJpy} | ${row.beforeOpen.avgJpy} -> ${row.afterOpen.avgJpy} |`,
      );
    }
    if (omitted > 0) {
      push(`| ... | ${omitted} more | | | |`);
    }
    push("");
  }

  push("## Inventory Value");
  const valueJpyDelta = roundMoney(afterValueJpy - beforeValueJpy);
  const valueEurDelta = round4(afterValueEur - beforeValueEur);
  push("Total on-hand inventory value (cost engine, all items):");
  push("");
  push("| Currency | Before | After | Delta |");
  push("|---|---:|---:|---:|");
  push(
    `| JPY | ${roundMoney(beforeValueJpy)} | ${roundMoney(afterValueJpy)} | ${valueJpyDelta} |`,
  );
  push(
    `| EUR | ${round4(beforeValueEur)} | ${round4(afterValueEur)} | ${valueEurDelta} |`,
  );
  push("");

  push("## Average Cost Changes");
  push(
    `Items whose weighted-average cost changed: ${avgChanged.length} (key present in both; added/removed keys are listed under cost ledger).`,
  );
  push("");
  if (avgChanged.length > 0) {
    avgChanged.sort(
      (a, b) =>
        Math.abs(b.afterOpen.avgJpy - b.beforeOpen.avgJpy) -
          Math.abs(a.afterOpen.avgJpy - a.beforeOpen.avgJpy) ||
        a.key.localeCompare(b.key),
    );
    push(
      "| Key | On hand before -> after | Avg JPY before -> after | Avg EUR before -> after |",
    );
    push("|---|---:|---:|---:|");
    const omitted = omittedCount(avgChanged.length, detailLimit);
    for (const row of limitedRows(avgChanged, detailLimit)) {
      const item = afterItems[row.key] || beforeItems[row.key] || {};
      push(
        `| \`${itemLabel(row.key, item)}\` | ${row.beforeOpen.openQty} -> ${row.afterOpen.openQty} | ${row.beforeOpen.avgJpy} -> ${row.afterOpen.avgJpy} | ${row.beforeOpen.avgEur} -> ${row.afterOpen.avgEur} |`,
      );
    }
    if (omitted > 0) {
      push(`| ... | ${omitted} more | | |`);
    }
    push("");
  }

  push("## Received Cost-Basis Changes");
  push(
    `Items whose weighted-average cost of received lots changed: ${basisChanged.length}. ` +
      `This is the within-ledger cost basis (all priced receipts, qty-weighted), ` +
      `independent of the current on-hand position — it catches per-lot unit-cost ` +
      `changes (e.g. a recount lot going ¥0 -> ¥65) that the open average can mask.`,
  );
  push("");
  if (basisChanged.length > 0) {
    basisChanged.sort(
      (a, b) =>
        Math.abs(b.after.avgRecvJpy - b.before.avgRecvJpy) -
          Math.abs(a.after.avgRecvJpy - a.before.avgRecvJpy) ||
        a.key.localeCompare(b.key),
    );
    push(
      "| Key | Recv qty before -> after | Avg recv JPY before -> after | Avg recv EUR before -> after |",
    );
    push("|---|---:|---:|---:|");
    const omitted = omittedCount(basisChanged.length, detailLimit);
    for (const row of limitedRows(basisChanged, detailLimit)) {
      const item = afterItems[row.key] || beforeItems[row.key] || {};
      push(
        `| \`${itemLabel(row.key, item)}\` | ${row.before.recvQty} -> ${row.after.recvQty} | ${row.before.avgRecvJpy} -> ${row.after.avgRecvJpy} | ${row.before.avgRecvEur} -> ${row.after.avgRecvEur} |`,
      );
    }
    if (omitted > 0) {
      push(`| ... | ${omitted} more | | |`);
    }
    push("");
  }

  const beforeHistory = before.inventory?.idToHistory || {};
  const afterHistory = after.inventory?.idToHistory || {};
  const historyKeys = new Set([
    ...Object.keys(beforeHistory),
    ...Object.keys(afterHistory),
  ]);
  const historyChanged: Array<{
    key: string;
    added: any[];
    removed: any[];
  }> = [];
  let historyAddedEntries = 0;
  let historyRemovedEntries = 0;
  for (const key of [...historyKeys].sort()) {
    const delta = multisetDiff(
      beforeHistory[key] || [],
      afterHistory[key] || [],
    );
    if (delta.added.length || delta.removed.length) {
      historyAddedEntries += delta.added.length;
      historyRemovedEntries += delta.removed.length;
      historyChanged.push({ key, ...delta });
    }
  }

  push("## inventory.idToHistory");
  push(
    `Changed keys: ${historyChanged.length}; added entries: ${historyAddedEntries}; removed entries: ${historyRemovedEntries}`,
  );
  push("");
  if (historyChanged.length > 0) {
    const omitted = omittedCount(historyChanged.length, detailLimit);
    if (omitted > 0) {
      push(
        `Showing ${detailLimit} history examples. Generate the full detail report with: ` +
          `\`${fullDetailCommand(beforePath, afterPath, outPath)}\`.`,
      );
      push("");
    }
    push("| Key | Removed entries | Added entries |");
    push("|---|---|---|");
    for (const row of limitedRows(historyChanged, detailLimit)) {
      const item = afterItems[row.key] || beforeItems[row.key] || {};
      const removedEntries =
        row.removed.map(historyEntryLabel).join("<br>") || "—";
      const addedEntries = row.added.map(historyEntryLabel).join("<br>") || "—";
      push(
        `| \`${itemLabel(row.key, item)}\` | ${removedEntries} | ${addedEntries} |`,
      );
    }
    if (omitted > 0) {
      push(`| ... | ${omitted} more | |`);
    }
    push("");
  }

  const topKeys = new Set([
    ...Object.keys(before.inventory || {}),
    ...Object.keys(after.inventory || {}),
  ]);
  push("## Inventory Top-Level Sections");
  push("| Section | Changed | Before keys | After keys |");
  push("|---|---:|---:|---:|");
  for (const key of [...topKeys].sort()) {
    const b = before.inventory?.[key];
    const a = after.inventory?.[key];
    const changedSection = stable(b) !== stable(a);
    const bKeys =
      b && typeof b === "object" && !Array.isArray(b)
        ? Object.keys(b).length
        : "";
    const aKeys =
      a && typeof a === "object" && !Array.isArray(a)
        ? Object.keys(a).length
        : "";
    push(`| ${key} | ${changedSection ? "yes" : "no"} | ${bKeys} | ${aKeys} |`);
  }

  const report = lines.join("\n");
  if (outPath) {
    writeFileSync(resolve(outPath), report);
    console.error(`Wrote ${resolve(outPath)}`);
  } else {
    console.log(report);
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "capture") {
  await capture(args);
} else if (command === "diff") {
  diff(args);
} else {
  usage();
  process.exit(1);
}
