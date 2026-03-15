import { writable } from "svelte/store";
import { toTimestampMs } from "./timestamped-action";

export interface LogEntry {
  id: number;
  timestamp: number;
  action: any;
  state: any;
}

const MAX_HISTORY = 2000; // Increased significantly for better history retention

function createDevToolsStore() {
  const { subscribe, update } = writable<LogEntry[]>([]);

  return {
    subscribe,
    add: (entry: LogEntry) =>
      update((log) => {
        const newLog = [entry, ...log];
        if (newLog.length > MAX_HISTORY) {
          return newLog.slice(0, MAX_HISTORY);
        }
        return newLog;
      }),
    clear: () => update(() => []),
  };
}

export const devtoolsStore = createDevToolsStore();

let actionCounter = 0;

function resolveActionTimestampMs(action: any): number | null {
  if (typeof action?._timestamp === "number") return action._timestamp;

  const eventTimestampMs = toTimestampMs(action?.timestamp);
  if (typeof eventTimestampMs === "number") return eventTimestampMs;
  return null;
}

// Helper to manually log internal actions (from reducer)
export function logAction(action: any, state: any, timestamp: number) {
  devtoolsStore.add({
    id: ++actionCounter,
    timestamp,
    action,
    state,
  });
}

export const devtoolsMiddleware =
  (storeAPI: any) => (next: any) => (action: any) => {
    // Use only event timestamp from action.
    const timestamp = resolveActionTimestampMs(action);

    // Attach resolved event-aligned milliseconds.
    if (
      typeof action === "object" &&
      action !== null &&
      typeof timestamp === "number"
    ) {
      action._timestamp = timestamp;
    }

    // Execute action
    const result = next(action);

    // Capture state after
    const state = storeAPI.getState();

    // Push only when event timestamp exists.
    if (typeof timestamp === "number") {
      logAction(action, state, timestamp);
    }

    return result;
  };
