import { readFileSync } from 'fs';
import { rootReducer } from '../src/lib/root-reducer';

// Simple Diff Implementation
function diff(obj1: any, obj2: any, path = ""): string[] {
    const diffs: string[] = [];
    if (obj1 === obj2) return diffs;
    if (typeof obj1 !== typeof obj2) return [`${path}: ${JSON.stringify(obj1)} -> ${JSON.stringify(obj2)}`];
    if (typeof obj1 !== 'object' || obj1 === null || obj2 === null) {
        return [`${path}: ${JSON.stringify(obj1)} -> ${JSON.stringify(obj2)}`];
    }
    
    // Arrays: just check length or basic equality for now to avoid noise
    if (Array.isArray(obj1)) {
        if (!Array.isArray(obj2)) return [`${path}: Array -> ${typeof obj2}`];
        if (obj1.length !== obj2.length) diffs.push(`${path}.length: ${obj1.length} -> ${obj2.length}`);
        // Shallow compare items? Or deep?
        // Let's iterate if length is small?
        if (obj1.length === obj2.length && obj1.length < 10) {
             obj1.forEach((val, i) => {
                 diffs.push(...diff(val, obj2[i], `${path}[${i}]`));
             });
             return diffs;
        }
        // If different, assume changed.
        return diffs; // Use key iteration below for detailed object/array diff
    }

    const keys = new Set([...Object.keys(obj1), ...Object.keys(obj2)]);
    keys.forEach(key => {
        const p = path ? `${path}.${key}` : key;
        if (!(key in obj1)) {
            diffs.push(`+ ${p}`);
        } else if (!(key in obj2)) {
            diffs.push(`- ${p}`);
        } else {
            // Optimization: Ignore huge maps if only one key changed?
            // For now, recursive.
            // Truncate huge strings
            const v1 = obj1[key];
            const v2 = obj2[key];
            if (typeof v1 === 'string' && v1.length > 100 && v1 !== v2) {
                 diffs.push(`${p}: "${v1.slice(0, 20)}..." -> "${v2.slice(0, 20)}..."`);
            } else {
                 diffs.push(...diff(v1, v2, p));
            }
        }
    });
    return diffs;
}

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
            delete action.timestamp; // Allow reducer to use its own or action's _timestamp
        }

        const prevState = state;
        state = rootReducer(state, action);
        
        console.log(`\n--- Action ${i + 1}: ${action.type} ---`);
        // console.log(JSON.stringify(action, null, 2).slice(0, 200)); 
        
        const changes = diff(prevState, state);
        if (changes.length === 0) {
            console.log("No state changes.");
        } else {
            const output = changes.join('\n');
            console.log(output.length > 4000 ? output.slice(0, 4000) + "\n... (truncated)" : output);
        }
        
    } catch (e) {
        console.error(`Error processing line ${i + 1}:`, e);
    }
});

console.log("\nReplay complete.");