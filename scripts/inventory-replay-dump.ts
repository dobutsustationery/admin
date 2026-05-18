// Replay a Firestore backup through rootReducer and dump the complete
// inventory slice. A diff mode summarizes before/after inventory blast
// radius for reducer fixes.
//
// Capture:
//   bun scripts/inventory-replay-dump.ts capture --backup ../production-backup-may-16 --out /tmp/inventory-before.json
//
// Diff:
//   bun scripts/inventory-replay-dump.ts diff /tmp/inventory-before.json /tmp/inventory-after.json --out /tmp/inventory-diff.md

import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { performance } from "perf_hooks";

type JsonObject = Record<string, any>;

interface BackupDoc {
  id: string;
  data: JsonObject;
}

interface Dump {
  schema: "inventory-replay-dump/v1";
  meta: {
    backupPath: string;
    capturedAt: string;
    actionCount: number;
    replayMs: number;
    replayErrors: number;
    consoleCounts: { log: number; warn: number; error: number };
  };
  totals: JsonObject;
  inventory: JsonObject;
}

const usage = () => {
  console.error(
    [
      "Usage:",
      "  bun scripts/inventory-replay-dump.ts capture --backup <backup-dir|firestore-export.json> --out <dump.json>",
      "  bun scripts/inventory-replay-dump.ts diff <before.json> <after.json> [--out <report.md>]",
    ].join("\n"),
  );
};

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
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

async function capture(args: string[]) {
  const backupInput =
    argValue(args, "--backup") || "../production-backup-may-16";
  const outPath = argValue(args, "--out");
  if (!outPath) {
    usage();
    process.exit(1);
  }

  const backupPath = resolveBackupPath(backupInput);
  const actions = loadActions(backupPath);
  const { rootReducer } = await import("../src/lib/root-reducer");

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
    schema: "inventory-replay-dump/v1",
    meta: {
      backupPath,
      capturedAt: new Date().toISOString(),
      actionCount: actions.length,
      replayMs,
      replayErrors,
      consoleCounts,
    },
    totals: buildTotals(inventory),
    inventory,
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
  if (!beforePath || !afterPath) {
    usage();
    process.exit(1);
  }

  const before = JSON.parse(readFileSync(resolve(beforePath), "utf-8")) as Dump;
  const after = JSON.parse(readFileSync(resolve(afterPath), "utf-8")) as Dump;
  const lines: string[] = [];
  const push = (line = "") => lines.push(line);

  push("# Inventory Replay Diff");
  push("");
  push(`- Before: ${before.meta.capturedAt} (${before.meta.backupPath})`);
  push(`- After: ${after.meta.capturedAt} (${after.meta.backupPath})`);
  push(`- Actions: ${before.meta.actionCount} -> ${after.meta.actionCount}`);
  push("");

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

  if (changed.length > 0) {
    push("| Key | Fields | Before | After |");
    push("|---|---|---|---|");
    for (const row of changed.slice(0, 200)) {
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
    if (changed.length > 200)
      push(`| ... | ${changed.length - 200} more | | |`);
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
    push("| Key | Removed entries | Added entries |");
    push("|---|---|---|");
    for (const row of historyChanged.slice(0, 100)) {
      const item = afterItems[row.key] || beforeItems[row.key] || {};
      const removedEntries =
        row.removed.map(historyEntryLabel).join("<br>") || "—";
      const addedEntries = row.added.map(historyEntryLabel).join("<br>") || "—";
      push(
        `| \`${itemLabel(row.key, item)}\` | ${removedEntries} | ${addedEntries} |`,
      );
    }
    if (historyChanged.length > 100) {
      push(`| ... | ${historyChanged.length - 100} more | |`);
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
