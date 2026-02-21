import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import {
  foldSyncRequests,
  type ShopifySyncEvent,
  type ShopifySyncRequestView,
} from "./shopify-sync-model";

export type ShopifySyncState = {
  eventsById: Record<string, ShopifySyncEvent>;
  requestsById: Record<string, ShopifySyncRequestView>;
  requestIds: string[];
  handleToLatestRequestId: Record<string, string>;
};

const initialState: ShopifySyncState = {
  eventsById: {},
  requestsById: {},
  requestIds: [],
  handleToLatestRequestId: {},
};

const slice = createSlice({
  name: "shopifySync",
  initialState,
  reducers: {
    replace_shopify_sync_events(
      state,
      action: PayloadAction<ShopifySyncEvent[]>,
    ) {
      const eventsById: Record<string, ShopifySyncEvent> = {};
      for (const event of action.payload || []) {
        if (!event?.id) continue;
        eventsById[event.id] = event;
      }

      const folded = foldSyncRequests(Object.values(eventsById));
      state.eventsById = eventsById;
      state.requestsById = folded.requestsById;
      state.requestIds = folded.requestIds;
      state.handleToLatestRequestId = folded.handleToLatestRequestId;
    },
    reset_shopify_sync_state() {
      return initialState;
    },
  },
});

export const { replace_shopify_sync_events, reset_shopify_sync_state } =
  slice.actions;
export const shopifySync = slice.reducer;
