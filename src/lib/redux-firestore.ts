import type { AnyAction } from "@reduxjs/toolkit";
import {
  addDoc,
  collection,
  documentId,
  type Firestore,
  type FirestoreError,
  getCountFromServer,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  Timestamp,
} from "firebase/firestore";
import { cacheActions, type ActionWithId } from "$lib/action-cache";

// Helper to recursively remove undefined values
function stripUndefined(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(stripUndefined);
  } else if (obj !== null && typeof obj === "object") {
    return Object.entries(obj).reduce((acc, [key, value]) => {
      if (value !== undefined) {
        acc[key] = stripUndefined(value);
      }
      return acc;
    }, {} as any);
  }
  return obj;
}

/**
 * Recursively walk `value` and throw if any node is, or contains, image binary
 * data that must never be persisted in broadcast/sync state.
 *
 * Banned:
 *   - strings starting with "data:"  (inline data URIs / base64)
 *   - strings starting with "blob:"  (transient object URLs)
 *   - Blob / File instances
 *   - ArrayBuffer instances
 */
export function assertNoBinaryPayload(value: any, path = "payload"): void {
  if (value === null || value === undefined) return;

  if (typeof value === "string") {
    if (value.startsWith("data:")) {
      throw new Error(
        `Dirty payload at ${path}: data: URI must not be persisted in broadcast/sync state`,
      );
    }
    if (value.startsWith("blob:")) {
      throw new Error(
        `Dirty payload at ${path}: blob: URL must not be persisted in broadcast/sync state`,
      );
    }
    return;
  }

  if (
    (typeof Blob !== "undefined" && value instanceof Blob) ||
    (typeof File !== "undefined" && value instanceof File)
  ) {
    throw new Error(
      `Dirty payload at ${path}: Blob/File must not be persisted in broadcast/sync state`,
    );
  }

  if (value instanceof ArrayBuffer) {
    throw new Error(
      `Dirty payload at ${path}: ArrayBuffer must not be persisted in broadcast/sync state`,
    );
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoBinaryPayload(value[i], `${path}[${i}]`);
    }
    return;
  }

  if (typeof value === "object") {
    for (const key of Object.keys(value)) {
      assertNoBinaryPayload(value[key], `${path}.${key}`);
    }
  }
}

function validateAction(action: any) {
  assertNoBinaryPayload(action.payload);
  if (action.type === "listingCreation/add_proposals") {
    if (Array.isArray(action.payload)) {
      for (const p of action.payload) {
        if ("inventoryItemIds" in p)
          throw new Error(
            "Dirty payload: add_proposals contains inventoryItemIds",
          );
        if (p.variants) {
          for (const v of p.variants) {
            if ("qty" in v)
              throw new Error("Dirty payload: add_proposals contains qty");
            if ("itemId" in v)
              throw new Error("Dirty payload: add_proposals contains itemId");
          }
        }
      }
    }
  }
  if (action.type === "orderImport/resolve_conflict") {
    const res = action.payload?.resolution;
    if (res && res.type === "data_mismatch") {
      if ("qty" in res)
        throw new Error("Dirty payload: data_mismatch resolution contains qty");
    }
  }
  if (
    action.type === "photos/select_photos" ||
    action.type === "photos/add_selected_photos"
  ) {
    if ("photos" in action.payload)
      throw new Error(
        `Dirty payload: ${action.type} contains 'photos' array (should be 'ids')`,
      );
    if (!("ids" in action.payload))
      throw new Error(`Invalid payload: ${action.type} missing 'ids'`);
  }
  if (action.type === "photos/register_media_items") {
    if (!("items" in action.payload))
      throw new Error(
        "Invalid payload: photos/register_media_items missing 'items'",
      );
    if (!Array.isArray(action.payload.items))
      throw new Error(
        "Invalid payload: photos/register_media_items 'items' must be an array",
      );
  }
}

export async function broadcast(fs: Firestore, uid: string, action: AnyAction) {
  validateAction(action);
  if ((action as any)._ephemeral) {
    console.warn(
      "[Broadcast] Blocked ephemeral action from persistence:",
      action.type,
    );
    return;
  }
  const broadcasts = collection(fs, "broadcast");
  const cleanAction = stripUndefined(action);

  const payloadSize = new TextEncoder().encode(
    JSON.stringify(cleanAction),
  ).length;
  if (payloadSize > 900 * 1024) {
    console.error(
      `[Broadcast] Action ${action.type} is TOO LARGE (${(payloadSize / 1024).toFixed(2)} KB). Dropping.`,
    );
    return Promise.reject(new Error(`Action too large: ${payloadSize} bytes`));
  }

  console.log(
    `[Broadcast] Sending action ${action.type} (${payloadSize} bytes)`,
    cleanAction,
  );

  try {
    const docRef = await addDoc(broadcasts, {
      ...cleanAction,
      timestamp: serverTimestamp(),
      creator: uid,
    });
    console.log(`[Broadcast] Success. Doc ID: ${docRef.id}`);
    return docRef;
  } catch (e) {
    console.error(`[Broadcast] FAILED to write action ${action.type}`, e);
    throw e;
  }
}

export type ActionsCallback = (actions: ActionWithId[]) => void;
export type ErrorCallback = (e: FirestoreError | Error) => void;

export interface BroadcastProgress {
  loaded: number;
  total: number;
  percent: number;
  phase: "counting" | "loading" | "syncing";
  message: string;
}

export interface WatchBroadcastOptions {
  errorCallback?: ErrorCallback;
  onProgress?: (progress: BroadcastProgress) => void;
  onReady?: () => void;
  pageSize?: number;
  resumeCursor?: {
    id: string;
    timestamp: any;
  } | null;
}

interface BroadcastCursor {
  id: string;
  timestamp: Timestamp;
}

const DEFAULT_PAGE_SIZE = 500;

function emitProgress(
  options: WatchBroadcastOptions | undefined,
  progress: BroadcastProgress,
) {
  options?.onProgress?.(progress);
}

function progressPercent(loaded: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((loaded / total) * 1000) / 10);
}

function toActionWithId(doc: { id: string; data(): Record<string, any> }) {
  return {
    id: doc.id,
    ...doc.data(),
  } as ActionWithId;
}

function getCursorFromAction(
  action: ActionWithId | undefined,
): BroadcastCursor | null {
  if (!action?.timestamp) return null;
  const ts = action.timestamp;
  return {
    id: action.id,
    timestamp: new Timestamp(ts.seconds, ts.nanoseconds),
  };
}

function normalizeCursor(
  cursor: WatchBroadcastOptions["resumeCursor"],
): BroadcastCursor | null {
  if (!cursor?.id || !cursor.timestamp) return null;

  const ts = cursor.timestamp;
  if (ts instanceof Timestamp) {
    return {
      id: cursor.id,
      timestamp: ts,
    };
  }

  if (typeof ts.seconds === "number" && typeof ts.nanoseconds === "number") {
    return {
      id: cursor.id,
      timestamp: new Timestamp(ts.seconds, ts.nanoseconds),
    };
  }

  return null;
}

async function pauseForPaint() {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

export async function watchBroadcastActions(
  fs: Firestore,
  callback: ActionsCallback,
  options?: WatchBroadcastOptions,
): Promise<() => void> {
  const broadcasts = collection(fs, "broadcast");
  const pageSize = Math.max(100, options?.pageSize ?? DEFAULT_PAGE_SIZE);
  const knownActionIds = new Set<string>();
  const resumeCursor = normalizeCursor(options?.resumeCursor);

  let totalActions = 0;
  if (!resumeCursor) {
    emitProgress(options, {
      loaded: 0,
      total: 0,
      percent: 0,
      phase: "counting",
      message: "Counting actions...",
    });

    try {
      const countSnapshot = await getCountFromServer(broadcasts);
      totalActions = countSnapshot.data().count;
    } catch (error) {
      console.warn("Failed to count broadcast actions on startup", error);
    }
  }

  emitProgress(options, {
    loaded: 0,
    total: totalActions,
    percent: 0,
    phase: "loading",
    message: resumeCursor
      ? "Checking for new actions..."
      : totalActions > 0
        ? `Loading 0 of ${totalActions.toLocaleString()} actions...`
        : "Loading actions...",
  });

  let loadedActions = 0;
  let lastCursor: BroadcastCursor | null = resumeCursor;

  while (true) {
    const pageQuery = lastCursor
      ? query(
          broadcasts,
          orderBy("timestamp"),
          orderBy(documentId()),
          startAfter(lastCursor.timestamp, lastCursor.id),
          limit(pageSize),
        )
      : query(
          broadcasts,
          orderBy("timestamp"),
          orderBy(documentId()),
          limit(pageSize),
        );

    const pageSnapshot = await getDocs(pageQuery);
    if (pageSnapshot.empty) {
      break;
    }

    const pageActions = pageSnapshot.docs.map(toActionWithId);
    pageActions.forEach((action) => knownActionIds.add(action.id));
    callback(pageActions);
    await cacheActions(pageActions);

    loadedActions += pageActions.length;
    lastCursor = getCursorFromAction(pageActions[pageActions.length - 1]);

    emitProgress(options, {
      loaded: loadedActions,
      total: totalActions,
      percent: resumeCursor ? 0 : progressPercent(loadedActions, totalActions),
      phase: "loading",
      message: resumeCursor
        ? `Loading ${loadedActions.toLocaleString()} new actions...`
        : totalActions > 0
          ? `Loading ${loadedActions.toLocaleString()} of ${totalActions.toLocaleString()} actions...`
          : `Loading ${loadedActions.toLocaleString()} actions...`,
    });

    await pauseForPaint();
  }

  emitProgress(options, {
    loaded: loadedActions,
    total: totalActions,
    percent: totalActions > 0 ? 100 : 0,
    phase: "syncing",
    message: "Starting live sync...",
  });

  const liveQuery = lastCursor
    ? query(
        broadcasts,
        orderBy("timestamp"),
        orderBy(documentId()),
        startAfter(lastCursor.timestamp, lastCursor.id),
      )
    : query(broadcasts, orderBy("timestamp"), orderBy(documentId()));

  const unsubscribe = onSnapshot(
    liveQuery,
    async (querySnapshot) => {
      const newActions: ActionWithId[] = [];
      const actionsToCache: ActionWithId[] = [];

      for (const change of querySnapshot.docChanges()) {
        const action = toActionWithId(change.doc);

        if (change.type === "added") {
          const isPending = change.doc.metadata.hasPendingWrites;
          if (isPending) {
            newActions.push(action);
            continue;
          }
          if (knownActionIds.has(action.id)) {
            continue;
          }
          knownActionIds.add(action.id);
          newActions.push(action);
          actionsToCache.push(action);
          continue;
        }

        if (change.type === "modified") {
          knownActionIds.add(action.id);
          newActions.push(action);
          if (!change.doc.metadata.hasPendingWrites) {
            actionsToCache.push(action);
          }
        }
      }

      if (actionsToCache.length > 0) {
        await cacheActions(actionsToCache);
      }

      if (newActions.length > 0) {
        callback(newActions);
      }
    },
    (error) => {
      console.log("broadcasts query failing: ");
      console.error(error);
      options?.errorCallback?.(error);
    },
  );

  options?.onReady?.();
  return unsubscribe;
}
