import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { MediaItem } from "./google-photos";

export interface UploadState {
  status: 'pending' | 'uploading' | 'completed' | 'failed';
  retryCount: number;
  lastAttempt: number;
  error?: string;
}

interface PhotosState {
  selected: MediaItem[];
  uploads: Record<string, UploadState>;
  generating: boolean;
}

const initialState: PhotosState = {
  selected: [],
  uploads: {},
  generating: false,
};

const photosSlice = createSlice({
  name: "photos",
  initialState,
  reducers: {
    select_photos: (state, action: PayloadAction<{ photos: MediaItem[] }>) => {
      // Logic from Page was: Replace or Add.
      // But typically this action REPLACES state.selected in current impl.
      // If we want to support "Add", we should check previous behavior.
      // Current impl: `state.selected = action.payload.photos;` -> This is REPLACE.
      // To support ADD, we should change this or assume caller merges.
      // Caller (Page) merges: `finalItems = [...old, ...new]`.
      // So this action receives the FULL list.
      state.selected = action.payload.photos;
      
      // Cleanup uploads map for items no longer present?
      // Or just keep it. Keeping it is safer for history, but might grow.
      // Let's perform simple cleanup:
      const newIds = new Set(action.payload.photos.map(p => p.id));
      for (const id in state.uploads) {
          if (!newIds.has(id)) {
              delete state.uploads[id];
          }
      }
    },
    clear_photos: (state) => {
      state.selected = [];
      state.uploads = {};
    },
    set_generating: (state, action: PayloadAction<boolean>) => {
      state.generating = action.payload;
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
        
        // Update Metadata
        if (state.uploads[id]) {
            state.uploads[id].status = 'completed';
        } else {
            state.uploads[id] = { status: 'completed', retryCount: 0, lastAttempt: Date.now() };
        }

        // Update the actual item in selected list
        const itemIndex = state.selected.findIndex(p => p.id === id);
        if (itemIndex >= 0) {
            state.selected[itemIndex].baseUrl = permanentUrl;
            if (webViewLink) {
                state.selected[itemIndex].productUrl = webViewLink;
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
    initiate_upload,
    complete_upload,
    fail_upload
} = photosSlice.actions;
export const photos = photosSlice.reducer;
