import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { MediaItem } from "./google-photos";

export interface UploadState {
  status: 'pending' | 'uploading' | 'completed' | 'failed';
  retryCount: number;
  lastAttempt: number;
  error?: string;
}

export interface KnownUpload {
  baseUrl: string;
  productUrl?: string;
}

interface PhotosState {
  selected: MediaItem[];
  uploads: Record<string, UploadState>;
  urlHistory: Record<string, string[]>; // Permanent history of URLs [current, ...old]
  janCodeToPhotos: Record<string, MediaItem[]>;
  generating: boolean;
  categorizing: boolean;
}

const initialState: PhotosState = {
  selected: [],
  uploads: {},
  urlHistory: {},
  janCodeToPhotos: {},
  generating: false,
  categorizing: false,
};

const photosSlice = createSlice({
  name: "photos",
  initialState,
  reducers: {
    select_photos: (state, action: PayloadAction<{ photos: MediaItem[] }>) => {
      // Hydration safety
      if (!state.selected) state.selected = [];
      if (!state.urlHistory) state.urlHistory = {};
      if (!state.janCodeToPhotos) state.janCodeToPhotos = {};

      console.log(`[Reducer] Select Photos: merging ${action.payload.photos.length} items.`);

      // Construct new list
      state.selected = action.payload.photos.map(newItem => {
          // 1. Initialize History if new
          if (!state.urlHistory[newItem.id]) {
               // If item comes with a Drive URL initially (rare), trust it? Or just push whatever valid URL it has.
               state.urlHistory[newItem.id] = [newItem.baseUrl];
          } else {
               // Ensure the picker URL is recorded if it's new/different?
               // Usually picker URLs expire, so we might not want to rely on them too much if we have a stable Drive URL.
               // For now, if we have history, we prefer the history[0] (Current Best URL).
               
               // Optional: Push the new picker URL to end of history if we want to keep it?
               // Actually, if we have a Drive URL (permanent), we likely don't care about a temporary picker URL.
               // So we just USE the history[0] as the baseUrl for the item in state.
          }

          const currentBestUrl = state.urlHistory[newItem.id][0];

          return {
              ...newItem,
              baseUrl: currentBestUrl,
              // Keep original productUrl (WebViewLink) unless we store that in history too? 
              // The requirement was id->URLs (strings). 
              // So we keep productUrl as is from input or maybe we need to track that too? 
              // For now, let's assume specific history is for the IMAGE SOURCE (baseUrl).
          };
      });
      
      // Cleanup uploads map for items no longer present
      const newIds = new Set(state.selected.map(p => p.id));
      if (!state.uploads) state.uploads = {};
      for (const id in state.uploads) {
          if (!newIds.has(id)) {
              delete state.uploads[id];
          }
      }
    },
    clear_photos: (state) => {
      state.selected = [];
      state.uploads = {};
      // Do NOT clear urlHistory, janCodeToPhotos
    },
    // ... merge_jan_groups, rename_jan_groups, etc remain unchanged ...
    merge_jan_groups: (state, action: PayloadAction<{ sourceJan: string, targetJan: string }>) => {
        const { sourceJan, targetJan } = action.payload;
        if (!state.janCodeToPhotos) return;

        const sourcePhotos = state.janCodeToPhotos[sourceJan] || [];
        if (sourcePhotos.length === 0) return;

        // Move photos to target
        if (!state.janCodeToPhotos[targetJan]) {
            state.janCodeToPhotos[targetJan] = [];
        }
        state.janCodeToPhotos[targetJan].push(...sourcePhotos);

        // Remove source
        delete state.janCodeToPhotos[sourceJan];
    },
    rename_jan_group: (state, action: PayloadAction<{ oldJan: string, newJan: string }>) => {
        const { oldJan, newJan } = action.payload;
        if (!state.janCodeToPhotos) return;
        
        // Validation: Check content
        const cleanNewJan = newJan ? newJan.trim() : "";

        if (cleanNewJan === oldJan) return;

        const sourcePhotos = state.janCodeToPhotos[oldJan] || [];
        if (sourcePhotos.length === 0) return;

        // CASE 1: Empty New JAN -> Delete Group
        if (!cleanNewJan) {
            delete state.janCodeToPhotos[oldJan];
            return;
        }

        // CASE 2: Rename / Merge
        if (!state.janCodeToPhotos[cleanNewJan]) {
            state.janCodeToPhotos[cleanNewJan] = [];
        }
        state.janCodeToPhotos[cleanNewJan].push(...sourcePhotos);

        // Delete old key
        delete state.janCodeToPhotos[oldJan];
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
    categorize_photo: (state, action: PayloadAction<{ janCode: string, photo: MediaItem }>) => {
        const { janCode, photo } = action.payload;
        if (!state.janCodeToPhotos) state.janCodeToPhotos = {};
        
        // Add to mapped group
        if (!state.janCodeToPhotos[janCode]) {
            state.janCodeToPhotos[janCode] = [];
        }
        // Dedupe check
        if (!state.janCodeToPhotos[janCode].find(p => p.id === photo.id)) {
            state.janCodeToPhotos[janCode].push(photo);
        }
        
        // Remove from selected list
        if (state.selected) {
            state.selected = state.selected.filter(p => p.id !== photo.id);
        }
    },
    initiate_upload: (state, action: PayloadAction<{ id: string, timestamp: number }>) => {
        const { id, timestamp } = action.payload;
        if (!state.uploads) state.uploads = {}; // Hydration safety
        if (!state.uploads[id]) {
            state.uploads[id] = { status: 'uploading', retryCount: 0, lastAttempt: timestamp };
        } else {
            state.uploads[id].status = 'uploading';
            state.uploads[id].lastAttempt = timestamp;
        }
    },
    complete_upload: (state, action: PayloadAction<{ id: string, permanentUrl: string, webViewLink?: string }>) => {
        const { id, permanentUrl, webViewLink } = action.payload;
        if (!state.uploads) state.uploads = {}; 
        if (!state.urlHistory) state.urlHistory = {};
        if (!state.janCodeToPhotos) state.janCodeToPhotos = {};
        
        // Update Metadata
        if (state.uploads[id]) {
            state.uploads[id].status = 'completed';
        } else {
            state.uploads[id] = { status: 'completed', retryCount: 0, lastAttempt: Date.now() };
        }
        
        // SAVE TO HISTORY
        if (!state.urlHistory[id]) {
             state.urlHistory[id] = []; 
        }
        // Unshift to front (Current Best)
        state.urlHistory[id].unshift(permanentUrl);

        // Update the actual item in selected list
        const itemIndex = state.selected.findIndex(p => p.id === id);
        if (itemIndex >= 0) {
            state.selected[itemIndex].baseUrl = permanentUrl;
            if (webViewLink) {
                state.selected[itemIndex].productUrl = webViewLink;
            }
        }
        
        // Update item in janCodeToPhotos as well
        for (const code in state.janCodeToPhotos) {
            const idx = state.janCodeToPhotos[code].findIndex(p => p.id === id);
            if (idx >= 0) {
                state.janCodeToPhotos[code][idx].baseUrl = permanentUrl;
                if (webViewLink) {
                    state.janCodeToPhotos[code][idx].productUrl = webViewLink;
                }
            }
        }
    },
    fail_upload: (state, action: PayloadAction<{ id: string, error: string }>) => {
        const { id, error } = action.payload;
        if (!state.uploads) state.uploads = {}; // Hydration safety
        if (state.uploads[id]) {
            state.uploads[id].status = 'failed';
            state.uploads[id].error = error;
            state.uploads[id].retryCount += 1;
        } else {
            state.uploads[id] = { status: 'failed', error, retryCount: 1, lastAttempt: Date.now() };
        }
    }
  },
});

export const { 
    select_photos, 
    clear_photos, 
    set_generating,
    begin_categorize,
    end_categorize,
    categorize_photo,
    initiate_upload,
    complete_upload,
    fail_upload,
    merge_jan_groups,
    rename_jan_group
} = photosSlice.actions;
export const photos = photosSlice.reducer;
