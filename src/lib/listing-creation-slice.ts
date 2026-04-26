import {
  createSlice,
  type PayloadAction,
  type ThunkAction,
} from "@reduxjs/toolkit";
import type { AnyAction } from "redux";
import type { GlobalState } from "./store";
import type { Item } from "./inventory";
import { imagePrompt, fetchImage, detectVariants } from "./gemini-client";
import { getStoredToken } from "./google-photos";
import type { ListingImage } from "./listings-slice";
import { categorize_photo, uncategorize_photo } from "./photos-slice";
import { toGoogleDrivePublicImageUrl } from "./drive-url";
import { withTimestamp } from "./timestamped-case-reducer";

// Define AppThunk locally if not exported
export type AppThunk<ReturnType = void> = ThunkAction<
  ReturnType,
  GlobalState,
  unknown,
  AnyAction
>;

// --- Types ---

export interface ListingVariant {
  id: string; // Unique Instance ID
  itemId: string;
  option1Value: string; // e.g. "Red"
  photoGroupKey?: string; // Link to specific photo group
  qty?: number; // Allocated quantity for splitting
  image?: string; // Specific image for this variant (draft override)
}

export interface ListingProposal {
  // Source Data (Immutable)
  janCode: string;
  inventoryItemIds: string[];
  photoGroupIds: string[];

  // Editable Content
  title: string;
  handle?: string; // For merging/grouping
  bodyHtml: string;
  productCategory: string;
  vendor: string;
  tags: string[];

  // AI State
  titlePrompt?: string;
  descriptionPrompt?: string;
  isGeneratingTitle?: boolean;
  isGeneratingDescription?: boolean;

  // Variant Config
  option1Name: string; // e.g. "Color"
  variants: ListingVariant[];
  price?: number; // Draft price override
  listingOnlyImages?: ListingImage[]; // Listing-only images added in detail view
  listingImageOrder?: string[]; // Ordered list of image IDs for draft view
  excludedPhotoIds?: string[]; // IDs of source photos hidden from the listing

  status: "draft" | "approved" | "skipped";
}

export interface CleanListingVariant extends Omit<ListingVariant, "itemId"> {}

export interface CleanListingProposal extends Omit<
  ListingProposal,
  "inventoryItemIds" | "variants"
> {
  variants: CleanListingVariant[];
}

export interface ListingCreationState {
  proposals: Record<string, ListingProposal>;
  activeBatchJans: string[];
  originalBatchJans: string[]; // Source of truth for batch items
  currentStepIndex: number;
  driveConnectionStatus: "unknown" | "connected" | "disconnected";
  activeBatchId?: string;
  activeBatchCreatedAt?: number;
  lastCompletedBatchId?: string; // For UI celebration triggers
  hasCelebrated?: boolean; // Track if we've shown the confetti for the last completion

  // Scanning State
  isScanning?: boolean;
  scanProgress?: {
    current: number;
    total: number;
    message: string;
    lastUpdate: number;
  };
  lastScanTimestamp?: number;
  lastScanJan?: string;

  // Global Defaults (Persisted)
  globalTitlePrompt?: string;
  globalDescriptionPrompt?: string;
  globalVariantPrompt?: string;
}

export const initialState: ListingCreationState = {
  proposals: {},
  activeBatchJans: [],
  originalBatchJans: [],
  currentStepIndex: 0,
  driveConnectionStatus: "unknown",
  activeBatchId: undefined,
  activeBatchCreatedAt: undefined,
  hasCelebrated: false,
  isScanning: false,
  scanProgress: { current: 0, total: 0, message: "", lastUpdate: 0 },
  globalTitlePrompt:
    "Generate a concise, catchy product title for this product. Return ONLY the title text. No quotes.",
  globalDescriptionPrompt:
    "Write a playful product description for this product, formatted with HTML tags. Be very brief. Return ONLY the HTML. Do not include markdown code blocks or conversational text.",
  globalVariantPrompt: `You are a strict JSON generator. Look at these images.
        Task: Group these images into Product Variants (e.g. Red vs Blue) based on their packaging.
        Use only one word for the variant, of the same kind (e.g. use all colors, all shapes, all animals, all foods, etc.)

        RULES:
        1. Identify variants based on **FRONT FACES ONLY**.
        2. If there is only ONE unique front face (e.g. 1 Front + 3 Backs), return NO variants.
        3. Ignore Backs, Ingredients, or Nutrition Labels for the purpose of *counting* variants.
        4. If you find multiple variants, assign ALL images (Fronts AND Backs) to them.
        
        OUTPUT FORMAT:
        If NO variants (Same Product):
        { "variants": [] }

        If YES (Multiple Variants):
        {
            "variants": [
                { "name": "Variant Name", "indices": [0, 1] },
                { "name": "Variant Name", "indices": [2, 3] }
            ]
        }
        
        Return ONLY valid JSON. No markdown. No conversation.`,
};

// --- Slice ---

const actionTimestampMs = (action: { _timestamp: number }): number =>
  action._timestamp;

const listingCreationSlice = createSlice({
  name: "listingCreation",
  initialState,
  reducers: {
    set_drive_connection_status: (
      state,
      action: PayloadAction<"unknown" | "connected" | "disconnected">,
    ) => {
      state.driveConnectionStatus = action.payload;
    },
    set_global_prompts: (
      state,
      action: PayloadAction<{
        titlePrompt?: string;
        descriptionPrompt?: string;
        variantPrompt?: string;
      }>,
    ) => {
      if (action.payload.titlePrompt)
        state.globalTitlePrompt = action.payload.titlePrompt;
      if (action.payload.descriptionPrompt)
        state.globalDescriptionPrompt = action.payload.descriptionPrompt;
      if (action.payload.variantPrompt)
        state.globalVariantPrompt = action.payload.variantPrompt;
    },
    set_scanning: withTimestamp((state, action) => {
      state.isScanning = action.payload;
      if (action.payload) {
        state.lastScanTimestamp = actionTimestampMs(action);
      } else {
        state.scanProgress = {
          current: 0,
          total: 0,
          message: "",
          lastUpdate: 0,
        };
        state.lastScanTimestamp = undefined;
        state.lastScanJan = undefined;
      }
    }),
    set_scan_progress: withTimestamp((state, action) => {
      state.scanProgress = {
        ...action.payload,
        lastUpdate: actionTimestampMs(action),
      };
      state.lastScanTimestamp = actionTimestampMs(action);
      if (action.payload.janCode) {
        state.lastScanJan = action.payload.janCode;
      }
    }),
    // Session / Batch
    add_proposals_internal: (
      state,
      action: PayloadAction<ListingProposal[]>,
    ) => {
      if (!state.proposals) state.proposals = {};
      action.payload.forEach((p) => {
        state.proposals[p.janCode] = p;
      });
    },
    // Intent-only action (Handled by RootReducer to enrich with Inventory Data)
    add_proposals: (state, action: PayloadAction<CleanListingProposal[]>) => {
      // No-op in slice
    },
    remove_proposal: (state, action: PayloadAction<{ janCode: string }>) => {
      const { janCode } = action.payload;
      if (state.proposals) {
        delete state.proposals[janCode];
      }
      state.activeBatchJans = state.activeBatchJans.filter(
        (jan) => jan !== janCode,
      );
      state.originalBatchJans = state.originalBatchJans.filter(
        (jan) => jan !== janCode,
      );
      if (state.currentStepIndex >= state.activeBatchJans.length) {
        state.currentStepIndex = Math.max(0, state.activeBatchJans.length - 1);
      }
    },
    start_batch: withTimestamp((state, action) => {
      state.activeBatchJans = action.payload.janCodes;
      state.originalBatchJans = action.payload.janCodes; // Set source
      state.currentStepIndex = -1; // -1 = Batch Overview / Bulk Edit
      state.activeBatchId = action.payload.batchId;
      state.activeBatchCreatedAt = actionTimestampMs(action);
      state.lastCompletedBatchId = undefined;
      state.hasCelebrated = false;
      if (!state.proposals) state.proposals = {};
    }),
    set_current_step: (state, action: PayloadAction<number>) => {
      state.currentStepIndex = action.payload;
    },
    recalculate_batch_navigation: (state) => {
      if (!state.proposals) return;
      const sourceJans =
        state.originalBatchJans && state.originalBatchJans.length > 0
          ? state.originalBatchJans
          : state.activeBatchJans;

      const seenHandles = new Set<string>();
      const newBatchOrder: string[] = [];

      sourceJans.forEach((jan) => {
        const p = state.proposals[jan];
        if (!p) return;
        const key = p.handle || p.janCode;
        if (!seenHandles.has(key)) {
          seenHandles.add(key);
          newBatchOrder.push(jan);
        }
      });
      state.activeBatchJans = newBatchOrder;
    },

    reorder_variants: (
      state,
      action: PayloadAction<{ janCode: string; newVariantOrder: string[] }>,
    ) => {
      const { janCode, newVariantOrder } = action.payload;
      if (!state.proposals) return;
      const proposal = state.proposals[janCode];
      if (!proposal || !proposal.variants) return;

      const byId = new Map(proposal.variants.map((v) => [v.id, v]));
      const newVariants: ListingVariant[] = [];

      newVariantOrder.forEach((id) => {
        let v = byId.get(id);
        if (!v) {
          // Robust matching for replay: try to find a variant with same JAN:Subtype prefix
          const prefix = id.split(":").slice(0, 2).join(":");
          const match = Array.from(byId.values()).find((existing) =>
            existing.id.startsWith(prefix),
          );
          if (match) {
            v = match;
            byId.delete(match.id);
          }
        } else {
          byId.delete(id);
        }

        if (v) {
          newVariants.push(v);
        }
      });
      // Append any remaining variants that weren't in the new order
      Array.from(byId.values()).forEach((v) => newVariants.push(v));
      proposal.variants = newVariants;
    },

    // Intent Actions (handled by RootReducer)
    add_variant_requested: (
      state,
      action: PayloadAction<{
        targetJan: string;
        janCode: string;
        variantId: string;
        subtype?: string;
        qty?: number;
        sourceVariantId?: string;
      }>,
    ) => {
      // No-op in slice, logic in RootReducer
    },
    remove_variant_requested: (
      state,
      action: PayloadAction<{ janCode: string; variantId: string }>,
    ) => {
      // No-op in slice, logic in RootReducer
    },

    // Editing
    update_proposal_field: (
      state,
      action: PayloadAction<{
        janCode: string;
        field: keyof ListingProposal;
        value: any;
      }>,
    ) => {
      const { janCode, field, value } = action.payload;
      if (state.proposals && state.proposals[janCode]) {
        // @ts-ignore - dynamic field access
        state.proposals[janCode][field] = value;
      }
    },
    add_listing_only_image: (
      state,
      action: PayloadAction<{ janCode: string; image: ListingImage }>,
    ) => {
      const { janCode, image } = action.payload;
      if (!state.proposals) return;
      const proposal = state.proposals[janCode];
      if (!proposal) return;
      if (!proposal.listingOnlyImages) proposal.listingOnlyImages = [];
      proposal.listingOnlyImages.push(image);
      if (proposal.listingImageOrder && proposal.listingImageOrder.length > 0) {
        proposal.listingImageOrder.push(image.id);
      }
    },
    remove_listing_only_image: (
      state,
      action: PayloadAction<{ janCode: string; imageId: string }>,
    ) => {
      const { janCode, imageId } = action.payload;
      if (!state.proposals) return;
      const proposal = state.proposals[janCode];
      if (!proposal?.listingOnlyImages) return;
      proposal.listingOnlyImages = proposal.listingOnlyImages.filter(
        (img) => img.id !== imageId,
      );
      if (proposal.listingImageOrder) {
        proposal.listingImageOrder = proposal.listingImageOrder.filter(
          (id) => id !== imageId,
        );
      }
    },
    exclude_proposal_photo: (
      state,
      action: PayloadAction<{ janCode: string; photoId: string }>,
    ) => {
      const { janCode, photoId } = action.payload;
      if (!state.proposals) return;
      const p = state.proposals[janCode];
      if (p) {
        if (!p.excludedPhotoIds) p.excludedPhotoIds = [];
        if (!p.excludedPhotoIds.includes(photoId))
          p.excludedPhotoIds.push(photoId);
      }
    },
    include_proposal_photo: (
      state,
      action: PayloadAction<{ janCode: string; photoId: string }>,
    ) => {
      const { janCode, photoId } = action.payload;
      if (!state.proposals) return;
      const p = state.proposals[janCode];
      if (p && p.excludedPhotoIds) {
        p.excludedPhotoIds = p.excludedPhotoIds.filter((id) => id !== photoId);
      }
    },
    set_variant_option_name: (
      state,
      action: PayloadAction<{ janCode: string; name: string }>,
    ) => {
      const { janCode, name } = action.payload;
      if (state.proposals && state.proposals[janCode]) {
        state.proposals[janCode].option1Name = name;
      }
    },
    update_variant_value: (
      state,
      action: PayloadAction<{
        janCode: string;
        variantId: string;
        value: string;
      }>,
    ) => {
      const { janCode, variantId, value } = action.payload;
      if (!state.proposals) return;
      const proposal = state.proposals[janCode];
      if (proposal) {
        const variant = proposal.variants.find(
          (v) => v.id === variantId || v.itemId === variantId,
        );
        if (variant) {
          variant.option1Value = value;
        }
      }
    },
    update_variant_qty: (
      state,
      action: PayloadAction<{
        janCode: string;
        variantId: string;
        qty: number;
      }>,
    ) => {
      const { janCode, variantId, qty } = action.payload;
      if (!state.proposals) return;
      const proposal = state.proposals[janCode];
      if (proposal) {
        const variant = proposal.variants.find(
          (v) => v.id === variantId || v.itemId === variantId,
        );
        if (variant) {
          variant.qty = qty;
        }
      }
    },
    update_variant_image: (
      state,
      action: PayloadAction<{
        janCode: string;
        variantId: string;
        image: string;
      }>,
    ) => {
      const { janCode, variantId, image } = action.payload;
      if (!state.proposals) return;
      const proposal = state.proposals[janCode];
      if (proposal) {
        const variant = proposal.variants.find(
          (v) => v.id === variantId || v.itemId === variantId,
        );
        if (variant) {
          variant.image = image;
        }
      }
    },
    set_variant_photo_group: (
      state,
      action: PayloadAction<{
        janCode: string;
        variantId: string;
        groupKey: string | null;
      }>,
    ) => {
      const { janCode, variantId, groupKey } = action.payload;
      if (!state.proposals) return;
      const proposal = state.proposals[janCode];
      if (proposal) {
        const variant = proposal.variants.find(
          (v) => v.id === variantId || v.itemId === variantId,
        );
        if (variant) {
          if (groupKey === null) {
            delete variant.photoGroupKey;
          } else {
            variant.photoGroupKey = groupKey;
          }
        }
      }
    },
    add_variant: (
      state,
      action: PayloadAction<{
        targetJan: string;
        janCode: string;
        itemId: string;
        subtype: string;
        qty: number;
        variantId: string;
      }>,
    ) => {
      const { targetJan, janCode, itemId, subtype, qty, variantId } =
        action.payload;
      if (!state.proposals) state.proposals = {};
      const proposal = state.proposals[targetJan];
      if (!proposal) return;

      const newVariant = {
        id: variantId,
        itemId,
        option1Value: subtype,
        qty,
      };

      proposal.variants.push(newVariant);
      if (!proposal.inventoryItemIds.includes(itemId)) {
        proposal.inventoryItemIds.push(itemId);
      }
      if (janCode !== targetJan && !proposal.photoGroupIds.includes(janCode)) {
        proposal.photoGroupIds.push(janCode);
      }
    },
    remove_variant: (
      state,
      action: PayloadAction<{ janCode: string; variantId: string }>,
    ) => {
      const { janCode, variantId } = action.payload;
      if (!state.proposals) return;
      const proposal = state.proposals[janCode];
      if (!proposal) return;

      const vIdx = proposal.variants.findIndex((v) => v.id === variantId);
      if (vIdx === -1) return;

      const itemId = proposal.variants[vIdx].itemId;
      proposal.variants.splice(vIdx, 1);

      const stillUsesItem = proposal.variants.some((v) => v.itemId === itemId);
      if (!stillUsesItem) {
        proposal.inventoryItemIds = proposal.inventoryItemIds.filter(
          (id) => id !== itemId,
        );
      }

      if (proposal.variants.length === 0) {
        delete state.proposals[janCode];
        state.activeBatchJans = state.activeBatchJans.filter(
          (j) => j !== janCode,
        );
        state.originalBatchJans = state.originalBatchJans.filter(
          (j) => j !== janCode,
        );
      }
    },
    split_variant: (
      state,
      action: PayloadAction<{
        janCode: string;
        variantId: string;
        newHandle: string;
      }>,
    ) => {
      const { janCode, variantId, newHandle } = action.payload;
      if (!state.proposals) return;
      const source = state.proposals[janCode];
      if (!source) return;
      const sourceHandle =
        source.handle || generateHandle(source.title || "", source.janCode);
      if (sourceHandle === newHandle) {
        return;
      }

      if (source.variants.length <= 1) {
        source.handle = newHandle;
        return;
      }

      const variantIndex = source.variants.findIndex((v) => v.id === variantId);
      if (variantIndex === -1) return;

      const variant = source.variants[variantIndex];
      const targetItemId = variant.itemId;

      const newProposalId = variantId;

      const newProposal: ListingProposal = {
        ...source,
        janCode: source.janCode,
        handle: newHandle,
        inventoryItemIds: [targetItemId],
        photoGroupIds: [...source.photoGroupIds],
        variants: [variant],
        listingOnlyImages: [],
        listingImageOrder: [],
      };

      source.variants.splice(variantIndex, 1);
      source.inventoryItemIds = source.inventoryItemIds.filter(
        (id) => id !== targetItemId,
      );

      state.proposals[newProposalId] = newProposal;
      state.activeBatchJans.push(newProposalId);
      state.originalBatchJans.push(newProposalId);
    },
    move_variant: (
      state,
      action: PayloadAction<{
        sourceJan: string;
        targetJan: string;
        variantId: string;
      }>,
    ) => {
      const { sourceJan, targetJan, variantId } = action.payload;
      if (!state.proposals) return;
      const source = state.proposals[sourceJan];
      const target = state.proposals[targetJan];
      if (!source || !target || sourceJan === targetJan) return;

      const variantIndex = source.variants.findIndex((v) => v.id === variantId);
      if (variantIndex === -1) return;
      const variant = source.variants[variantIndex];
      const targetItemId = variant.itemId;

      target.variants.push(variant);
      if (!target.inventoryItemIds.includes(targetItemId)) {
        target.inventoryItemIds.push(targetItemId);
      }

      source.variants.splice(variantIndex, 1);
      source.inventoryItemIds = source.inventoryItemIds.filter(
        (id) => id !== targetItemId,
      );

      if (source.variants.length === 0) {
        delete state.proposals[sourceJan];
        state.activeBatchJans = state.activeBatchJans.filter(
          (j) => j !== sourceJan,
        );
        state.originalBatchJans = state.originalBatchJans.filter(
          (j) => j !== sourceJan,
        );
      }
    },
    merge_proposal: (
      state,
      action: PayloadAction<{ sourceJan: string; targetJan: string }>,
    ) => {
      const { sourceJan, targetJan } = action.payload;
      if (!state.proposals) return;
      const source = state.proposals[sourceJan];
      const target = state.proposals[targetJan];

      if (!source || !target || sourceJan === targetJan) return;

      target.inventoryItemIds = [
        ...new Set([...target.inventoryItemIds, ...source.inventoryItemIds]),
      ];
      target.photoGroupIds = [
        ...new Set([...target.photoGroupIds, ...source.photoGroupIds]),
      ];
      target.variants = [...target.variants, ...source.variants];

      if (source.listingOnlyImages) {
        target.listingOnlyImages = [
          ...(target.listingOnlyImages || []),
          ...source.listingOnlyImages,
        ];
      }
      if (source.listingImageOrder) {
        target.listingImageOrder = [
          ...(target.listingImageOrder || []),
          ...source.listingImageOrder,
        ];
      }
      if (source.excludedPhotoIds) {
        target.excludedPhotoIds = [
          ...new Set([
            ...(target.excludedPhotoIds || []),
            ...source.excludedPhotoIds,
          ]),
        ];
      }

      delete state.proposals[sourceJan];
      state.activeBatchJans = state.activeBatchJans.filter(
        (j) => j !== sourceJan,
      );
      state.originalBatchJans = state.originalBatchJans.filter(
        (j) => j !== sourceJan,
      );
    },
    merge_proposals: (
      state,
      action: PayloadAction<{ targetJan: string; sourceJans: string[] }>,
    ) => {
      const { targetJan, sourceJans } = action.payload;
      if (!state.proposals) return;
      const target = state.proposals[targetJan];
      if (!target) return;

      const uniqueSources = Array.from(new Set(sourceJans)).filter(
        (j) => j && j !== targetJan,
      );
      if (uniqueSources.length === 0) return;

      uniqueSources.forEach((sourceJan) => {
        const source = state.proposals![sourceJan];
        if (!source) return;

        target.inventoryItemIds = Array.from(
          new Set([...target.inventoryItemIds, ...source.inventoryItemIds]),
        );
        target.photoGroupIds = Array.from(
          new Set([...target.photoGroupIds, ...source.photoGroupIds]),
        );

        const variantsById = new Map<string, ListingVariant>();
        target.variants.forEach((v) => variantsById.set(v.id, v));
        source.variants.forEach((v) => {
          if (!variantsById.has(v.id)) variantsById.set(v.id, v);
        });
        target.variants = Array.from(variantsById.values());

        if (source.listingOnlyImages) {
          const imagesById = new Map<string, ListingImage>();
          (target.listingOnlyImages || []).forEach((img) =>
            imagesById.set(img.id, img),
          );
          source.listingOnlyImages.forEach((img) => {
            if (!imagesById.has(img.id)) imagesById.set(img.id, img);
          });
          target.listingOnlyImages = Array.from(imagesById.values());
        }

        if (source.listingImageOrder) {
          const order = new Set(target.listingImageOrder || []);
          source.listingImageOrder.forEach((id) => {
            if (!order.has(id)) order.add(id);
          });
          target.listingImageOrder = Array.from(order);
        }

        if (source.excludedPhotoIds) {
          target.excludedPhotoIds = Array.from(
            new Set([
              ...(target.excludedPhotoIds || []),
              ...source.excludedPhotoIds,
            ]),
          );
        }

        delete state.proposals![sourceJan];
        state.activeBatchJans = state.activeBatchJans.filter(
          (j) => j !== sourceJan,
        );
        state.originalBatchJans = state.originalBatchJans.filter(
          (j) => j !== sourceJan,
        );
      });
    },
    import_existing_variants: (
      state,
      action: PayloadAction<{ janCode: string; handle: string }>,
    ) => {
      // Handled by RootReducer
    },
    add_variants_internal: (
      state,
      action: PayloadAction<{ janCode: string; variants: ListingVariant[] }>,
    ) => {
      const { janCode, variants } = action.payload;
      if (!state.proposals) state.proposals = {};
      const proposal = state.proposals[janCode];
      if (!proposal) return;

      variants.forEach((variant) => {
        if (!proposal.inventoryItemIds.includes(variant.itemId)) {
          proposal.inventoryItemIds.push(variant.itemId);
          proposal.variants.push(variant);
        }
      });
    },

    // Review
    approve_proposal: (state, action: PayloadAction<{ janCode: string }>) => {
      const { janCode } = action.payload;
      if (state.proposals && state.proposals[janCode]) {
        state.proposals[janCode].status = "approved";
      }
    },

    // UI
    next_step: (state) => {
      state.currentStepIndex++;
    },
    complete_batch: (state) => {
      if (state.activeBatchId) {
        state.lastCompletedBatchId = state.activeBatchId;
      }
      state.activeBatchJans = [];
      state.currentStepIndex = 0;
      state.activeBatchId = undefined;
      state.activeBatchCreatedAt = undefined;
    },
    mark_celebrated: (state) => {
      state.hasCelebrated = true;
    },
    clear_celebration: (state) => {
      state.lastCompletedBatchId = undefined;
      state.hasCelebrated = false;
    },
  },
});

export const {
  set_drive_connection_status,
  set_global_prompts,
  set_scanning,
  set_scan_progress,
  add_proposals,
  add_proposals_internal,
  remove_proposal,
  start_batch,
  update_proposal_field,
  add_listing_only_image,
  remove_listing_only_image,
  exclude_proposal_photo,
  include_proposal_photo,
  set_variant_option_name,
  update_variant_value,
  update_variant_qty,
  update_variant_image,
  set_variant_photo_group,
  add_variant,
  add_variant_requested,
  remove_variant,
  remove_variant_requested,
  split_variant,
  reorder_variants,
  move_variant,
  merge_proposal,
  merge_proposals,
  import_existing_variants,
  add_variants_internal,
  approve_proposal,
  next_step,
  complete_batch,
  mark_celebrated,
  clear_celebration,
  set_current_step,
  recalculate_batch_navigation,
} = listingCreationSlice.actions;

export default listingCreationSlice.reducer;

// --- Thunks ---

import { generateHandle } from "./handle-utils";

export const approve_proposal_thunk =
  (janCode: string): AppThunk =>
  (dispatch, getState) => {
    dispatch(approve_proposal({ janCode }));
    const state = getState();
    const currentActive = state.listingCreation.activeBatchJans;
    if (currentActive.length === 0) return;
    let nextIndex = state.listingCreation.currentStepIndex;
    if (nextIndex < 0) nextIndex = 0;
    if (nextIndex >= currentActive.length) nextIndex = 0;
    dispatch(set_current_step(nextIndex));
  };

export const generate_descriptions_for_batch =
  (janCodes: string[]): AppThunk =>
  async (dispatch, getState) => {
    const state = getState();
    const janToPhotos = state.photos?.janCodeToPhotos || {};
    let accessToken = "";
    try {
      const tokenData = getStoredToken();
      if (tokenData) accessToken = tokenData.access_token;
    } catch (e) {
      console.error("Error reading access token", e);
    }

    for (const janCode of janCodes) {
      const proposal = state.listingCreation.proposals[janCode];
      if (!proposal) continue;
      if (
        proposal.bodyHtml &&
        !proposal.bodyHtml.includes("Generated description from AI") &&
        proposal.bodyHtml.length > 50
      )
        continue;
      const driveGroup = janToPhotos[janCode] || [];
      if (driveGroup.length === 0) continue;
      try {
        dispatch(
          update_proposal_field({
            janCode,
            field: "isGeneratingDescription",
            value: true,
          }),
        );
        dispatch(
          update_proposal_field({
            janCode,
            field: "bodyHtml",
            value: "<p><i>Generating description with AI...</i></p>",
          }),
        );
        const imagesToUse = driveGroup.slice(0, 5);
        const imagePromises = imagesToUse.map((f: any) => {
          const url = toGoogleDrivePublicImageUrl(
            f.baseUrl ||
              f.productUrl ||
              f.publicUrl ||
              f.apiUrl ||
              f.thumbnailLink ||
              "",
          );
          return fetchImage(url, accessToken);
        });
        const imagesData = await Promise.all(imagePromises);
        const defaultPrompt =
          state.listingCreation.globalDescriptionPrompt ||
          "Write a playful product description for this product, formatted with HTML tags. Return ONLY the HTML. Do not include markdown code blocks or conversational text.";
        const prompt = proposal.descriptionPrompt || defaultPrompt;
        let description = await imagePrompt(prompt, imagesData, accessToken);
        if (description) {
          description = description.replace(/```html/g, "").replace(/```/g, "");
          const htmlStart = description.indexOf("<");
          if (htmlStart > -1) description = description.substring(htmlStart);
          description = description.trim();
          dispatch(
            update_proposal_field({
              janCode,
              field: "bodyHtml",
              value: description,
            }),
          );
        }
      } catch (e: any) {
        console.error(`Failed to generate description for ${janCode}`, e);
        dispatch(
          update_proposal_field({
            janCode,
            field: "bodyHtml",
            value: `<p>Failed to generate AI description. Error: ${e.message}</p>`,
          }),
        );
      } finally {
        dispatch(
          update_proposal_field({
            janCode,
            field: "isGeneratingDescription",
            value: false,
          }),
        );
      }
    }
  };

export const regenerate_title =
  (janCode: string, customPrompt?: string): AppThunk =>
  async (dispatch, getState) => {
    const state = getState();
    const proposal = state.listingCreation.proposals[janCode];
    if (!proposal) return;
    if (customPrompt) {
      dispatch(
        update_proposal_field({
          janCode,
          field: "titlePrompt",
          value: customPrompt,
        }),
      );
      dispatch(set_global_prompts({ titlePrompt: customPrompt }));
    }
    dispatch(
      update_proposal_field({
        janCode,
        field: "isGeneratingTitle",
        value: true,
      }),
    );
    try {
      const defaultPrompt =
        state.listingCreation.globalTitlePrompt ||
        `Generate a concise, catchy product title for this product. Return ONLY the title text. No quotes.`;
      dispatch(
        update_proposal_field({
          janCode,
          field: "isGeneratingTitle",
          value: true,
        }),
      );
      dispatch(
        update_proposal_field({
          janCode,
          field: "title",
          value: "Regenerating...",
        }),
      );
      const prompt = customPrompt || proposal.titlePrompt || defaultPrompt;
      const janToPhotos = state.photos?.janCodeToPhotos || {};
      const driveGroup = janToPhotos[janCode] || [];
      const token = getStoredToken();
      const accessToken = token?.access_token || "";
      let description = "";
      if (driveGroup.length > 0) {
        const imagesToUse = driveGroup.slice(0, 3);
        const imagePromises = imagesToUse.map((f: any) => {
          const url = toGoogleDrivePublicImageUrl(
            f.baseUrl ||
              f.productUrl ||
              f.publicUrl ||
              f.apiUrl ||
              f.thumbnailLink ||
              "",
          );
          return fetchImage(url, accessToken);
        });
        const imagesData = await Promise.all(imagePromises);
        description =
          (await imagePrompt(prompt, imagesData, accessToken, undefined)) || "";
      } else {
        description =
          (await imagePrompt(prompt, [], accessToken, undefined)) || "";
      }
      if (description)
        dispatch(
          update_proposal_field({
            janCode,
            field: "title",
            value: description.trim().replace(/^"|"$/g, ""),
          }),
        );
    } catch (e: any) {
      console.error("Title generation failed", e);
    } finally {
      dispatch(
        update_proposal_field({
          janCode,
          field: "isGeneratingTitle",
          value: false,
        }),
      );
    }
  };

export const regenerate_description =
  (janCode: string, customPrompt?: string): AppThunk =>
  async (dispatch, getState) => {
    const state = getState();
    const proposal = state.listingCreation.proposals[janCode];
    if (!proposal) return;
    if (customPrompt)
      dispatch(set_global_prompts({ descriptionPrompt: customPrompt }));
    const janToPhotos = state.photos?.janCodeToPhotos || {};
    let allPhotos: any[] = [];
    proposal.variants.forEach((v: ListingVariant) => {
      if (v.photoGroupKey && janToPhotos[v.photoGroupKey])
        allPhotos.push(...janToPhotos[v.photoGroupKey]);
      const item = state.inventory.idToItem[v.itemId];
      if (item && item.janCode) {
        const photos = janToPhotos[item.janCode] || [];
        allPhotos = [...allPhotos, ...photos];
      }
    });
    if (proposal.photoGroupIds) {
      proposal.photoGroupIds.forEach((gid: string) => {
        if (janToPhotos[gid]) allPhotos.push(...janToPhotos[gid]);
      });
    }
    if (allPhotos.length === 0) {
      const photos = janToPhotos[proposal.janCode] || [];
      allPhotos = [...allPhotos, ...photos];
    }
    const seenUrls = new Set();
    allPhotos = allPhotos.filter((p) => {
      const url = p.baseUrl || p.thumbnailLink || p.productUrl;
      if (seenUrls.has(url)) return false;
      seenUrls.add(url);
      return true;
    });
    if (allPhotos.length === 0) return;
    dispatch(
      update_proposal_field({
        janCode,
        field: "isGeneratingDescription",
        value: true,
      }),
    );
    dispatch(
      update_proposal_field({
        janCode,
        field: "bodyHtml",
        value: "<p><i>Regenerating description...</i></p>",
      }),
    );
    try {
      const token = getStoredToken();
      const accessToken = token?.access_token || "";
      const imagesToUse = allPhotos.slice(0, 5);
      const imagePromises = imagesToUse.map((f: any) => {
        const url = toGoogleDrivePublicImageUrl(
          f.baseUrl ||
            f.productUrl ||
            f.publicUrl ||
            f.apiUrl ||
            f.thumbnailLink ||
            "",
        );
        return fetchImage(url, accessToken);
      });
      const imagesData = await Promise.all(imagePromises);
      const defaultPrompt =
        state.listingCreation.globalDescriptionPrompt ||
        "Write a playful product description for this product, formatted with HTML tags. Return ONLY the HTML. Do not include markdown code blocks or conversational text.";
      const prompt = customPrompt || defaultPrompt;
      let description = await imagePrompt(
        prompt,
        imagesData,
        accessToken,
        undefined,
      );
      if (description) {
        description = description.replace(/```html/g, "").replace(/```/g, "");
        const htmlStart = description.indexOf("<");
        if (htmlStart > -1) description = description.substring(htmlStart);
        description = description.trim();
        dispatch(
          update_proposal_field({
            janCode,
            field: "bodyHtml",
            value: description,
          }),
        );
      }
    } catch (e: any) {
      console.error(`Failed to regenerate description for ${janCode}`, e);
    } finally {
      dispatch(
        update_proposal_field({
          janCode,
          field: "isGeneratingDescription",
          value: false,
        }),
      );
    }
  };

export const set_proposal_handle_thunk =
  (
    janCode: string,
    variantId: string | undefined,
    newHandle: string,
  ): AppThunk =>
  (dispatch, getState) => {
    const state = getState();
    const proposals = Object.values(
      state.listingCreation.proposals,
    ) as ListingProposal[];
    const sourceProposal = state.listingCreation.proposals[janCode];
    if (!sourceProposal) return;
    const currentHandle =
      sourceProposal.handle ||
      generateHandle(sourceProposal.title || "", sourceProposal.janCode);
    if (currentHandle === newHandle) return;
    const targetGroup = proposals.filter((p: ListingProposal) => {
      if (p.janCode === janCode) return false;
      const h = p.handle || generateHandle(p.title || "", p.janCode);
      return h === newHandle;
    });
    if (targetGroup.length > 0) {
      const target = targetGroup[0] as ListingProposal;
      const isMultiVariant =
        sourceProposal.variants && sourceProposal.variants.length > 1;
      if (isMultiVariant && variantId) {
        dispatch(
          move_variant({
            sourceJan: janCode,
            targetJan: target.janCode,
            variantId,
          }),
        );
      } else {
        dispatch(
          update_proposal_field({ janCode, field: "handle", value: newHandle }),
        );
      }
    } else {
      const existingListing = state.listings.handleToListing[newHandle];
      if (existingListing) {
        dispatch(
          update_proposal_field({
            janCode,
            field: "title",
            value: existingListing.title,
          }),
        );
        dispatch(
          update_proposal_field({
            janCode,
            field: "bodyHtml",
            value: existingListing.bodyHtml,
          }),
        );
        dispatch(
          update_proposal_field({
            janCode,
            field: "productCategory",
            value: existingListing.productCategory,
          }),
        );
        dispatch(
          update_proposal_field({
            janCode,
            field: "vendor",
            value: existingListing.vendor,
          }),
        );
        dispatch(
          update_proposal_field({
            janCode,
            field: "tags",
            value: existingListing.tags || [],
          }),
        );
        dispatch(
          update_proposal_field({
            janCode,
            field: "option1Name",
            value: existingListing.option1Name || "Option",
          }),
        );
        const isMultiVariant =
          sourceProposal.variants && sourceProposal.variants.length > 1;
        if (isMultiVariant && variantId) {
          dispatch(split_variant({ janCode, variantId, newHandle }));
          dispatch(set_proposal_handle_thunk(variantId, undefined, newHandle));
          return;
        } else {
          dispatch(
            update_proposal_field({
              janCode,
              field: "handle",
              value: newHandle,
            }),
          );
        }
        dispatch(import_existing_variants({ janCode, handle: newHandle }));
      } else {
        const isMultiVariant =
          sourceProposal.variants && sourceProposal.variants.length > 1;
        if (isMultiVariant && variantId)
          dispatch(split_variant({ janCode, variantId, newHandle }));
        else
          dispatch(
            update_proposal_field({
              janCode,
              field: "handle",
              value: newHandle,
            }),
          );
      }
    }
  };

export const generate_proposals =
  (): AppThunk => async (dispatch, getState) => {
    const currentState = getState().listingCreation;
    const now = Date.now();
    const lastUpdate = currentState.scanProgress?.lastUpdate || 0;
    const isStalled = currentState.isScanning && now - lastUpdate > 30000;
    if (currentState.isScanning && !isStalled) return;
    dispatch(set_scanning(true));
    dispatch(
      set_scan_progress({
        current: 0,
        total: 100,
        message: "Initializing...",
        lastUpdate: Date.now(),
      } as any),
    );
    try {
      let { inventory, photos, listingCreation } = getState();
      const tokenData = getStoredToken();
      const localJanCodeToPhotos = { ...(photos.janCodeToPhotos || {}) };
      if (tokenData) {
        dispatch(set_drive_connection_status("connected"));
        const accessToken = tokenData.access_token;
        const apiKey = import.meta.env.VITE_GOOGLE_API_KEY;
        const candidates = Object.entries(localJanCodeToPhotos).filter(
          (entry): entry is [string, any[]] => {
            const [key, images] = entry as [string, any[]];
            if (key.includes(":") || images.length <= 2) return false;
            return Object.values(inventory.idToItem).some(
              (item: any) =>
                item.janCode === key && !item.handle && item.qty > 0,
            );
          },
        );
        if (candidates.length > 0) {
          let processedCount = 0;
          const totalCandidates = candidates.length;
          for (const [janCode, groupImages] of candidates) {
            processedCount++;
            dispatch(
              set_scan_progress({
                current: processedCount,
                total: totalCandidates,
                message: `Analyzing variants for ${janCode}...`,
                janCode,
              }),
            );
            try {
              const imagesToScan = (groupImages as any[]).slice(0, 12);
              const imagePromises = imagesToScan.map((img: any) =>
                fetchImage(img.baseUrl || img.productUrl, accessToken),
              );
              const imagesData = await Promise.all(imagePromises);
              const prompt = listingCreation.globalVariantPrompt;
              const variants = await detectVariants(
                imagesData,
                accessToken,
                apiKey,
                prompt,
              );
              if (variants.length > 1) {
                for (const v of variants) {
                  const safeName = (v.name || "Variant").trim();
                  const newJan = `${janCode}:${safeName}`;
                  if (!localJanCodeToPhotos[newJan])
                    localJanCodeToPhotos[newJan] = [];
                  for (const idx of v.indices) {
                    if (idx < imagesToScan.length) {
                      const img = imagesToScan[idx];
                      localJanCodeToPhotos[newJan].push(img);
                      dispatch(
                        categorize_photo({ janCode: newJan, photo: img }),
                      );
                      dispatch(
                        uncategorize_photo({
                          janCode: janCode,
                          photoId: img.id,
                        }),
                      );
                    }
                  }
                }
                delete localJanCodeToPhotos[janCode];
              }
            } catch (e) {
              console.error(
                `[Generate] Failed variant analysis for ${janCode}`,
                e,
              );
            }
          }
        }
      } else {
        dispatch(set_drive_connection_status("disconnected"));
      }
      const organizedJans = Object.keys(localJanCodeToPhotos);
      const baseJanMap: Record<
        string,
        { key: string; subtype: string | null }[]
      > = {};
      organizedJans.forEach((key) => {
        const [base, subtype] = key.includes(":")
          ? key.split(":")
          : [key, null];
        if (!baseJanMap[base]) baseJanMap[base] = [];
        baseJanMap[base].push({ key, subtype });
      });
      const candidateBaseJans = Object.entries(baseJanMap).filter(
        ([baseJan]) => {
          if (listingCreation.proposals[baseJan]) return false;
          return Object.values(inventory.idToItem).some(
            (item: any) =>
              item.janCode === baseJan && !item.handle && item.qty > 0,
          );
        },
      );
      const totalBaseJans = candidateBaseJans.length;
      let processedBase = 0;
      const candidates: CleanListingProposal[] = [];
      for (const [baseJan, photoGroups] of candidateBaseJans) {
        processedBase++;
        dispatch(
          set_scan_progress({
            current: processedBase,
            total: totalBaseJans,
            message: `Generating proposal for ${baseJan}...`,
            janCode: baseJan,
          }),
        );
        const inventoryItems: { id: string; item: Item }[] = [];
        for (const [id, val] of Object.entries(inventory.idToItem)) {
          const item = val as Item;
          if (item.janCode === baseJan && !item.handle && item.qty > 0)
            inventoryItems.push({ id, item });
        }
        if (inventoryItems.length > 0) {
          const firstItem = inventoryItems[0].item;
          let title = `[DRAFT] ${firstItem.description || "New Product"}`;
          let bodyHtml = "<p><i>Generating description...</i></p>";
          try {
            const tokenData = getStoredToken();
            const accessToken = tokenData?.access_token || "";
            const allImages = photoGroups.flatMap(
              (pg) => localJanCodeToPhotos[pg.key] || [],
            );
            const imagesToUse = allImages.slice(0, 6);
            if (imagesToUse.length > 0) {
              const imagePromises = imagesToUse.map((img: any) =>
                fetchImage(img.baseUrl || img.productUrl, accessToken),
              );
              const imagesData = await Promise.all(imagePromises);
              const descPrompt =
                getState().listingCreation.globalDescriptionPrompt ||
                "Write a playful product description for this product, formatted with HTML tags. Return ONLY the HTML.";
              const genDesc = await imagePrompt(
                descPrompt,
                imagesData,
                accessToken,
              );
              if (genDesc) {
                bodyHtml = genDesc
                  .replace(/```html/g, "")
                  .replace(/```/g, "")
                  .trim();
                if (bodyHtml.indexOf("<") > -1)
                  bodyHtml = bodyHtml.substring(bodyHtml.indexOf("<"));
              }
              const titlePrompt = `Generate a concise, catchy product title for this product. Product Category: Stationery. Return ONLY the title text. No quotes.`;
              const genTitle = await imagePrompt(
                titlePrompt,
                imagesData,
                accessToken,
              );
              if (genTitle) title = genTitle.trim().replace(/^"|"$/g, "");
            }
          } catch (e) {
            console.error(`[Generate] Failed generation for ${baseJan}`, e);
            bodyHtml = `<p>Failed to generate description. ${e}</p>`;
          }
          const variants: CleanListingVariant[] = [];
          const allPhotoGroupIds: string[] = [];
          photoGroups.sort((a, b) =>
            (a.subtype || "").localeCompare(b.subtype || ""),
          );
          photoGroups.forEach((pg) => {
            allPhotoGroupIds.push(pg.key);
            const optionValue = pg.subtype || firstItem.subtype || "Default";
            const groupImages = localJanCodeToPhotos[pg.key] || [];
            let selectedImage: string | undefined = undefined;
            if (groupImages.length > 1)
              selectedImage =
                groupImages[1].baseUrl || groupImages[1].productUrl;
            else if (groupImages.length === 1)
              selectedImage =
                groupImages[0].baseUrl || groupImages[0].productUrl;
            variants.push({
              id: `${baseJan}:${optionValue}:${crypto.randomUUID().slice(0, 8)}`,
              option1Value: optionValue,
              photoGroupKey: pg.key,
              image: selectedImage,
            });
          });
          candidates.push({
            janCode: baseJan,
            photoGroupIds: allPhotoGroupIds,
            title,
            bodyHtml,
            productCategory: "Stationery",
            vendor: "SPNSS Ltd.",
            tags: [],
            option1Name: "Subtype",
            variants: variants as any,
            status: "draft",
            listingOnlyImages: [],
          });
        }
        if (candidates.length >= 1000) break;
      }
      if (candidates.length > 0) dispatch(add_proposals(candidates));
    } catch (e) {
      console.error("Generate proposals failed", e);
    } finally {
      dispatch(set_scanning(false));
    }
  };
