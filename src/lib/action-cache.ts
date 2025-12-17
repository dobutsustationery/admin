
const DB_NAME = "dobutsu_actions_db";
const DB_VERSION = 3;
const ACTIONS_STORE = "actions";
const SNAPSHOT_STORE = "snapshot";

export interface ActionWithId {
  id: string;
  timestamp: any; // Firestore timestamp or similar
  [key: string]: any;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
        // SSR safety
        reject(new Error("IndexedDB not supported in SSR"));
        return;
    }
    
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
      console.error("IDB open error:", event);
      reject(request.error);
    };

    request.onsuccess = (event) => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction!;
      
      // Actions Store
      if (!db.objectStoreNames.contains(ACTIONS_STORE)) {
        const s = db.createObjectStore(ACTIONS_STORE, { keyPath: "id" });
        s.createIndex("timestamp_millis", "_timestamp_millis", { unique: false });
      } else {
        const s = tx.objectStore(ACTIONS_STORE);
        if (s.indexNames.contains("timestamp")) {
           s.deleteIndex("timestamp");
        }
        if (!s.indexNames.contains("timestamp_millis")) {
           s.createIndex("timestamp_millis", "_timestamp_millis", { unique: false });
        }
      }

      // Snapshot Store (Singleton)
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE, { keyPath: "key" });
      }
    };
  });
  return dbPromise;
}

export async function getAllCachedActions(): Promise<ActionWithId[]> {
  try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(ACTIONS_STORE, "readonly");
        const store = tx.objectStore(ACTIONS_STORE);
        
        // Use the numeric index
        const index = store.index("timestamp_millis");
        const request = index.getAll();

        request.onsuccess = () => {
          resolve(request.result as ActionWithId[]);
        };
        request.onerror = () => {
          reject(request.error);
        };
      });
  } catch (e) {
      console.warn("Failed to get cached actions", e);
      return [];
  }
}

export async function cacheActions(actions: ActionWithId[]): Promise<void> {
    if (actions.length === 0) return;
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(ACTIONS_STORE, "readwrite");
            const store = tx.objectStore(ACTIONS_STORE);
            
            actions.forEach(action => {
                const record = {
                    ...action,
                    _timestamp_millis: action.timestamp?.seconds ? action.timestamp.seconds * 1000 + action.timestamp.nanoseconds / 1000000 : 0
                };
                
                store.put(record);
            });

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn("Failed to cache actions", e);
    }
}

export function getLatestTimestamp(actions: ActionWithId[]): any | null {
    if (actions.length === 0) return null;
    // Assuming sorted
    return actions[actions.length - 1].timestamp;
}

export async function saveSnapshot(state: any, lastAction: any): Promise<void> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(SNAPSHOT_STORE, "readwrite");
            const store = tx.objectStore(SNAPSHOT_STORE);
            store.put({ key: "current", state, lastAction });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch(e) {
        console.warn("Failed to save snapshot to IDB", e);
    }
}

export async function loadSnapshot(): Promise<{ state: any, lastAction: any } | undefined> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(SNAPSHOT_STORE, "readonly");
            const store = tx.objectStore(SNAPSHOT_STORE);
            const req = store.get("current");
            req.onsuccess = () => {
                resolve(req.result);
            };
            req.onerror = () => reject(req.error);
        });
    } catch(e) {
        console.warn("Failed to load snapshot from IDB", e);
        return undefined;
    }
}
