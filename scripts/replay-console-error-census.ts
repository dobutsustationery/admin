// Census of every console.error emitted while replaying the Apr 25
// production backup through rootReducer. Monkeypatches console.error,
// normalizes each message into a category (stripping ids/jans/urls),
// and prints counts + a representative example + the triggering action
// type distribution per category.

import { readFileSync } from "fs";

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

function normalize(msg: string): string {
  return msg
    .replace(/\b\d{8,}\b/g, "<JAN>")
    .replace(/https?:\/\/\S+/g, "<URL>")
    .replace(/\b[0-9a-fA-F]{16,}\b/g, "<HEX>")
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, "<ID>")
    .replace(/\d+/g, "<N>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

interface Bucket {
  count: number;
  example: string;
  actionTypes: Record<string, number>;
}

const buckets = new Map<string, Bucket>();
let currentActionType = "<none>";
let totalErrors = 0;

console.error = (...args: any[]) => {
  totalErrors++;
  const msg = args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  const key = normalize(msg);
  let b = buckets.get(key);
  if (!b) {
    b = { count: 0, example: msg.slice(0, 300), actionTypes: {} };
    buckets.set(key, b);
  }
  b.count++;
  b.actionTypes[currentActionType] =
    (b.actionTypes[currentActionType] || 0) + 1;
};

// Import AFTER patching so any module-load-time logging is captured too.
const { rootReducer } = await import("../src/lib/root-reducer");

const docs = JSON.parse(readFileSync(BACKUP, "utf-8")).collections.broadcast
  .documents;
const actions = docs
  .map((d: any) => ({ id: d.id, ...d.data }))
  .sort((a: any, b: any) => tsKey(a) - tsKey(b));

let state: any = rootReducer(undefined, { type: "@@INIT" });
for (let i = 0; i < actions.length; i++) {
  currentActionType = actions[i]?.type || "<none>";
  try {
    state = rootReducer(state, actions[i] as any, () => {});
  } catch (e) {
    console.error(`__replay_threw__ ${(e as Error).message}`);
  }
}

console.error = realError;

const sorted = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count);

realError(`\n===== console.error census =====`);
realError(`total console.error calls: ${totalErrors}`);
realError(`distinct categories: ${sorted.length}\n`);

let idx = 1;
for (const [key, b] of sorted) {
  const topActions = Object.entries(b.actionTypes)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 5)
    .map(([t, c]) => `${t}:${c}`)
    .join(", ");
  realError(`#${idx} [count=${b.count}]`);
  realError(`  pattern : ${key}`);
  realError(`  example : ${b.example.replace(/\n/g, " ")}`);
  realError(`  actions : ${topActions}`);
  realError("");
  idx++;
}
