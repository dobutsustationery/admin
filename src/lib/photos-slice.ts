import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { MediaItem } from "./google-photos";

interface PhotosState {
  selected: MediaItem[];
  generating: boolean;
}

const initialState: PhotosState = {
  selected: [],
  generating: false,
};

const photosSlice = createSlice({
  name: "photos",
  initialState,
  reducers: {
    select_photos: (state, action: PayloadAction<{ photos: MediaItem[] }>) => {
      state.selected = action.payload.photos;
    },
    clear_photos: (state) => {
      state.selected = [];
    },
    set_generating: (state, action: PayloadAction<boolean>) => {
      state.generating = action.payload;
    },
  },
});

export const { select_photos, clear_photos, set_generating } = photosSlice.actions;
export const photos = photosSlice.reducer;
