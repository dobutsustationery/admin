import { createSlice, type PayloadAction, type ThunkAction } from "@reduxjs/toolkit";
import type { AnyAction } from "redux"; 
import type { GlobalState } from "./store";
import type { Item } from "./inventory";

// Define AppThunk locally if not exported
export type AppThunk<ReturnType = void> = ThunkAction<
  ReturnType,
  GlobalState,
  unknown,
  AnyAction
>;

// --- Types ---

export interface ListingVariant {
  itemId: string;
  option1Value: string; // e.g. "Red"
}

export interface ListingProposal {
  // Source Data (Immutable)
  janCode: string;
  inventoryItemIds: string[];
  photoGroupIds: string[];

  // Editable Content
  title: string;
  bodyHtml: string;
  productCategory: string;
  vendor: string;
  tags: string[];

  // Variant Config
  option1Name: string; // e.g. "Color"
  variants: ListingVariant[];

  status: 'draft' | 'approved' | 'skipped';
}

export interface ListingCreationState {
  proposals: Record<string, ListingProposal>;
  activeBatchJans: string[];
  currentStepIndex: number;
}

const initialState: ListingCreationState = {
  proposals: {},
  activeBatchJans: [],
  currentStepIndex: 0,
};

// --- Slice ---

const listingCreationSlice = createSlice({
  name: "listingCreation",
  initialState,
  reducers: {
    // Session / Batch
    set_proposals: (state, action: PayloadAction<ListingProposal[]>) => {
        action.payload.forEach(p => {
            state.proposals[p.janCode] = p;
        });
    },
    start_batch: (state, action: PayloadAction<{ janCodes: string[] }>) => {
        state.activeBatchJans = action.payload.janCodes;
        state.currentStepIndex = 0;
    },
    
    // Editing
    update_proposal_field: (state, action: PayloadAction<{ janCode: string, field: keyof ListingProposal, value: any }>) => {
        const { janCode, field, value } = action.payload;
        if (state.proposals[janCode]) {
            // @ts-ignore - dynamic field access
            state.proposals[janCode][field] = value;
        }
    },
    set_variant_option_name: (state, action: PayloadAction<{ janCode: string, name: string }>) => {
         const { janCode, name } = action.payload;
         if (state.proposals[janCode]) {
             state.proposals[janCode].option1Name = name;
         }
    },
    
    // Review
    approve_proposal: (state, action: PayloadAction<{ janCode: string }>) => {
        const { janCode } = action.payload;
        if (state.proposals[janCode]) {
            state.proposals[janCode].status = 'approved';
        }
    },
    skip_proposal: (state, action: PayloadAction<{ janCode: string }>) => {
        const { janCode } = action.payload;
         if (state.proposals[janCode]) {
            state.proposals[janCode].status = 'skipped';
        }
    },
    
    // UI
    next_step: (state) => {
        state.currentStepIndex++;
    },
    complete_batch: (state) => {
        state.activeBatchJans = [];
        state.currentStepIndex = 0;
        // Optionally archive proposals here
    }
  },
});

export const { 
    set_proposals, 
    start_batch, 
    update_proposal_field, 
    set_variant_option_name,
    approve_proposal,
    skip_proposal,
    next_step,
    complete_batch
} = listingCreationSlice.actions;

export default listingCreationSlice.reducer;

// --- Thunks ---

export const generate_proposals = (): AppThunk => (dispatch, getState) => {
    const { inventory, photos } = getState();
    
    const candidates: ListingProposal[] = [];
    
    // Find items that have a JAN, have Photos, but NO handle
    // For demonstrative purposes, we'll scan all items in JanCodeToPhotos
    const allJanGroups = photos.janCodeToPhotos || {};
    
    for (const janCode in allJanGroups) {
        // Find matching inventory items by ID
        const inventoryItems: { id: string, item: Item }[] = [];
        
        for (const [id, val] of Object.entries(inventory.idToItem)) {
            const item = val as Item;
            if (item.janCode === janCode && !item.handle) {
                inventoryItems.push({ id, item });
            }
        }
            
        if (inventoryItems.length > 0) {
             const firstItem = inventoryItems[0].item;
             const inventoryIds = inventoryItems.map(x => x.id);

             // Create Proposal
             candidates.push({
                 janCode,
                 inventoryItemIds: inventoryIds,
                 photoGroupIds: [janCode], // Simplified for now
                 title: `[DRAFT] ${firstItem.description || 'New Product'}`,
                 bodyHtml: "<p>Generated description from AI...</p>",
                 productCategory: "Stationery",
                 vendor: "Dobutsu",
                 tags: ["New Arrival"],
                 option1Name: "Color",
                 variants: inventoryItems.map(x => ({ 
                     itemId: x.id, 
                     option1Value: x.item.subtype || "Default" 
                 })),
                 status: 'draft'
             });
        }
        
        // LIMIT TO 10 for demo/safety
        if (candidates.length >= 10) break;
    }
    
    // Dispatch
    if (candidates.length > 0) {
        dispatch(set_proposals(candidates));
    }
};

export const approve_proposal_thunk = (janCode: string): AppThunk => (dispatch, getState) => {
    // 1. Mark as Approved
    dispatch(approve_proposal({ janCode }));
    
    // 2. Persist Real Listing (Thunk side effect)
    // dispatch(create_listing(...)) // TODO: Import from listings-slice
    
    // 3. Update Inventory Items (Thunk side effect)
    // dispatch(update_item(...)) // TODO: Link items
    
    // 4. Advance UI
    // Check if we are done?
    const state = getState().listingCreation;
    if (state.currentStepIndex < state.activeBatchJans.length - 1) {
        dispatch(next_step());
    } else {
        dispatch(complete_batch());
    }
};
