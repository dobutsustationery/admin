// Compare /tmp/replay-state-before.json vs /tmp/replay-state-after.json
// and produce a markdown report of inventory deltas caused by the
// uncommitted reducer change.

import { readFileSync, writeFileSync } from "fs";

const beforePath = "/tmp/replay-state-before.json";
const afterPath = "/tmp/replay-state-after.json";
const outPath = "/tmp/replay-diff-report.md";

const before = JSON.parse(readFileSync(beforePath, "utf-8"));
const after = JSON.parse(readFileSync(afterPath, "utf-8"));

const lines: string[] = [];
const push = (s = "") => lines.push(s);

push("# add_proposals fix — replay diff report\n");
push(`- **Backup:** production-backup-apr-25 (24,799 broadcasts)`);
push(`- **Before:** ${before.capturedAt} (current reducer)`);
push(`- **After:** ${after.capturedAt} (with add_proposals subtype-match fix)`);
push("");

push("## Totals");
push("| Metric | Before | After | Δ |");
push("|---|---:|---:|---:|");
for (const k of Object.keys(before.totals)) {
  const a = before.totals[k];
  const b = after.totals[k];
  push(`| ${k} | ${a} | ${b} | ${b - a >= 0 ? "+" : ""}${b - a} |`);
}
push("");

push("## Key audit");
push("| Metric | Before | After |");
push("|---|---:|---:|");
const auditKeys = new Set([
  ...Object.keys(before.audit),
  ...Object.keys(after.audit),
]);
for (const k of auditKeys) {
  if (k === "ghostAccessByOutcome") continue;
  push(`| ${k} | ${before.audit[k] ?? "—"} | ${after.audit[k] ?? "—"} |`);
}
push("");
push("**Ghost access outcomes:**");
const beforeBy = before.audit.ghostAccessByOutcome || {};
const afterBy = after.audit.ghostAccessByOutcome || {};
const outcomeKeys = new Set([
  ...Object.keys(beforeBy),
  ...Object.keys(afterBy),
]);
push("| Outcome | Before | After | Δ |");
push("|---|---:|---:|---:|");
for (const k of outcomeKeys) {
  const a = beforeBy[k] || 0;
  const b = afterBy[k] || 0;
  push(`| ${k} | ${a} | ${b} | ${b - a >= 0 ? "+" : ""}${b - a} |`);
}
push("");

// Inventory diff: for every key present in before or after, compare
// qty/shipped/handle/subtype/price.  Group changes by JAN.
type Delta = {
  key: string;
  janCode: string;
  subtype: string;
  beforeQty: number | null;
  afterQty: number | null;
  beforeShipped: number | null;
  afterShipped: number | null;
  beforeHandle: string | null;
  afterHandle: string | null;
  beforeSubtype: string | null;
  afterSubtype: string | null;
};

const allKeys = new Set([
  ...Object.keys(before.inventoryRows),
  ...Object.keys(after.inventoryRows),
]);

const deltas: Delta[] = [];
for (const key of allKeys) {
  const b = before.inventoryRows[key];
  const a = after.inventoryRows[key];
  const qB = b?.qty ?? null;
  const qA = a?.qty ?? null;
  const sB = b?.shipped ?? null;
  const sA = a?.shipped ?? null;
  const hB = b?.handle ?? null;
  const hA = a?.handle ?? null;
  const subB = b?.subtype ?? null;
  const subA = a?.subtype ?? null;
  if (
    qB === qA &&
    sB === sA &&
    hB === hA &&
    subB === subA
  ) {
    continue;
  }
  deltas.push({
    key,
    janCode: (a?.janCode || b?.janCode || "").toString(),
    subtype: (a?.subtype || b?.subtype || "").toString(),
    beforeQty: qB,
    afterQty: qA,
    beforeShipped: sB,
    afterShipped: sA,
    beforeHandle: hB,
    afterHandle: hA,
    beforeSubtype: subB,
    afterSubtype: subA,
  });
}

push("## Inventory deltas");
push(`Affected items: **${deltas.length}**`);
push("");

if (deltas.length === 0) {
  push("_No inventory rows changed._");
} else {
  // Group by JAN.
  const byJan: Record<string, Delta[]> = {};
  for (const d of deltas) {
    if (!byJan[d.janCode]) byJan[d.janCode] = [];
    byJan[d.janCode].push(d);
  }
  const jans = Object.keys(byJan).sort();

  push(`Affected JANs: **${jans.length}**`);
  push("");
  push(
    "| JAN | Key | Subtype | qty Δ | shipped Δ | handle Δ | notes |",
  );
  push("|---|---|---|---:|---:|---|---|");
  let netQtyDelta = 0;
  let netShippedDelta = 0;
  for (const jan of jans) {
    for (const d of byJan[jan]) {
      const qD =
        d.beforeQty !== null && d.afterQty !== null
          ? d.afterQty - d.beforeQty
          : null;
      const sD =
        d.beforeShipped !== null && d.afterShipped !== null
          ? d.afterShipped - d.beforeShipped
          : null;
      if (qD !== null) netQtyDelta += qD;
      if (sD !== null) netShippedDelta += sD;
      const notes: string[] = [];
      if (d.beforeQty === null && d.afterQty !== null) notes.push("created");
      if (d.beforeQty !== null && d.afterQty === null) notes.push("removed");
      const handleChanged = d.beforeHandle !== d.afterHandle;
      const handleCell = handleChanged
        ? `${JSON.stringify(d.beforeHandle ?? "")} → ${JSON.stringify(d.afterHandle ?? "")}`
        : "—";
      const qtyCell =
        d.beforeQty === null
          ? `(new ${d.afterQty})`
          : d.afterQty === null
            ? `(removed; was ${d.beforeQty})`
            : `${d.beforeQty} → ${d.afterQty} (${qD! >= 0 ? "+" : ""}${qD})`;
      const shippedCell =
        d.beforeShipped === null
          ? `(new ${d.afterShipped})`
          : d.afterShipped === null
            ? `(removed; was ${d.beforeShipped})`
            : sD === 0
              ? `${d.beforeShipped}`
              : `${d.beforeShipped} → ${d.afterShipped} (${sD! >= 0 ? "+" : ""}${sD})`;
      push(
        `| ${d.janCode} | \`${d.key}\` | ${d.subtype || "(empty)"} | ${qtyCell} | ${shippedCell} | ${handleCell} | ${notes.join(", ") || "—"} |`,
      );
    }
  }
  push("");
  push(`**Net qty delta across all rows:** ${netQtyDelta >= 0 ? "+" : ""}${netQtyDelta}`);
  push(`**Net shipped delta across all rows:** ${netShippedDelta >= 0 ? "+" : ""}${netShippedDelta}`);
}

push("");
push("## Order-line `itemKey` reference deltas");
const refKeys = new Set([
  ...Object.keys(before.orderRefsByItemKey),
  ...Object.keys(after.orderRefsByItemKey),
]);
const refDiffs: { key: string; b: number; a: number }[] = [];
for (const k of refKeys) {
  const b = before.orderRefsByItemKey[k] || 0;
  const a = after.orderRefsByItemKey[k] || 0;
  if (b !== a) refDiffs.push({ key: k, b, a });
}
if (refDiffs.length === 0) {
  push("_No order-line itemKey reference counts changed._");
} else {
  push(`Affected order-line itemKeys: **${refDiffs.length}**`);
  push("");
  push("| itemKey | Σqty before | Σqty after | Δ |");
  push("|---|---:|---:|---:|");
  for (const d of refDiffs.sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b))) {
    push(`| \`${d.key}\` | ${d.b} | ${d.a} | ${d.a - d.b >= 0 ? "+" : ""}${d.a - d.b} |`);
  }
}

writeFileSync(outPath, lines.join("\n"));
console.error(`Report written to ${outPath}`);
console.error(`Affected inventory rows: ${deltas.length}`);
