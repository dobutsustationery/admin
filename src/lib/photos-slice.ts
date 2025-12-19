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
  knownUploads: Record<string, KnownUpload>; // Permenant history of GP ID -> Drive URL
  janCodeToPhotos: Record<string, MediaItem[]>;
  generating: boolean;
  categorizing: boolean;
}

const initialState: PhotosState = {
  selected: [],
  uploads: {},
  knownUploads: {},
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
      if (!state.knownUploads) state.knownUploads = {};
      if (!state.janCodeToPhotos) state.janCodeToPhotos = {};

      console.log(`[Reducer] Select Photos: merging ${action.payload.photos.length} items. Checking knownUploads registry of size ${Object.keys(state.knownUploads).length}.`);

      // Construct new list, preferring the KNOWN item if it has been uploaded previously
      state.selected = action.payload.photos.map(newItem => {
          // 1. Check Permanent Registry
          const known = state.knownUploads[newItem.id];
          if (known) {
              console.log(`[Reducer] Found known Drive upload for ${newItem.id}`);
              return {
                  ...newItem,
                  baseUrl: known.baseUrl,
                  productUrl: known.productUrl || newItem.productUrl
              };
          }

          // 2. Fallback: Check if the item itself is already a Drive URL (unlikely via Picker, but safety)
          if (newItem.baseUrl && newItem.baseUrl.includes("drive.google.com")) {
               // Update registry while we are at it? Yes.
               state.knownUploads[newItem.id] = { baseUrl: newItem.baseUrl, productUrl: newItem.productUrl };
               return newItem;
          }
          
          return newItem;
      });
      
      // Cleanup uploads map for items no longer present
      // We do NOT clean up knownUploads - that is permanent.
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
      // Do NOT clear knownUploads, janCodeToPhotos
    },
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
        if (!state.uploads) state.uploads = {}; // Hydration safety
        if (!state.knownUploads) state.knownUploads = {};
        if (!state.janCodeToPhotos) state.janCodeToPhotos = {};
        
        // Update Metadata
        if (state.uploads[id]) {
            state.uploads[id].status = 'completed';
        } else {
            state.uploads[id] = { status: 'completed', retryCount: 0, lastAttempt: Date.now() };
        }
        
        // SAVE TO REGISTRY
        state.knownUploads[id] = { baseUrl: permanentUrl, productUrl: webViewLink };

        // Update the actual item in selected list
        const itemIndex = state.selected.findIndex(p => p.id === id);
        if (itemIndex >= 0) {
            state.selected[itemIndex].baseUrl = permanentUrl;
            if (webViewLink) {
                state.selected[itemIndex].productUrl = webViewLink;
            }
        }
        
        // Update item in janCodeToPhotos as well!
        // This is important if an item is categorized efficiently after upload or during upload? 
        // Or if we modify it in place.
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
    merge_jan_groups
} = photosSlice.actions;
export const photos = photosSlice.reducer;
