// Replay the 4542804050851 mystery file and dump every state change
// for that JAN's inventory keys -- qty, shipped, and key churn.

import { readFileSync } from "fs";
import { rootReducer } from "../src/lib/root-reducer";

const JAN = "4542804050851";
const PATH =
  "/Users/anicolao/projects/antigravity/admin2/test-data/4542804050851-mystery.jsonl";

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

function tsIso(a: any): string {
  const k = tsKey(a);
  if (!k) return "?";
  return new Date(Math.floor(k / 1_000_000)).toISOString();
}

function snapshot(state: any) {
  const items = state?.inventory?.idToItem || {};
  const out: Record<string, { qty: number; shipped: number }> = {};
  for (const key of Object.keys(items)) {
    if (key.startsWith(JAN)) {
      out[key] = { qty: items[key].qty, shipped: items[key].shipped };
    }
  }
  return out;
}

const lines = readFileSync(PATH, "utf-8").split("\n").filter(Boolean);
const actions = lines
  .map((l) => JSON.parse(l))
  .sort((a, b) => tsKey(a) - tsKey(b));

console.log(`Loaded ${actions.length} actions for JAN ${JAN}\n`);

let state: any = rootReducer(undefined, { type: "@@INIT" });
let prev: Record<string, { qty: number; shipped: number }> = {};

for (let i = 0; i < actions.length; i++) {
  const a = actions[i];
  const before = prev;
  try {
    state = rootReducer(state, a, () => {});
  } catch (e) {
    console.log(`!! ERROR on ${i} ${a.type}:`, (e as Error).message);
  }
  const after = snapshot(state);

  // Skip silent passes that don't change the JAN.
  const changed =
    JSON.stringify(before) !== JSON.stringify(after) ||
    JSON.stringify(a).includes(JAN);
  if (!changed) {
    continue;
  }

  const arrow = JSON.stringify(before) === JSON.stringify(after) ? " " : "*";
  console.log(
    `${arrow} #${i.toString().padStart(2)} ${tsIso(a)} ${a.type.padEnd(34)} id=${a.id || ""}`,
  );
  // Show the relevant payload fields.
  const p = a.payload;
  const relevant: any = {};
  for (const key of [
    "id",
    "itemKey",
    "sourceId",
    "splits",
    "field",
    "from",
    "to",
    "subtype",
    "qty",
    "orderID",
    "janCode",
  ]) {
    if (p && p[key] !== undefined) relevant[key] = p[key];
  }
  if (Object.keys(relevant).length) {
    console.log(`     payload: ${JSON.stringify(relevant)}`);
  }
  // Show key diff.
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of allKeys) {
    const b = before[k];
    const af = after[k];
    if (!b && af) console.log(`     +  ${k}: qty=${af.qty} shipped=${af.shipped}`);
    else if (b && !af)
      console.log(`     -  ${k} (was qty=${b.qty} shipped=${b.shipped})`);
    else if (b && af && (b.qty !== af.qty || b.shipped !== af.shipped))
      console.log(
        `     ~  ${k}: qty ${b.qty}->${af.qty}  shipped ${b.shipped}->${af.shipped}`,
      );
  }
  prev = after;
}

console.log("\nFINAL:");
const finalSnap = snapshot(state);
for (const [k, v] of Object.entries(finalSnap)) {
  console.log(`  ${k}: qty=${v.qty} shipped=${v.shipped}`);
}
