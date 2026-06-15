/**
 * Find live-event import lines where more was taken to a show than could have
 * remained after the previous show — the root cause behind the Thessaloniki
 * oversells (the count taken to Thessaloniki was never reduced by what Japan
 * Festival had already sold).
 *
 * For each commit_import it recovers the committed paste (the most recent
 * liveEventImport/set_paste at or before it) and parses it with the production
 * parser. Then, for a chosen "previous" and "later" show, it flags every item
 * where the later show's `Taking to …` exceeds the stock that should have
 * remained after the previous show:
 *
 *     remaining_after_previous = previous.officeOrSystemCount - previous.sold
 *     flag when  taking(later) > remaining_after_previous
 *
 * The office/system counts on the sheets are typically the original
 * (un-depleted) inventory count — the same value appears on both shows' sheets
 * — so "remaining" is computed from the previous show's count minus its sales,
 * not read from the later sheet.
 *
 * Usage:
 *   bun scripts/find-live-event-overtakes.ts <backup-dir> \
 *     [--previous "Japan Festival"] [--later "Thessaloniki"]
 */
import { readFileSync } from "fs";
import { parseLiveEventPaste } from "../src/lib/live-event-import-slice";
import { makeInventoryItemKey } from "../src/lib/sku";

const backupDir = process.argv[2] || "../production-backup-jun-11";
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const previousLabel = (arg("--previous") || "Japan Festival").toLowerCase();
const laterLabel = (arg("--later") || "Thessaloniki").toLowerCase();

const backup = JSON.parse(
  readFileSync(`${backupDir}/firestore-export.json`, "utf8"),
);
const docs = backup.collections.broadcast.documents as { id: string; data: any }[];
const tsk = (d: any) => {
  const t = d?.data?.timestamp;
  return t ? (t._seconds ?? t.seconds) * 1e9 + (+(t._nanoseconds ?? t.nanoseconds) || 0) : 0;
};
const acts = docs
  .map((d) => ({ id: d.id, type: d.data.type, ts: tsk(d), raw: d.data.payload?.rawPaste as string | undefined }))
  .sort((a, b) => a.ts - b.ts);

// Recover, for each commit, the paste it committed.
type Show = { commitId: string; ts: number; paste: string; takingCol: string };
const shows: Show[] = [];
for (const c of acts.filter((a) => a.type === "liveEventImport/commit_import")) {
  const paste = [...acts].filter((a) => a.type === "liveEventImport/set_paste" && a.ts <= c.ts).pop()?.raw;
  if (!paste) continue;
  const takingCol =
    paste.split(/\r?\n/)[0].split("\t").find((h) => h.startsWith("Taking to ")) || "";
  shows.push({ commitId: c.id, ts: c.ts, paste, takingCol });
}

const findShow = (label: string, before?: number) =>
  shows
    .filter((s) => s.takingCol.toLowerCase().includes(label) && (before === undefined || s.ts <= before))
    .pop();

const later = findShow(laterLabel);
if (!later) throw new Error(`No committed show matching "${laterLabel}"`);
const previous = findShow(previousLabel, later.ts);
if (!previous) throw new Error(`No committed "${previousLabel}" show before "${laterLabel}"`);

console.error(`later show   : ${later.takingCol} (commit ${later.commitId})`);
console.error(`previous show: ${previous.takingCol} (commit ${previous.commitId})`);

type Line = {
  key: string; jan: string; subtype: string; desc: string;
  count?: number; taking?: number; sold: number;
};
function lines(paste: string): Map<string, Line> {
  const m = new Map<string, Line>();
  for (const row of parseLiveEventPaste(paste).rows) {
    const p = row.parsed;
    if (!p?.janCode) continue;
    m.set(makeInventoryItemKey(p.janCode, p.subtype), {
      key: makeInventoryItemKey(p.janCode, p.subtype),
      jan: p.janCode,
      subtype: p.subtype,
      desc: p.description,
      count: p.actualOfficeCount ?? p.systemCount, // stock count recorded on the sheet
      taking: p.taking,
      sold: Number(p.sold) || 0,
    });
  }
  return m;
}

const prev = lines(previous.paste);
const lat = lines(later.paste);

const flagged: any[] = [];
for (const [key, l] of lat) {
  if (l.taking === undefined) continue;
  const p = prev.get(key);
  if (!p || p.count === undefined) continue; // need the previous show's stock count
  const remaining = p.count - p.sold;
  if (l.taking > remaining) {
    flagged.push({
      key,
      jan: l.jan,
      subtype: l.subtype,
      desc: l.desc,
      previousCount: p.count,
      previousSold: p.sold,
      remainingAfterPrevious: remaining,
      takingLater: l.taking,
      overBy: l.taking - remaining,
      laterSold: l.sold,
    });
  }
}
flagged.sort((a, b) => b.overBy - a.overBy || a.key.localeCompare(b.key));

console.error(`\nOVER-TAKEN lines (taking to later > stock remaining after previous): ${flagged.length}`);
console.error("key | desc | prevCount - prevSold = remaining | tookLater (overBy) | laterSold");
for (const f of flagged) {
  console.error(
    `${f.key} | ${String(f.desc).slice(0, 34)} | ${f.previousCount} - ${f.previousSold} = ${f.remainingAfterPrevious} | took ${f.takingLater} (+${f.overBy}) | sold ${f.laterSold}`,
  );
}
console.log(JSON.stringify(flagged, null, 1));
