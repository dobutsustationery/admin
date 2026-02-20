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


export interface PhotoEditQueue {
  queue: ('crop' | 'color_correct' | 'remove_background')[];
  active?: { operation: string, startTime: number };
  history: { operation: string, timestamp: number, status: 'success'|'failed', error?: string }[];
  status: { crop: boolean; color_correct: boolean; remove_background: boolean; };
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
};

function isEphemeralPhotosUrl(url: string | undefined): boolean {
  return !!url && url.includes("googleusercontent.com");
}

const photosSlice = createSlice({
  name: "photos",
  initialState,
  reducers: {
    // ... existing reducers ...
    // Register media items (Fact/Cache) - Persisted to ensure availability
    register_media_items: (state, action: PayloadAction<{ items: MediaItem[] }>) => {
        if (!state.registry) state.registry = {};
        if (!state.urlHistory) state.urlHistory = {};
        
        action.payload.items.forEach(item => {
            state.registry[item.id] = item;
            if (!state.urlHistory[item.id]) {
                state.urlHistory[item.id] = isEphemeralPhotosUrl(item.baseUrl) ? [] : [item.baseUrl];
            }
        });
    },

    // REPLACE operation (Intent: Selection)
    select_photos: (state, action: PayloadAction<{ ids: string[] }>) => {
      // Hydration safety
      if (!state.selected) state.selected = [];
      if (!state.registry) state.registry = {};
      if (!state.urlHistory) state.urlHistory = {};
      if (!state.janCodeToPhotos) state.janCodeToPhotos = {};
      if (!state.edits) state.edits = {};

      console.log(`[Reducer] Select Photos (Replace): setting ${action.payload.ids.length} items.`);

      // Hydrate from Registry
      state.selected = action.payload.ids
          .map(id => state.registry[id])
          .filter(item => !!item) // Filter out missing items
          .map(item => {
              // Ensure we use best known URL
              const hist = state.urlHistory[item.id] || [];
              const currentBestUrl = hist[0] || item.baseUrl;
              return { ...item, baseUrl: currentBestUrl };
          });
      
      const newIds = new Set(state.selected.map(p => p.id));
      
      // Also protect IDs currently in janCodeToPhotos (Categorized)
      if (state.janCodeToPhotos) {
          Object.values(state.janCodeToPhotos).flat().forEach(p => newIds.add(p.id));
      }

      if (!state.uploads) state.uploads = {};
      for (const id in state.uploads) {
          if (!newIds.has(id)) delete state.uploads[id];
      }
      
      if (!state.edits) state.edits = {};
      for (const id in state.edits) {
          if (!newIds.has(id)) delete state.edits[id];
      }
    },
    
    // APPEND operation (Intent: Selection)
    add_selected_photos: (state, action: PayloadAction<{ ids: string[] }>) => {
        if (!state.selected) state.selected = [];
        if (!state.registry) state.registry = {};
        if (!state.urlHistory) state.urlHistory = {};
        
        console.log(`[Reducer] Add Selected Photos: appending ${action.payload.ids.length} items.`);
        
        const existingIds = new Set(state.selected.map(p => p.id));
        const newIds = action.payload.ids.filter(id => !existingIds.has(id));
        
        newIds.forEach(id => {
            const item = state.registry[id];
            if (item) {
                const hist = state.urlHistory[id] || [];
                const currentBestUrl = hist[0] || item.baseUrl;
                state.selected.push({
                    ...item,
                    baseUrl: currentBestUrl
                });
            }
        });
        
        // No cleanup needed for adds
    },
    // ...

    clear_photos: (state) => {
      state.selected = [];
      state.uploads = {};
      // Do NOT clear urlHistory, janCodeToPhotos
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
    uncategorize_photo: (state, action: PayloadAction<{ janCode: string, photoId: string }>) => {
        const { janCode, photoId } = action.payload;
        if (!state.janCodeToPhotos || !state.janCodeToPhotos[janCode]) return;
        state.janCodeToPhotos[janCode] = state.janCodeToPhotos[janCode].filter(p => p.id !== photoId);
        if (state.janCodeToPhotos[janCode].length === 0) {
            delete state.janCodeToPhotos[janCode];
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
        if (!state.registry) state.registry = {};
        
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

        // Update Registry
        if (state.registry[id]) {
            state.registry[id].baseUrl = permanentUrl;
            if (webViewLink) {
                state.registry[id].productUrl = webViewLink;
            }
        }

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
    },
    schedule_edit_batch: (state, action: PayloadAction<{ ids: string[], operation: 'crop' | 'color_correct' | 'remove_background' }>) => {
        const { ids, operation } = action.payload;
        if (!state.edits) state.edits = {};
        
        ids.forEach(id => {
            if (!state.edits[id]) {
                state.edits[id] = { queue: [], history: [], status: { crop: false, color_correct: false, remove_background: false } };
            }
            const q = state.edits[id];
            
            // Check if already marked as DONE (User Logic: avoid reprocessing if checked)
            if (q.status && q.status[operation]) return;
            
            // Check if already queued
            if (q.queue.includes(operation)) return;
            
            // Check if active
            if (q.active?.operation === operation) return;
            
            
            // REMOVED Legacy Check: "Check if most recent history is THIS operation"
            // We now rely solely on q.status (checkboxes) above.

            
            q.queue.push(operation);
        });
    },
    begin_edit: (state, action: PayloadAction<{ id: string, operation: string }>) => {
        const { id, operation } = action.payload;
        if (!state.edits || !state.edits[id]) return;
        
        const q = state.edits[id];
        // Remove from queue
        // Note: It might not be at index 0 if we prioritized something else, but typically it is.
        // Or we just strictly pop head? 
        // Let's assume the runner picked the specific op.
        const idx = q.queue.indexOf(operation as any);
        if (idx !== -1) q.queue.splice(idx, 1);
        
        q.active = { operation, startTime: Date.now() };
    },
    complete_edit: (state, action: PayloadAction<{ id: string, operation: string, permanentUrl: string }>) => {
        const { id, operation, permanentUrl } = action.payload;
        
        // 1. Update Edits State
        if (state.edits && state.edits[id]) {
            const q = state.edits[id];
            q.active = undefined;
            q.history.push({ operation, timestamp: Date.now(), status: 'success' });
            
            // Mark as done
            if (!q.status) q.status = { crop: false, color_correct: false, remove_background: false };
            if (operation === 'crop') q.status.crop = true;
            if (operation === 'color_correct') q.status.color_correct = true;
            if (operation === 'remove_background') q.status.remove_background = true;
        }
        
        // 2. Update URL History & Selected Item (Similar to complete_upload)
        if (!state.urlHistory) state.urlHistory = {};
        if (!state.registry) state.registry = {};
        if (!state.urlHistory[id]) state.urlHistory[id] = [];
        state.urlHistory[id].unshift(permanentUrl);
        
        // Update Registry
        if (state.registry[id]) {
            state.registry[id].baseUrl = permanentUrl;
        }

        const itemIndex = state.selected.findIndex(p => p.id === id);
        if (itemIndex >= 0) {
            state.selected[itemIndex].baseUrl = permanentUrl;
        }
        
        // Update Jan Groups
        if (state.janCodeToPhotos) {
             for (const code in state.janCodeToPhotos) {
                const idx = state.janCodeToPhotos[code].findIndex(p => p.id === id);
                if (idx >= 0) {
                    state.janCodeToPhotos[code][idx].baseUrl = permanentUrl; // Update view
                }
            }
        }
    },
    fail_edit: (state, action: PayloadAction<{ id: string, operation: string, error: string }>) => {
        const { id, operation, error } = action.payload;
        if (state.edits && state.edits[id]) {
            const q = state.edits[id];
            q.active = undefined;
            // Push to history as failed?
            q.history.push({ operation, timestamp: Date.now(), status: 'failed', error });
            // Optionally re-queue? For now, failure is terminal unless manual retry.
        }
    },
    toggle_edit_status: (state, action: PayloadAction<{ id: string, operation: 'crop' | 'color_correct' | 'remove_background' }>) => {
        const { id, operation } = action.payload;
        if (!state.edits) state.edits = {};
        if (!state.edits[id]) {
             state.edits[id] = { queue: [], history: [], status: { crop: false, color_correct: false, remove_background: false } };
        }
        const q = state.edits[id];
        if (!q.status) q.status = { crop: false, color_correct: false, remove_background: false };
        
        q.status[operation] = !q.status[operation];
    }
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
    toggle_edit_status
} = photosSlice.actions;
export const photos = photosSlice.reducer;
