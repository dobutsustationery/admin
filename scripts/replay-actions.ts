import { readFileSync } from 'fs';
import { rootReducer } from '../src/lib/root-reducer';

// --- Diff Logic from patch.ts ---

export type Value = boolean | number | string | undefined;
// biome-ignore lint/suspicious/noExplicitAny: <explanation>
type Patch = { [k: string]: any } | Value | null;

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
export function clone(o: any) {
  if (typeof o === "object" && o !== null) {
    const ret = Array.isArray(o) ? [...o] : { ...o };
    for (const k in ret) {
      ret[k] = clone(ret[k]);
    }
    return ret;
  }
  return o;
}

export function diff<T extends Value | object>(a: T, b: T): Patch {
  if (a === b) {
    return null;
  }
  if (a === undefined || typeof b !== "object" || typeof b !== typeof a) {
    return b;
  }
  const oldA: { [k: string]: Value } = a as { [k: string]: Value };
  const newA: { [k: string]: Value } = b as { [k: string]: Value };
  if (typeof b === "object" && typeof a !== "object") {
    // Should be caught by check above, but for type safety:
    throw `type mismatch, ${typeof a} vs ${typeof b}`;
  }
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  const ret: { [k: string]: any } = {};
  let entries = 0;
  
  // Diff existing keys
  for (const e of Object.entries(oldA)) {
    // If key missing in newA, it's a deletion? 
    // The provided logic relies on recursive diff.
    // If newA[e[0]] is undefined (deleted), diff(val, undefined) -> undefined.
    // The loop logic:
    /*
    const d = diff(oldA[e[0]], newA[e[0]]);
    if (d !== null) {
      ++entries;
      ret[e[0]] = d === undefined ? null : d; // If d is undefined, set null (delete marker?)
    }
    */
    // Wait, if newA[e[0]] is undefined, diff returns undefined?
    // diff(val, undefined) -> undefined.
    // So ret[key] = null.
    
    // Check if key exists in newA to distinguish "undefined value" vs "missing key" if needed?
    // The provided code assumes:
    const d = diff(oldA[e[0]], newA[e[0]]);
    if (d !== null) {
      ++entries;
      ret[e[0]] = d === undefined ? null : d;
    }
  }
  
  // Diff new keys
  for (const e of Object.entries(b).filter((e) => oldA[e[0]] === undefined)) {
    ++entries;
    ret[e[0]] = newA[e[0]];
  }
  if (entries === 0) return null;
  return clone(ret);
}

// --- End Diff Logic ---

const args = process.argv.slice(2);
const file = args[0];

if (!file) {
    console.error("Usage: bun scripts/replay-actions.ts <file.jsonl>");
    process.exit(1);
}

console.log(`Replaying actions from ${file}...`);
const content = readFileSync(file, 'utf-8');
const lines = content.split('\n').filter(l => l.trim());

// Initialize State
let state = rootReducer(undefined, { type: 'INIT' });

lines.forEach((line, i) => {
    try {
        const action = JSON.parse(line);
        
        // Skip metadata
        if (action.id && action.timestamp) {
            delete action.id;
            delete action.timestamp; 
        }

        const prevState = state;
        state = rootReducer(state, action);
        
        console.log(`\n--- Action ${i + 1}: ${action.type} ---`);
        
        const patch = diff(prevState, state);
        
        if (patch === null) {
            console.log("No state changes.");
        } else {
            console.log("*** STATE DIFF ***");
            const output = JSON.stringify(patch, null, 2);
            console.log(output.length > 4000 ? output.slice(0, 4000) + "\n... (truncated)" : output);
            console.log("*** STATE DIFF COMPLETE ***");
        }
        
    } catch (e) {
        console.error(`Error processing line ${i + 1}:`, e);
    }
});

console.log("\nReplay complete.");
