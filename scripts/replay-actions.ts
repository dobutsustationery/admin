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
  if (a === undefined || b === undefined) {
    return b;
  }
  if (a === null || b === null) {
    return b;
  }
  if (typeof a !== "object" || typeof b !== "object" || typeof b !== typeof a) {
    return b;
  }
  const oldA = a as Record<string, any>;
  const newA = b as Record<string, any>;
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  const ret: { [k: string]: any } = {};
  let entries = 0;

  const keys = new Set<string>([
    ...Object.keys(oldA),
    ...Object.keys(newA),
  ]);

  for (const key of keys) {
    const hasNew = Object.prototype.hasOwnProperty.call(newA, key);
    if (!hasNew) {
      ++entries;
      ret[key] = null;
      continue;
    }
    const d = diff(oldA[key], newA[key]);
    if (d !== null) {
      ++entries;
      ret[key] = d;
    }
  }

  if (entries === 0) return null;
  return clone(ret);
}

// --- End Diff Logic ---

const args = process.argv.slice(2);
let file = "";
let limit = 4000; // Default limit

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit") {
        limit = parseInt(args[i + 1], 10);
        if (isNaN(limit)) limit = 4000;
        i++;
    } else {
        file = args[i];
    }
}

if (!file) {
    console.error("Usage: bun scripts/replay-actions.ts <file.jsonl> [--limit NNN]");
    process.exit(1);
}

console.log(`Replaying actions from ${file}... (Limit: ${limit === 0 ? 'Unlimited' : limit})`);
const content = readFileSync(file, 'utf-8');
const lines = content.split('\n').filter(l => l.trim());

type ParsedAction = { raw: string; action: any; index: number };
const parsed: ParsedAction[] = lines.map((line, index) => {
    try {
        return { raw: line, action: JSON.parse(line), index };
    } catch (e) {
        console.error(`Failed to parse line ${index + 1}:`, e);
        return { raw: line, action: null, index };
    }
}).filter(p => p.action);

const getTimestampKey = (action: any): number | null => {
    const ts = action?.timestamp;
    if (ts?.seconds) {
        const nanos = ts.nanoseconds || 0;
        return ts.seconds * 1_000_000_000 + nanos;
    }
    if (typeof ts === 'number') {
        return ts * 1_000_000_000;
    }
    if (ts?.toDate) {
        return ts.toDate().getTime() * 1_000_000_000;
    }
    return null;
};

// Validate order: if timestamps exist, they must be non-decreasing.
let lastKey: number | null = null;
parsed.forEach((entry) => {
    const key = getTimestampKey(entry.action);
    if (key === null) return;
    if (lastKey !== null && key < lastKey) {
        throw new Error(
            `Replay actions are out of order at line ${entry.index + 1}. ` +
            `Expected non-decreasing timestamps.`
        );
    }
    lastKey = key;
});

// Initialize State
let state = rootReducer(undefined, { type: 'INIT' });

parsed.forEach((entry, i) => {
    try {
        const action = entry.action;
        
        const prevState = clone(state);
        state = rootReducer(state, action);
        
        console.log(`\n--- Action ${i + 1}: ${action.type} ---`);
        console.log(JSON.stringify(action, null, 2)); 
        
        const patch = diff(prevState, state);
        
        if (patch === null) {
            console.log("No state changes.");
        } else {
            console.log("*** STATE DIFF ***");
            const output = JSON.stringify(patch, null, 2);
            if (limit > 0 && output.length > limit) {
                console.log(output.slice(0, limit) + `\n... (truncated at ${limit}, use --limit to set)`);
            } else {
                console.log(output);
            }
            console.log("*** STATE DIFF COMPLETE ***");
        }
        
    } catch (e) {
        console.error(`Error processing line ${entry.index + 1}:`, e);
    }
});

console.log("\nReplay complete.");
