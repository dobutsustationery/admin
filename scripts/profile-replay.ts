// Profiles a full replay of the Apr 25 production backup through
// rootReducer. Emits: total time, per-1000-action wall-time buckets,
// per-action-type cost, the slowest individual actions, and state-size
// growth sampled per bucket (to correlate slowdown with O(n) scans over
// growing state). Focus: is the 22,000+ tail disproportionately slow?

import { readFileSync } from "fs";
import { performance } from "perf_hooks";
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

const raw = readFileSync(BACKUP, "utf-8");
const docs = JSON.parse(raw).collections.broadcast.documents;
const actions = docs
  .map((d: any) => ({ id: d.id, ...d.data }))
  .sort((a: any, b: any) => tsKey(a) - tsKey(b));

const N = actions.length;
const BUCKET = 1000;

interface TypeStat {
  count: number;
  totalMs: number;
  maxMs: number;
}
const byType = new Map<string, TypeStat>();
const perAction = new Float64Array(N);
const bucketMs: number[] = [];
const bucketSamples: any[] = [];

const sizeOf = (s: any) => {
  const inv = s?.inventory || {};
  const orders = inv.orderIdToOrder || {};
  let orderLines = 0;
  for (const k of Object.keys(orders))
    orderLines += (orders[k]?.items || []).length;
  return {
    idToItem: Object.keys(inv.idToItem || {}).length,
    idToHistory: Object.keys(inv.idToHistory || {}).length,
    orders: Object.keys(orders).length,
    orderLines,
    ghostAccessEvents: (s?.keyAudit?.ghostAccessEvents || []).length,
    ghostMap: Object.keys(s?.keyAudit?.ghostMap || {}).length,
    canonicalIndex: Object.keys(
      s?.keyAudit?.canonicalIncomingIndex || {},
    ).length,
    handleToListing: Object.keys(s?.listings?.handleToListing || {}).length,
    idToHandle: Object.keys(s?.listings?.idToHandle || {}).length,
  };
};

let state: any = rootReducer(undefined, { type: "@@INIT" });
const t0 = performance.now();
let bucketStart = t0;

for (let i = 0; i < N; i++) {
  const a = actions[i];
  const s = performance.now();
  try {
    state = rootReducer(state, a as any, () => {});
  } catch {
    /* mirror audit tolerance */
  }
  const dt = performance.now() - s;
  perAction[i] = dt;
  const type = a?.type || "<none>";
  const ts = byType.get(type) || { count: 0, totalMs: 0, maxMs: 0 };
  ts.count++;
  ts.totalMs += dt;
  if (dt > ts.maxMs) ts.maxMs = dt;
  byType.set(type, ts);

  if ((i + 1) % BUCKET === 0 || i === N - 1) {
    const now = performance.now();
    bucketMs.push(now - bucketStart);
    bucketSamples.push({ atIndex: i + 1, ...sizeOf(state) });
    bucketStart = now;
  }
}
const totalMs = performance.now() - t0;

console.log(`\n=== Replay profile: ${N} actions ===`);
console.log(`Total: ${(totalMs / 1000).toFixed(1)}s`);
console.log(
  `Mean: ${(totalMs / N).toFixed(3)} ms/action  ` +
    `(${(N / (totalMs / 1000)).toFixed(0)} actions/s)`,
);

console.log(`\n--- Wall time per ${BUCKET}-action bucket ---`);
console.log("bucket    actions      ms     ms/action");
bucketMs.forEach((ms, b) => {
  const lo = b * BUCKET;
  const hi = Math.min((b + 1) * BUCKET, N);
  const n = hi - lo;
  console.log(
    `${String(lo).padStart(6)}-${String(hi).padStart(6)}  ` +
      `${ms.toFixed(0).padStart(7)}  ${(ms / n).toFixed(3).padStart(9)}`,
  );
});

console.log(`\n--- State size growth (per bucket) ---`);
console.log(
  "atIndex idToItem idToHist orders ordLines ghostEvt ghostMap canonIdx h2l idToHandle",
);
for (const s of bucketSamples) {
  console.log(
    [
      String(s.atIndex).padStart(7),
      String(s.idToItem).padStart(8),
      String(s.idToHistory).padStart(8),
      String(s.orders).padStart(6),
      String(s.orderLines).padStart(8),
      String(s.ghostAccessEvents).padStart(8),
      String(s.ghostMap).padStart(8),
      String(s.canonicalIndex).padStart(8),
      String(s.handleToListing).padStart(4),
      String(s.idToHandle).padStart(10),
    ].join(" "),
  );
}

console.log(`\n--- Cost by action type (top 20 by total ms) ---`);
console.log("type                              count   totalMs   avgMs   maxMs");
[...byType.entries()]
  .sort((a, b) => b[1].totalMs - a[1].totalMs)
  .slice(0, 20)
  .forEach(([t, s]) => {
    console.log(
      `${t.padEnd(34)} ${String(s.count).padStart(5)} ` +
        `${s.totalMs.toFixed(0).padStart(9)} ` +
        `${(s.totalMs / s.count).toFixed(3).padStart(7)} ` +
        `${s.maxMs.toFixed(1).padStart(7)}`,
    );
  });

console.log(`\n--- 30 slowest individual actions ---`);
const idx = Array.from({ length: N }, (_, i) => i).sort(
  (a, b) => perAction[b] - perAction[a],
);
console.log("index   ms      type");
for (let k = 0; k < 30; k++) {
  const i = idx[k];
  console.log(
    `${String(i).padStart(5)} ${perAction[i].toFixed(1).padStart(7)}  ` +
      `${actions[i]?.type}`,
  );
}

// Tail focus: compare first half vs the 22k+ tail.
const half = Math.floor(N / 2);
const sum = (lo: number, hi: number) => {
  let m = 0;
  for (let i = lo; i < hi; i++) m += perAction[i];
  return m;
};
const firstHalf = sum(0, half);
const tail = sum(22000, N);
console.log(`\n--- Tail focus ---`);
console.log(
  `actions 0..${half}: ${(firstHalf / 1000).toFixed(1)}s ` +
    `(${(firstHalf / half).toFixed(3)} ms/action)`,
);
console.log(
  `actions 22000..${N}: ${(tail / 1000).toFixed(1)}s ` +
    `(${(tail / (N - 22000)).toFixed(3)} ms/action)`,
);
