import type { AnyAction } from "@reduxjs/toolkit";
import {
  addDoc,
  collection,
  type DocumentChange,
  type DocumentData,
  type Firestore,
  type FirestoreError,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  startAt,
  Timestamp,
} from "firebase/firestore";
import { 
    getAllCachedActions, 
    cacheActions, 
    getLatestTimestamp, 
    type ActionWithId 
} from "$lib/action-cache";

export async function broadcast(fs: Firestore, uid: string, action: AnyAction) {
  const broadcasts = collection(fs, "broadcast");
  return addDoc(broadcasts, {
    ...action,
    timestamp: serverTimestamp(),
    creator: uid,
  });
}

// Modified callback signature to accept ActionWithId[] directly to simplify usage
// But verifying +layout.svelte usage: it expects "changes: DocumentChange[]"
// I must adapt the cached items to look like DocumentChange or update +layout.svelte.
// Updating +layout.svelte is cleaner. Let's change the callback type here.
export type ActionsCallback = (actions: ActionWithId[]) => void;
export type ErrorCallback = (e: FirestoreError) => void;

interface BroadcastStats {
    fromCache: number;
    fromServer: number;
    duplicates: number;
}
const stats: BroadcastStats = { fromCache: 0, fromServer: 0, duplicates: 0 };

export async function watchBroadcastActions(
  fs: Firestore,
  callback: ActionsCallback,
  errorCallback?: ErrorCallback,
): Promise<() => void> {
  const broadcasts = collection(fs, "broadcast");

  // 1. Load from Cache
  let cachedActions: ActionWithId[] = await getAllCachedActions();
  
  // Sort by timestamp (memory sort for robustness)
  cachedActions.sort((a, b) => {
      const tA = a.timestamp?.seconds || 0;
      const tB = b.timestamp?.seconds || 0;
      if (tA === tB) {
          return (a.timestamp?.nanoseconds || 0) - (b.timestamp?.nanoseconds || 0);
      }
      return tA - tB;
  });

  if (cachedActions.length > 0) {
      stats.fromCache = cachedActions.length;
      callback(cachedActions);
  }

  // 2. Determine Start Point
  const latestTimestamp = getLatestTimestamp(cachedActions);
  
  let q;
  if (latestTimestamp) {
      // Reconstruct Timestamp for FS query to ensure correct type comparison
      const ts = new Timestamp(latestTimestamp.seconds, latestTimestamp.nanoseconds);
      // Use startAt to handle potential duplicates/edge cases
      q = query(broadcasts, orderBy("timestamp"), startAt(ts));
  } else {
      q = query(broadcasts, orderBy("timestamp"));
  }

  // 3. Listen to Firestore
  const unsubscribe = onSnapshot(
    q,
    async (querySnapshot) => {
      const changes = querySnapshot.docChanges();
      const newActions: ActionWithId[] = [];
      const actionsToCache: ActionWithId[] = [];

      // Create a set of known IDs from the current batch/cache to dedupe
      // Note: For a robust system we check against what we've already emitted.
      // But purely for this simplified version, let's check against cachedActions IDs
      // and also maintain a local set of "seen this session".
      
      // Actually, +layout.svelte maintains `executedActions` map to dedupe.
      // So passing duplicates is SAFE but wasteful.
      // We essentially want to filter out what we ALREADY sent from cache.
      
      changes.forEach((change) => {
        if (change.type === "added") {
             // Check if it's a pending write (local optimistic update)
             const isPending = change.doc.metadata.hasPendingWrites;

             const data = change.doc.data();
             const action = {
                 id: change.doc.id,
                 ...data
             } as ActionWithId;

             // Dedupe against cache (simple ID check)
             // CRITICAL: If it's pending, we ALWAYS emit it (so UI updates), but we NEVER cache it.
             // If it's confirmed (server), we check if we already cached it.
             
             if (isPending) {
                 // Optimistic: Emit immediately, don't cache, don't mark as cached.
                 newActions.push(action);
             } else {
                 // Confirmed: Check cache
                 const isCached = cachedActions.some(c => c.id === action.id);
                 if (isCached) {
                     stats.duplicates++;
                 } else {
                     stats.fromServer++;
                     newActions.push(action);
                     actionsToCache.push(action);
                 }
             }
        }
      });

      if (newActions.length > 0) {
          // Only cache confirmed actions
          if (actionsToCache.length > 0) {
              await cacheActions(actionsToCache);
              // Update local memory cache with legitimate confirmed actions
              cachedActions = [...cachedActions, ...actionsToCache];
          }
          
          // Emit all (Pending + New Confirmed)
          // Note: Layout.svelte handles deduplication of execution, so emitting same ID twice (pending then confirmed) is safe/good.
          callback(newActions);
      }

      console.log(`[Broadcast] Stats: Cache=${stats.fromCache}, Server=${stats.fromServer}, Dupes=${stats.duplicates}`);
    },
    (error) => {
      console.log("broadcasts query failing: ");
      console.error(error);
      if (errorCallback) {
        errorCallback(error);
      }
    },
  );

  return unsubscribe;
}
