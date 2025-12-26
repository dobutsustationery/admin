import { writable } from "svelte/store";

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
    add: (entry: LogEntry) => update(log => {
      const newLog = [entry, ...log];
      if (newLog.length > MAX_HISTORY) {
        return newLog.slice(0, MAX_HISTORY);
      }
      return newLog;
    }),
    clear: () => update(() => [])
  };
}

export const devtoolsStore = createDevToolsStore();

let actionCounter = 0;

// Helper to manually log internal actions (from reducer)
export function logAction(action: any, state: any, timestamp: number = Date.now()) {
  devtoolsStore.add({
    id: ++actionCounter,
    timestamp: timestamp || Date.now(), // Fallback if undefined/null
    action,
    state
  });
}

export const devtoolsMiddleware = (storeAPI: any) => (next: any) => (action: any) => {
  // Capture timestamp before
  const timestamp = Date.now();
  
  // Attach timestamp to action (mutable, but necessary for consistent grouping downstream)
  // Use a non-enumerable property if possible, or just a convention property
  if (typeof action === 'object' && action !== null) {
      action._timestamp = timestamp;
  }
  
  // Execute action
  const result = next(action);
  
  // Capture state after
  const state = storeAPI.getState();
  
  // Push to store (by reference - no serialization cost)
  logAction(action, state, timestamp);

  return result;
};
