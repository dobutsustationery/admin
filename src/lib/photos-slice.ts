import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { MediaItem } from "./google-photos";

export interface UploadState {
  status: "pending" | "uploading" | "completed" | "failed";
  retryCount: number;
  lastAttempt: number;
  error?: string;
}

export interface PhotoEditQueue {
  active?: {
    operation: string;
    startTime: number;
  };
  queue: string[];
  history: {
    operation: string;
    timestamp: number;
    status: "success" | "failed";
    error?: string;
  }[];
  status: {
    crop: boolean;
    color_correct: boolean;
    remove_background: boolean;
  };
}

export type ProcessingStepType = "crop" | "color_correct" | "remove_background";

export interface ProcessingStep {
  type: ProcessingStepType;
  enabled: boolean;
}

export interface ProcessingConfig {
  steps: ProcessingStep[];
}

export interface PhotosState {
  selected: MediaItem[];
  uploads: Record<string, UploadState>;
  urlHistory: Record<string, string[]>;
  janCodeToPhotos: Record<string, MediaItem[]>;
  edits: Record<string, PhotoEditQueue>;
  registry: Record<string, MediaItem>; // Cache/Registry of known items
  generating: boolean;
  categorizing: boolean;
  processingConfig: ProcessingConfig;
}

const initialState: PhotosState = {
  selected: [],
  uploads: {},
  urlHistory: {},
  janCodeToPhotos: {},
  edits: {},
  registry: {},
  generating: false,
  categorizing: false,
  processingConfig: {
    steps: [
      { type: "crop", enabled: false },
      { type: "color_correct", enabled: true },
      { type: "remove_background", enabled: true },
    ],
  },
};

function toTimestampMs(ts: any): number {
  if (typeof ts === "number") return ts;
  if (typeof ts?.seconds === "number") {
    const nanos = Number(ts?.nanoseconds || 0);
    return ts.seconds * 1000 + Math.floor(nanos / 1_000_000);
  }
  if (typeof ts?._seconds === "number") {
    const nanos = Number(ts?._nanoseconds || 0);
    return ts._seconds * 1000 + Math.floor(nanos / 1_000_000);
  }
  if (typeof ts?.toDate === "function") return ts.toDate().getTime();
  return 0;
}

function actionTimestampMs(action: any): number {
  return toTimestampMs(action?.timestamp ?? action?._timestamp);
}

function isEphemeralPhotosUrl(url: string | undefined): boolean {
  return !!url && url.includes("googleusercontent.com");
}

const photosSlice = createSlice({
  name: "photos",
  initialState,
  reducers: {
    select_photos: (state, action: PayloadAction<{ ids: string[] }>) => {
      // 1. Initialize maps if missing
      if (!state.urlHistory) state.urlHistory = {};
      if (!state.janCodeToPhotos) state.janCodeToPhotos = {};
      if (!state.edits) state.edits = {};

      console.log(
        `[Reducer] Select Photos (Replace): setting ${action.payload.ids.length} items.`,
      );

      // Fresh selection should clear stale non-completed upload states so
      // reselected items can be retried immediately.
      if (!state.uploads) state.uploads = {};
      action.payload.ids.forEach((id) => {
        const upload = state.uploads[id];
        if (upload && upload.status !== "completed") {
          delete state.uploads[id];
        }
      });

      // Hydrate from Registry
      state.selected = action.payload.ids
        .map((id) => state.registry[id])
        .filter(Boolean);
    },
    add_selected_photos: (state, action: PayloadAction<{ ids: string[] }>) => {
      if (!state.urlHistory) state.urlHistory = {};
      if (!state.janCodeToPhotos) state.janCodeToPhotos = {};
      if (!state.edits) state.edits = {};
      if (!state.uploads) state.uploads = {};

      action.payload.ids.forEach((id) => {
        const upload = state.uploads[id];
        if (upload && upload.status !== "completed") {
          delete state.uploads[id];
        }
      });

      action.payload.ids.forEach((id) => {
        const item = state.registry[id];
        if (item && !state.selected.find((p) => p.id === id)) {
          state.selected.push(item);
        }
      });
    },
    register_media_items: (
      state,
      action: PayloadAction<{ items: MediaItem[] }>,
    ) => {
      if (!state.registry) state.registry = {};
      if (!state.urlHistory) state.urlHistory = {};
      if (!state.uploads) state.uploads = {};

      action.payload.items.forEach((item) => {
        // Always refresh ephemeral URLs with latest picker data.
        // Keep durable URLs unless replaced by another durable URL.
        const existing = state.registry[item.id];
        const incomingBaseUrl = String(item.baseUrl || "");
        const priorBaseUrl = String(existing?.baseUrl || "");
        const isBetter =
          !existing ||
          isEphemeralPhotosUrl(existing.baseUrl) ||
          !isEphemeralPhotosUrl(incomingBaseUrl);

        if (isBetter) {
          state.registry[item.id] = item;
        }

        // Fresh picker selections should clear stale failed/uploading flags so
        // the upload queue can attempt transfer again for this media ID.
        // Do this for ephemeral picker URLs even if URL text happens to match.
        const hasStaleUploadState =
          !!state.uploads[item.id] &&
          state.uploads[item.id].status !== "completed";
        const hasFreshEphemeralUrl = isEphemeralPhotosUrl(incomingBaseUrl);
        const hasChangedUrl =
          incomingBaseUrl && incomingBaseUrl !== priorBaseUrl;
        if (hasStaleUploadState && (hasFreshEphemeralUrl || hasChangedUrl)) {
          delete state.uploads[item.id];
        }

        // Initialize history if missing
        if (!state.urlHistory[item.id]) {
          state.urlHistory[item.id] = [];
        }
        // Don't add ephemeral baseUrls to history automatically, usually we only want durable Drive URLs
        if (
          !isEphemeralPhotosUrl(incomingBaseUrl) &&
          !state.urlHistory[item.id].includes(incomingBaseUrl)
        ) {
          state.urlHistory[item.id].unshift(incomingBaseUrl);
        }
      });
    },
    clear_photos: (state) => {
      state.selected = [];
    },
    set_generating: (state, action: PayloadAction<boolean>) => {
      state.generating = action.payload;
    },
    begin_categorize: (state) => {
      state.categorizing = true;
    },
    end_categorize: (state) => {
      state.categorizing = false;
    },
    categorize_photo: (
      state,
      action: PayloadAction<{ janCode: string; photo: MediaItem }>,
    ) => {
      const { janCode, photo } = action.payload;
      if (!state.janCodeToPhotos) state.janCodeToPhotos = {};
      if (!state.janCodeToPhotos[janCode]) {
        state.janCodeToPhotos[janCode] = [];
      }

      // 1. Remove from selected
      state.selected = state.selected.filter((p) => p.id !== photo.id);

      // 2. Add to group
      if (!state.janCodeToPhotos[janCode].find((p) => p.id === photo.id)) {
        state.janCodeToPhotos[janCode].push(photo);
      }

      // 3. Update Registry (Keep latest info)
      if (!state.registry) state.registry = {};
      state.registry[photo.id] = photo;
    },
    uncategorize_photo: (
      state,
      action: PayloadAction<{ janCode: string; photoId: string }>,
    ) => {
      const { janCode, photoId } = action.payload;
      if (!state.janCodeToPhotos || !state.janCodeToPhotos[janCode]) return;

      const photo = state.janCodeToPhotos[janCode].find(
        (p) => p.id === photoId,
      );
      if (photo) {
        state.janCodeToPhotos[janCode] = state.janCodeToPhotos[janCode].filter(
          (p) => p.id !== photoId,
        );
        if (!state.selected.find((p) => p.id === photoId)) {
          state.selected.push(photo);
        }
      }
    },
    rename_jan_group: (
      state,
      action: PayloadAction<{ oldJan: string; newJan: string }>,
    ) => {
      const { oldJan, newJan } = action.payload;
      if (!state.janCodeToPhotos[oldJan] || oldJan === newJan) return;

      const source = state.janCodeToPhotos[oldJan];
      const target = state.janCodeToPhotos[newJan] || [];
      const seen = new Set(target.map((p) => p.id));
      const merged = [...target];

      for (const photo of source) {
        if (seen.has(photo.id)) continue;
        seen.add(photo.id);
        merged.push(photo);
      }

      state.janCodeToPhotos[newJan] = merged;
      delete state.janCodeToPhotos[oldJan];
    },
    merge_jan_groups: (
      state,
      action: PayloadAction<{ sourceJan: string; targetJan: string }>,
    ) => {
      const { sourceJan, targetJan } = action.payload;
      if (state.janCodeToPhotos[sourceJan]) {
        if (!state.janCodeToPhotos[targetJan]) {
          state.janCodeToPhotos[targetJan] = [];
        }
        state.janCodeToPhotos[targetJan].push(
          ...state.janCodeToPhotos[sourceJan],
        );
        delete state.janCodeToPhotos[sourceJan];
      }
    },
    initiate_upload: (
      state,
      action: PayloadAction<{ id: string; timestamp: number }>,
    ) => {
      const { id } = action.payload;
      if (!state.uploads) state.uploads = {};
      const previous = state.uploads[id];
      state.uploads[id] = {
        status: "uploading",
        retryCount: previous?.retryCount || 0,
        lastAttempt: action.payload.timestamp,
      };
    },
    complete_upload: (
      state,
      action: PayloadAction<{
        id: string;
        permanentUrl: string;
        webViewLink?: string;
      }>,
    ) => {
      const { id, permanentUrl, webViewLink } = action.payload;
      if (!state.uploads) state.uploads = {};
      if (!state.urlHistory) state.urlHistory = {};
      if (!state.janCodeToPhotos) state.janCodeToPhotos = {};
      if (!state.registry) state.registry = {};

      // Update Metadata
      if (state.uploads[id]) {
        state.uploads[id].status = "completed";
      } else {
        state.uploads[id] = {
          status: "completed",
          retryCount: 0,
          lastAttempt: actionTimestampMs(action),
        };
      }

      // SAVE TO HISTORY
      if (!state.urlHistory[id]) {
        state.urlHistory[id] = [];
      }
      // Unshift to front (Current Best) - Prevent consecutive identical URLs
      if (state.urlHistory[id][0] !== permanentUrl) {
        state.urlHistory[id].unshift(permanentUrl);
      }

      // Update Registry
      if (state.registry[id]) {
        state.registry[id].baseUrl = permanentUrl;
        if (webViewLink) {
          state.registry[id].productUrl = webViewLink;
        }
      }

      // Update current collections
      const selIdx = state.selected.findIndex((p) => p.id === id);
      if (selIdx >= 0) {
        state.selected[selIdx].baseUrl = permanentUrl;
        if (webViewLink) {
          state.selected[selIdx].productUrl = webViewLink;
        }
      }

      for (const code in state.janCodeToPhotos) {
        const catIdx = state.janCodeToPhotos[code].findIndex(
          (p) => p.id === id,
        );
        if (catIdx >= 0) {
          state.janCodeToPhotos[code][catIdx].baseUrl = permanentUrl;
          if (webViewLink) {
            state.janCodeToPhotos[code][catIdx].productUrl = webViewLink;
          }
        }
      }
    },
    fail_upload: (
      state,
      action: PayloadAction<{ id: string; error: string; timestamp: number }>,
    ) => {
      const { id, error, timestamp } = action.payload;
      if (!state.uploads) state.uploads = {};
      if (state.uploads[id]) {
        state.uploads[id].status = "failed";
        state.uploads[id].error = error;
        state.uploads[id].retryCount = (state.uploads[id].retryCount || 0) + 1;
        state.uploads[id].lastAttempt = timestamp;
      } else {
        state.uploads[id] = {
          status: "failed",
          retryCount: 1,
          lastAttempt: timestamp,
          error,
        };
      }
    },

    // --- PHOTO EDIT QUEUE ---
    schedule_edit_batch: (
      state,
      action: PayloadAction<{ ids: string[]; operation: string }>,
    ) => {
      const { ids, operation } = action.payload;
      if (!state.edits) state.edits = {};

      ids.forEach((id) => {
        if (!state.edits[id]) {
          state.edits[id] = {
            queue: [],
            history: [],
            status: {
              crop: false,
              color_correct: false,
              remove_background: false,
            },
          };
        }
        if (!state.edits[id].queue.includes(operation)) {
          state.edits[id].queue.push(operation);
        }
      });
    },
    begin_edit: (
      state,
      action: PayloadAction<{ id: string; operation: string }>,
    ) => {
      const { id, operation } = action.payload;
      if (state.edits && state.edits[id]) {
        const q = state.edits[id];
        q.active = { operation, startTime: actionTimestampMs(action) };
        q.queue = q.queue.filter((op) => op !== operation);
      }
    },
    complete_edit: (
      state,
      action: PayloadAction<{
        id: string;
        operation: string;
        permanentUrl: string;
      }>,
    ) => {
      const { id, operation, permanentUrl } = action.payload;
      if (!state.urlHistory) state.urlHistory = {};
      if (!state.registry) state.registry = {};

      // 1. Update Edits State
      if (state.edits && state.edits[id]) {
        const q = state.edits[id];
        q.active = undefined;
        q.history.push({
          operation,
          timestamp: actionTimestampMs(action),
          status: "success",
        });

        // Mark as done
        if (!q.status)
          q.status = {
            crop: false,
            color_correct: false,
            remove_background: false,
          };
        if (operation === "crop") q.status.crop = true;
        if (operation === "color_correct") q.status.color_correct = true;
        if (operation === "remove_background" || operation === "remove_bg")
          q.status.remove_background = true;
      }

      // 2. Update URL History & Selected Item (Similar to complete_upload)
      if (!state.urlHistory[id]) state.urlHistory[id] = [];
      // Unshift to front (Current Best) - Prevent consecutive identical URLs
      if (state.urlHistory[id][0] !== permanentUrl) {
        state.urlHistory[id].unshift(permanentUrl);
      }

      // Update Registry
      if (state.registry[id]) {
        state.registry[id].baseUrl = permanentUrl;
      }

      // Update Current view
      const itemIndex = state.selected.findIndex((p) => p.id === id);
      if (itemIndex >= 0) {
        state.selected[itemIndex].baseUrl = permanentUrl;
      }

      for (const code in state.janCodeToPhotos) {
        const idx = state.janCodeToPhotos[code].findIndex((p) => p.id === id);
        if (idx >= 0) {
          state.janCodeToPhotos[code][idx].baseUrl = permanentUrl; // Update view
        }
      }
    },
    fail_edit: (
      state,
      action: PayloadAction<{ id: string; operation: string; error: string }>,
    ) => {
      const { id, operation, error } = action.payload;
      if (state.edits && state.edits[id]) {
        const q = state.edits[id];
        q.active = undefined;

        // Optimized: Only add to history if the last entry isn't an identical failure.
        // This prevents bloat when re-processing failed batches.
        const last = q.history[q.history.length - 1];
        if (
          last?.operation === operation &&
          last?.status === "failed" &&
          last?.error === error
        ) {
          last.timestamp = actionTimestampMs(action); // Just update timestamp
        } else {
          q.history.push({
            operation,
            timestamp: actionTimestampMs(action),
            status: "failed",
            error,
          });
        }
      }
    },
    toggle_edit_status: (
      state,
      action: PayloadAction<{
        id: string;
        operation: "crop" | "color_correct" | "remove_background";
      }>,
    ) => {
      const { id, operation } = action.payload;
      if (!state.edits) state.edits = {};
      const q = state.edits[id];
      if (!q) return;

      if (!q.status)
        q.status = {
          crop: false,
          color_correct: false,
          remove_background: false,
        };

      q.status[operation] = !q.status[operation];
    },
    set_processing_config: (state, action: PayloadAction<ProcessingConfig>) => {
      state.processingConfig = action.payload;
    },
  },
});

export const {
  select_photos,
  add_selected_photos,
  register_media_items,
  clear_photos,
  set_generating,
  begin_categorize,
  end_categorize,
  categorize_photo,
  uncategorize_photo,
  initiate_upload,
  complete_upload,
  fail_upload,
  merge_jan_groups,
  rename_jan_group,
  schedule_edit_batch, // Export new actions
  begin_edit,
  complete_edit,
  fail_edit,
  toggle_edit_status,
  set_processing_config,
} = photosSlice.actions;
export const photos = photosSlice.reducer;
