import { createSlice, type PayloadAction, type ThunkAction } from "@reduxjs/toolkit";
import type { AnyAction } from "redux"; 
import type { GlobalState } from "./store";
import { update_field, type Item } from "./inventory";
import { imagePrompt, fetchImage } from "./gemini-client";
import { getStoredToken } from "./google-photos";
import { create_listing, type Listing, type ListingImage } from "./listings-slice";

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

  status: 'draft' | 'approved' | 'skipped';
}

export interface ListingCreationState {
  proposals: Record<string, ListingProposal>;
  activeBatchJans: string[];
  originalBatchJans: string[]; // Source of truth for batch items
  currentStepIndex: number;
  driveConnectionStatus: 'unknown' | 'connected' | 'disconnected';
  activeBatchId?: string;
  activeBatchCreatedAt?: number;
  lastCompletedBatchId?: string; // For UI celebration triggers
  
  // Global Defaults (Persisted)
  globalTitlePrompt?: string;
  globalDescriptionPrompt?: string;
}


  const initialState: ListingCreationState = {
    proposals: {},
    activeBatchJans: [],
    originalBatchJans: [],
    currentStepIndex: 0,
    driveConnectionStatus: 'unknown',
    activeBatchId: undefined,
    activeBatchCreatedAt: undefined,
    globalTitlePrompt: "Generate a concise, catchy product title for this product. Return ONLY the title text. No quotes.",
    globalDescriptionPrompt: "Write a playful product description for this product, formatted with HTML tags. Return ONLY the HTML. Do not include markdown code blocks or conversational text."
  };
  
  // --- Slice ---
  
  const listingCreationSlice = createSlice({
    name: "listingCreation",
    initialState,
    reducers: {
      set_drive_connection_status: (state, action: PayloadAction<'unknown' | 'connected' | 'disconnected'>) => {
          state.driveConnectionStatus = action.payload;
      },
      set_global_prompts: (state, action: PayloadAction<{ titlePrompt?: string, descriptionPrompt?: string }>) => {
          if (action.payload.titlePrompt) state.globalTitlePrompt = action.payload.titlePrompt;
          if (action.payload.descriptionPrompt) state.globalDescriptionPrompt = action.payload.descriptionPrompt;
      },
      // Session / Batch
      add_proposals: (state, action: PayloadAction<ListingProposal[]>) => {
          action.payload.forEach(p => {
              state.proposals[p.janCode] = p;
          });
      },
      remove_proposal: (state, action: PayloadAction<{ janCode: string }>) => {
          const { janCode } = action.payload;
          delete state.proposals[janCode];
          state.activeBatchJans = state.activeBatchJans.filter(jan => jan !== janCode);
          state.originalBatchJans = state.originalBatchJans.filter(jan => jan !== janCode);
          if (state.currentStepIndex >= state.activeBatchJans.length) {
              state.currentStepIndex = Math.max(0, state.activeBatchJans.length - 1);
          }
      },
      start_batch: (state, action: PayloadAction<{ janCodes: string[]; batchId: string; createdAt?: number }>) => {
          state.activeBatchJans = action.payload.janCodes;
          state.originalBatchJans = action.payload.janCodes; // Set source
          state.currentStepIndex = -1; // -1 = Batch Overview / Bulk Edit
          state.activeBatchId = action.payload.batchId;
          state.activeBatchCreatedAt = action.payload.createdAt ?? Date.now();
          state.lastCompletedBatchId = undefined;
      },
      set_current_step: (state, action: PayloadAction<number>) => {
          state.currentStepIndex = action.payload;
      },
      recalculate_batch_navigation: (state) => {
          // Re-evaluate activeBatchJans to group by Handle.
          // We use originalBatchJans as the immutable source of truth to ensure we can Restore items
          // if they were previously merged (hidden) and then unmerged.
          
          const sourceJans = state.originalBatchJans && state.originalBatchJans.length > 0 
              ? state.originalBatchJans 
              : state.activeBatchJans; // Fallback for migration if state persisted without original

          const seenHandles = new Set<string>();
          const newBatchOrder: string[] = [];
          
          sourceJans.forEach(jan => {
              const p = state.proposals[jan];
              if (!p) return;
              
              // If handle is unset, fallback to JAN (unique)
              const key = p.handle || p.janCode;
              
              if (!seenHandles.has(key)) {
                  seenHandles.add(key);
                  newBatchOrder.push(jan);
              }
          });
          
          state.activeBatchJans = newBatchOrder;
      },
      
      // Editing
      update_proposal_field: (state, action: PayloadAction<{ janCode: string, field: keyof ListingProposal, value: any }>) => {
          const { janCode, field, value } = action.payload;
          if (state.proposals[janCode]) {
              // @ts-ignore - dynamic field access
              state.proposals[janCode][field] = value;
          }
      },
      add_listing_only_image: (state, action: PayloadAction<{ janCode: string, image: ListingImage }>) => {
          const { janCode, image } = action.payload;
          const proposal = state.proposals[janCode];
          if (!proposal) return;
          if (!proposal.listingOnlyImages) proposal.listingOnlyImages = [];
          proposal.listingOnlyImages.push(image);
          if (proposal.listingImageOrder && proposal.listingImageOrder.length > 0) {
              proposal.listingImageOrder.push(image.id);
          }
      },
      remove_listing_only_image: (state, action: PayloadAction<{ janCode: string, imageId: string }>) => {
          const { janCode, imageId } = action.payload;
          const proposal = state.proposals[janCode];
          if (!proposal?.listingOnlyImages) return;
          proposal.listingOnlyImages = proposal.listingOnlyImages.filter(img => img.id !== imageId);
          if (proposal.listingImageOrder) {
              proposal.listingImageOrder = proposal.listingImageOrder.filter(id => id !== imageId);
          }
      },
      set_variant_option_name: (state, action: PayloadAction<{ janCode: string, name: string }>) => {
           const { janCode, name } = action.payload;
           if (state.proposals[janCode]) {
               state.proposals[janCode].option1Name = name;
           }
      },
      update_variant_value: (state, action: PayloadAction<{ janCode: string, variantId: string, value: string }>) => {
           const { janCode, variantId, value } = action.payload;
           const proposal = state.proposals[janCode];
           if (proposal) {
               const variant = proposal.variants.find(v => v.itemId === variantId);
               if (variant) {
                   variant.option1Value = value;
               }
           }
      },
      split_variant: (state, action: PayloadAction<{ janCode: string, variantId: string, newHandle: string }>) => {
           const { janCode, variantId, newHandle } = action.payload;
           const source = state.proposals[janCode];
           if (!source) return;
           
           // If it's the only variant, just update the handle (standard update)
           if (source.variants.length <= 1) {
               source.handle = newHandle;
               return;
           }

           const variantIndex = source.variants.findIndex(v => v.itemId === variantId);
           if (variantIndex === -1) return;
           
           const variant = source.variants[variantIndex];
           
           const newProposalId = variantId; 
           
           const newProposal: ListingProposal = {
               ...source,
               // We preserve the source JAN semantics for photo lookup
               janCode: source.janCode, 
               handle: newHandle,
               inventoryItemIds: [variantId], 
               photoGroupIds: [...source.photoGroupIds], 
               variants: [variant],
               listingOnlyImages: [],
               listingImageOrder: [],
           };
           
           source.variants.splice(variantIndex, 1);
           source.inventoryItemIds = source.inventoryItemIds.filter(id => id !== variantId);
           
           // Key must be unique, so we use variantId. janCode property handles the logic.
           state.proposals[newProposalId] = newProposal;
           state.activeBatchJans.push(newProposalId);
           state.originalBatchJans.push(newProposalId);
      },
      move_variant: (state, action: PayloadAction<{ sourceJan: string, targetJan: string, variantId: string }>) => {
           const { sourceJan, targetJan, variantId } = action.payload;
           const source = state.proposals[sourceJan];
           const target = state.proposals[targetJan];
           if (!source || !target || sourceJan === targetJan) return;

           const variantIndex = source.variants.findIndex(v => v.itemId === variantId);
           if (variantIndex === -1) return;
           const variant = source.variants[variantIndex];

           // Move Variant
           target.variants.push(variant);
           target.inventoryItemIds.push(variantId);
           
           // Cleanup Source
           source.variants.splice(variantIndex, 1);
           source.inventoryItemIds = source.inventoryItemIds.filter(id => id !== variantId);
           
           if (source.variants.length === 0) {
               delete state.proposals[sourceJan];
               state.activeBatchJans = state.activeBatchJans.filter(j => j !== sourceJan);
               state.originalBatchJans = state.originalBatchJans.filter(j => j !== sourceJan);
           }
      },
      merge_proposal: (state, action: PayloadAction<{ sourceJan: string, targetJan: string }>) => {
          const { sourceJan, targetJan } = action.payload;
          const source = state.proposals[sourceJan];
          const target = state.proposals[targetJan];
          
          if (!source || !target || sourceJan === targetJan) return;
          
          // Merge Arrays
          target.inventoryItemIds = [...new Set([...target.inventoryItemIds, ...source.inventoryItemIds])];
          target.photoGroupIds = [...new Set([...target.photoGroupIds, ...source.photoGroupIds])];
          target.variants = [...target.variants, ...source.variants]; // Keep duplicates? Should be unique items.
          
          if (source.listingOnlyImages) {
              target.listingOnlyImages = [...(target.listingOnlyImages || []), ...source.listingOnlyImages];
          }
          if (source.listingImageOrder) {
               target.listingImageOrder = [...(target.listingImageOrder || []), ...source.listingImageOrder];
          }
          
          // Cleanup Source
          delete state.proposals[sourceJan];
          state.activeBatchJans = state.activeBatchJans.filter(j => j !== sourceJan);
          state.originalBatchJans = state.originalBatchJans.filter(j => j !== sourceJan);
          state.originalBatchJans = state.originalBatchJans.filter(j => j !== sourceJan);
      },
      import_existing_variants: (state, action: PayloadAction<{ janCode: string, handle: string }>) => {
           // Represents the user intent to import existing variants for this handle.
           // The logic to find and add the items is handled by the root reducer / middleware.
      },
      add_variants_internal: (state, action: PayloadAction<{ janCode: string, items: { id: string, item: Item }[] }>) => {
           const { janCode, items } = action.payload;
           const proposal = state.proposals[janCode];
           if (!proposal) return;
           
           // Add them to proposal
           items.forEach(({ id, item }) => {
               if (!proposal.inventoryItemIds.includes(id)) {
                   proposal.inventoryItemIds.push(id);
                   proposal.variants.push({
                        itemId: id,
                        option1Value: item.subtype || "Default"
                   });
               }
           });
      },
      
      // Review
      approve_proposal: (state, action: PayloadAction<{ janCode: string }>) => {
          const { janCode } = action.payload;
          if (state.proposals[janCode]) {
              state.proposals[janCode].status = 'approved';
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
      clear_celebration: (state) => {
          state.lastCompletedBatchId = undefined;
      }
    },
  });

export const { 
    set_drive_connection_status,
    set_global_prompts,
    add_proposals, 
    remove_proposal,
    start_batch, 
    update_proposal_field, 
    add_listing_only_image,
    remove_listing_only_image,
    set_variant_option_name,
    update_variant_value,
    split_variant,
    move_variant,
    merge_proposal,
    import_existing_variants,
    add_variants_internal,
    approve_proposal,
    next_step,
    complete_batch,
    clear_celebration,
    set_current_step,
    recalculate_batch_navigation
} = listingCreationSlice.actions;

export default listingCreationSlice.reducer;

// --- Thunks ---

export const generate_proposals = (): AppThunk => async (dispatch, getState) => {
    const { inventory, photos, listingCreation } = getState(); // Access listingCreation for globals
    
    // 1. Get Access Token (Still needed for image fetching/Descriptions later, but not for discovery here)
    const tokenData = getStoredToken();
    if (tokenData) {
         dispatch(set_drive_connection_status('connected'));
    } else {
         dispatch(set_drive_connection_status('disconnected'));
         // We can still generate proposals if we have the mapping in memory!
         // But we might want to warn the user that images won't load.
    }

    // 2. Use In-Memory Mapping (Single Source of Truth)
    const candidates: ListingProposal[] = [];
    
    // Iterate over JANs that have photos assigned
    // These keys might be "454..." (Base) or "454...:Blue" (Split/Subtype)
    const organizedJans = Object.keys(photos.janCodeToPhotos || {});
    
    for (const photoKey of organizedJans) {
        // Parse Base JAN and Subtype
        const [baseJan, subtype] = photoKey.includes(':') ? photoKey.split(':') : [photoKey, null];

        // Find matching inventory items using Base JAN
        const inventoryItems: { id: string, item: Item }[] = [];
        
        for (const [id, val] of Object.entries(inventory.idToItem)) {
            const item = val as Item;
            if (item.janCode === baseJan && !item.handle) {
                inventoryItems.push({ id, item });
            }
        }
            
        if (inventoryItems.length > 0) {
             const firstItem = inventoryItems[0].item;
             const inventoryIds = inventoryItems.map(x => x.id);
             
             // Determine Title & Option
             let title = `[DRAFT] ${firstItem.description || 'New Product'}`;
             let optionValue = firstItem.subtype || "Default";
             
             if (subtype) {
                 title += ` (${subtype})`;
                 optionValue = subtype;
             }

             // Create Proposal using the Photo Key as the proposal's unique janCode
             candidates.push({
                 janCode: photoKey, // Unique key (e.g. JAN:Blue)
                 inventoryItemIds: inventoryIds,
                 photoGroupIds: [photoKey], // Link to specific photo group
                 title: title,
                 bodyHtml: "<p>Generated description from AI...</p>",
                 productCategory: "Stationery",
                 vendor: "Dobutsu",
                 tags: ["New Arrival"],
                 option1Name: "Color",
                 variants: inventoryItems.map(x => ({ 
                     itemId: x.id, 
                     option1Value: optionValue // Use detected subtype
                 })),
                 status: 'draft',
                 listingOnlyImages: [],
                 // Inherit globals by default (undefined)
             });
        }
        // Limit
        if (candidates.length >= 1000) break;
    }
    
    // Dispatch
    if (candidates.length > 0) {
        dispatch(add_proposals(candidates));
    } else {
        console.log("No candidates found. Ensure photos are organized in the Photos tab and Inventory items exist.");
    }
};

import { generateHandle } from "./handle-utils";

export const approve_proposal_thunk = (janCode: string): AppThunk => (dispatch, getState) => {
    // 1. Mark as Approved
    dispatch(approve_proposal({ janCode }));
    
    // 2. Commit Pending Updates (Price & Handle) & Create Listing
    const state = getState();
    const proposal = state.listingCreation.proposals[janCode];
    
    if (proposal) {
         // Determine Handle
         const finalHandle = proposal.handle || generateHandle(proposal.title, proposal.janCode);

         // A. Update Inventory Items (Price + Handle + Subtype)
         proposal.inventoryItemIds.forEach((id: string) => {
             // Commit Price if set
             if (proposal.price !== undefined) {
                 dispatch(update_field({ id, field: 'price', from: 0, to: proposal.price! }));
             }
             // Commit Handle (Crucial for merging)
             dispatch(update_field({ id, field: 'handle', from: "", to: finalHandle }));
         });
         
         // Commit Subtypes (from variants)
         proposal.variants.forEach((v: ListingVariant) => {
             console.log("APPROVE DEBUG: variant", v.itemId, v.option1Value);
             if (v.option1Value) {
                 dispatch(update_field({ id: v.itemId, field: 'subtype', from: "", to: v.option1Value }));
             }
         });

         // B. Create/Update Listing
         
         // Identify all proposals sharing this handle to aggregate photos
         const allProposals = state.listingCreation.proposals;
         const mergedJans = (Object.values(allProposals) as ListingProposal[])
             .filter((p) => {
                 const h = p.handle || generateHandle(p.title, p.janCode);
                 return h === finalHandle;
             })
             .map((p) => p.janCode);

         // Identify images from Photo State (In-Memory) for ALL merged JANs
         const janToPhotos = state.photos.janCodeToPhotos || {};
         // @ts-ignore
         const driveFiles = mergedJans.flatMap(jan => janToPhotos[jan] || []);
         
         // @ts-ignore
        const listingImages = driveFiles.map((f: any, i: number) => ({
             url: f.baseUrl || f.productUrl || f.url, // Fix: Use baseUrl (Photos) or fallback
             id: f.id || `img-${i}`,
             altText: f.filename || f.name, // Fix: Photos uses filename
             position: i + 1
         }));
         
         // Aggregate listing-only images from all merged proposals too?
         // Yes, otherwise we lose edits from siblings.
         const listingOnly = mergedJans.flatMap(jan => allProposals[jan]?.listingOnlyImages || []);
         
         let mergedImages = [...listingImages, ...listingOnly];
         const order = proposal.listingImageOrder || [];
         if (order.length > 0) {
             const byId = new Map(mergedImages.map(img => [img.id, img]));
             const ordered: any[] = [];
             order.forEach((id: string) => {
                 const match = byId.get(id);
                 if (match) {
                     ordered.push(match);
                     byId.delete(id);
                 }
             });
             mergedImages = [...ordered, ...Array.from(byId.values())];
         }
         mergedImages = mergedImages.map((img, i) => ({
             ...img,
             position: i + 1
         }));

         const listing: Listing = {
             handle: finalHandle,
             title: proposal.title,
             bodyHtml: proposal.bodyHtml,
             productCategory: proposal.productCategory,
             vendor: proposal.vendor,
             tags: proposal.tags,
             option1Name: proposal.option1Name,
            images: mergedImages,
             // Required fields
             productType: "", 
             status: 'active',
             lastUpdated: Date.now()
         };

         // Dispatch Create (Store middleware handles persistence if configured, or we rely on sync)
         // Note: If listing exists, create_listing might overwrite. 
         // For merging: We generally want to PRESERVE existing images if we are merging into an existing listing?
         // But here we are "Creating" a batch.
         // If A and B share handle X.
         // 1. Approve A. Creates Listing X with Images A.
         // 2. Approve B. Creates Listing X with Images B? -> Overwrite?
         // Improvement: Check if listing exists.
         const existingListing = state.listings.handleToListing[finalHandle];
         if (existingListing) {
             // Merge Images
             // Use map to deep clone (shallow ref is frozen) and re-index
             const combinedImages = [...(existingListing.images || []), ...mergedImages]
                .map((img, i) => ({ ...img, position: i + 1 }));
             
             dispatch(create_listing({ listing: { ...existingListing, ...listing, images: combinedImages } }));
         } else {
             dispatch(create_listing({ listing }));
         }

         // Remove all proposals sharing this handle to avoid stale drafts
         const removedJans = mergedJans; // Reuse calculation
         removedJans.forEach(jan => dispatch(remove_proposal({ janCode: jan })));

         // 3. Advance UI
         const currentActive = getState().listingCreation.activeBatchJans;
         const remainingCount = currentActive.filter((j: string) => !removedJans.includes(j)).length;
         
         if (remainingCount === 0) {
             dispatch(complete_batch());
             return;
         }
         
         let nextIndex = getState().listingCreation.currentStepIndex;
         if (nextIndex < 0) nextIndex = 0;
         if (nextIndex >= remainingCount) nextIndex = 0;
         dispatch(set_current_step(nextIndex));
    }
};

export const generate_descriptions_for_batch = (janCodes: string[]): AppThunk => async (dispatch, getState) => {
    const state = getState();
    // Use In-Memory Photos for generation
    const janToPhotos = state.photos?.janCodeToPhotos || {};
    
    let accessToken = "";
    try {
        const tokenData = getStoredToken();
        if (tokenData) {
            accessToken = tokenData.access_token;
        }
    } catch (e) {
        console.error("Error reading access token", e);
    }

    if (!accessToken) {
        console.warn("No Google Drive access token found. Attempting unauthenticated image fetch (requires public URLs).");
    }

    for (const janCode of janCodes) {
        const proposal = state.listingCreation.proposals[janCode];
        if (!proposal) continue;

        // Skip if we already have a real description
        if (proposal.bodyHtml && !proposal.bodyHtml.includes("Generated description from AI") && proposal.bodyHtml.length > 50) {
            continue;
        }

        const driveGroup = janToPhotos[janCode] || [];
        if (driveGroup.length === 0) continue;

        try {
            // Notify UI
            dispatch(update_proposal_field({ janCode, field: 'isGeneratingDescription', value: true }));
            dispatch(update_proposal_field({ 
                janCode, 
                field: 'bodyHtml', 
                value: "<p><i>Generating description with AI...</i></p>" 
            }));

            // Take top 5 images
            const imagesToUse = driveGroup.slice(0, 5);
            
            // Fetch images via API URL (best) or fallback
            // fetchImage supports Drive URLs if token is present.
            const imagePromises = imagesToUse.map((f: any) => {
                // MediaItem from photos-slice uses baseUrl. DriveFile uses apiUrl/thumbnailLink.
                // We prioritize baseUrl as per MediaItem interface.
                const url = f.baseUrl || f.productUrl || f.apiUrl || f.thumbnailLink;
                // Ensure we have a valid string. If no direct link, construct API link?
                // google-drive.ts list function asks for these fields.
                return fetchImage(url, accessToken); 
            });
            
            const imagesData = await Promise.all(imagePromises);

            // Generate
            const defaultPrompt = state.listingCreation.globalDescriptionPrompt || "Write a playful product description for this product, formatted with HTML tags. Return ONLY the HTML. Do not include markdown code blocks or conversational text.";
            const prompt = proposal.descriptionPrompt || defaultPrompt;
            
            let description = await imagePrompt(prompt, imagesData, accessToken);

            if (description) {
                 // Clean up
                 description = description.replace(/```html/g, "").replace(/```/g, "");
                 const htmlStart = description.indexOf("<");
                 if (htmlStart > -1) description = description.substring(htmlStart);
                 description = description.trim();

                 dispatch(update_proposal_field({ 
                     janCode, 
                     field: 'bodyHtml', 
                     value: description 
                 }));
            }

        } catch (e: any) {
            console.error(`Failed to generate description for ${janCode}`, e);
             dispatch(update_proposal_field({ 
                     janCode, 
                     field: 'bodyHtml', 
                     value: `<p>Failed to generate AI description. Error: ${e.message}</p>` 
                 }));
        } finally {
            dispatch(update_proposal_field({ janCode, field: 'isGeneratingDescription', value: false }));
        }
    }
};

export const regenerate_title = (janCode: string, customPrompt?: string): AppThunk => async (dispatch, getState) => {
    const state = getState();
    const proposal = state.listingCreation.proposals[janCode];
    if (!proposal) return;

    // Persist prompt if provided (Both Local and Global)
    if (customPrompt) {
        dispatch(update_proposal_field({ janCode, field: 'titlePrompt', value: customPrompt }));
        dispatch(set_global_prompts({ titlePrompt: customPrompt }));
    }

    dispatch(update_proposal_field({ janCode, field: 'isGeneratingTitle', value: true }));

    try {
        const defaultPrompt = state.listingCreation.globalTitlePrompt || `Generate a concise, catchy product title for this product. 
        Current Title: ${proposal.title}
        Vendor: ${proposal.vendor}
        Product Category: ${proposal.productCategory}
        Return ONLY the title text. No quotes.`;
        
        dispatch(update_proposal_field({ janCode, field: 'isGeneratingTitle', value: true }));
        dispatch(update_proposal_field({ janCode, field: 'title', value: "Regenerating..." })); // Visual Feedback

        const prompt = customPrompt || proposal.titlePrompt || defaultPrompt;
        
        const janToPhotos = state.photos?.janCodeToPhotos || {};
        const driveGroup = janToPhotos[janCode] || [];
        const token = getStoredToken();
        const accessToken = token?.access_token || "";

        let description = "";
        
        if (driveGroup.length > 0) {
             const imagesToUse = driveGroup.slice(0, 3);
             const imagePromises = imagesToUse.map((f: any) => {
                const url = f.baseUrl || f.productUrl || f.apiUrl || f.thumbnailLink;
                return fetchImage(url, accessToken); 
            });
            const imagesData = await Promise.all(imagePromises);
            description = await imagePrompt(prompt, imagesData, accessToken, undefined) || "";
        } else {
            description = await imagePrompt(prompt, [], accessToken, undefined) || "";
        }

        if (description) {
            dispatch(update_proposal_field({ 
                janCode, 
                field: 'title', 
                value: description.trim().replace(/^"|"$/g, '') 
            }));
        }
    } catch (e: any) {
        console.error("Title generation failed", e);
        alert(`Failed to regenerate title: ${e.message}`);
    } finally {
        dispatch(update_proposal_field({ janCode, field: 'isGeneratingTitle', value: false }));
    }
};

export const regenerate_description = (janCode: string, customPrompt?: string): AppThunk => async (dispatch, getState) => {
    const state = getState();
    const proposal = state.listingCreation.proposals[janCode];
    if (!proposal) return;

    // Persist prompt if provided (Global Only)
    if (customPrompt) {
        dispatch(set_global_prompts({ descriptionPrompt: customPrompt }));
    }

    const janToPhotos = state.photos?.janCodeToPhotos || {};
    let allPhotos: any[] = [];
    
    // Collect photos from all variants (including the primary JAN)
    // The proposal itself has 'janCode', which corresponds to one variant/group usually.
    // And 'variants' list contains ALL variants (including primary usually, or we ensure it).
    
    // Iterate variants to find their JANs
    proposal.variants.forEach((v: ListingVariant) => {
        const item = state.inventory.idToItem[v.itemId];
        if (item && item.janCode) {
            const photos = janToPhotos[item.janCode] || [];
            allPhotos = [...allPhotos, ...photos];
        }
    });
    
    // Fallback: Check the proposal's own janCode just in case
    if (allPhotos.length === 0) {
        const photos = janToPhotos[proposal.janCode] || [];
        allPhotos = [...allPhotos, ...photos];
    }

    // Deduplicate photos by ID or URL
    const seenUrls = new Set();
    allPhotos = allPhotos.filter(p => {
        const url = p.baseUrl || p.thumbnailLink || p.productUrl;
        if (seenUrls.has(url)) return false;
        seenUrls.add(url);
        return true;
    });

    if (allPhotos.length === 0) {
        alert("No photos found for these items to generate description from.");
        return;
    }

    dispatch(update_proposal_field({ janCode, field: 'isGeneratingDescription', value: true }));
    dispatch(update_proposal_field({ 
        janCode, 
        field: 'bodyHtml', 
        value: "<p><i>Regenerating description...</i></p>" 
    }));

    try {
        const token = getStoredToken();
        const accessToken = token?.access_token || "";

        const imagesToUse = allPhotos.slice(0, 5);
        const imagePromises = imagesToUse.map((f: any) => {
            const url = f.baseUrl || f.productUrl || f.apiUrl || f.thumbnailLink;
            return fetchImage(url, accessToken); 
        });
        
        const imagesData = await Promise.all(imagePromises);
        
        const defaultPrompt = state.listingCreation.globalDescriptionPrompt || "Write a playful product description for this product, formatted with HTML tags. Return ONLY the HTML. Do not include markdown code blocks or conversational text.";
        const prompt = customPrompt || defaultPrompt;
        
        let description = await imagePrompt(prompt, imagesData, accessToken, undefined);

        if (description) {
             description = description.replace(/```html/g, "").replace(/```/g, "");
             const htmlStart = description.indexOf("<");
             if (htmlStart > -1) description = description.substring(htmlStart);
             description = description.trim();

             dispatch(update_proposal_field({ 
                 janCode, 
                 field: 'bodyHtml', 
                 value: description 
             }));
        }
    } catch (e: any) {
        console.error(`Failed to regenerate description for ${janCode}`, e);
         dispatch(update_proposal_field({ 
                 janCode, 
                 field: 'bodyHtml', 
                 value: `<p>Failed to generate description. Error: ${e.message}</p>` 
             }));
    }
};

export const set_proposal_handle_thunk = (janCode: string, variantId: string | undefined, newHandle: string): AppThunk => (dispatch, getState) => {
    const state = getState();
    const proposals = Object.values(state.listingCreation.proposals) as ListingProposal[];
    const sourceProposal = state.listingCreation.proposals[janCode];
    if (!sourceProposal) return;

    // 1. Check for Merge Target (Active Proposal)
    const targetGroup = proposals.filter((p: ListingProposal) => {
        if (p.janCode === janCode) return false;
        const h = p.handle || generateHandle(p.title || "", p.janCode);
        return h === newHandle;
    });

    if (targetGroup.length > 0) {
        // SCENARIO A: Target Exists (Draft Merge)
        const target = targetGroup[0] as ListingProposal;
        const isMultiVariant = sourceProposal.variants && sourceProposal.variants.length > 1;

        if (isMultiVariant && variantId) {
             // Move just this variant.
             dispatch(move_variant({ sourceJan: janCode, targetJan: target.janCode, variantId }));
        } else {
             // Merge entire proposal
             dispatch(merge_proposal({ sourceJan: janCode, targetJan: target.janCode }));
        }
    } else {
        // SCENARIO B: Check for Existing Listing (Store Persisted State)
        const existingListing = state.listings.handleToListing[newHandle];
        
        if (existingListing) {
            // Merge with Existing Listing
            // 1. Import Context (Title, Body, etc.) - Update Proposal to match existing "Truth"
            dispatch(update_proposal_field({ janCode, field: 'title', value: existingListing.title }));
            dispatch(update_proposal_field({ janCode, field: 'bodyHtml', value: existingListing.bodyHtml }));
            dispatch(update_proposal_field({ janCode, field: 'productCategory', value: existingListing.productCategory }));
            dispatch(update_proposal_field({ janCode, field: 'vendor', value: existingListing.vendor }));
            dispatch(update_proposal_field({ janCode, field: 'tags', value: existingListing.tags || [] }));
            dispatch(update_proposal_field({ janCode, field: 'option1Name', value: existingListing.option1Name || "Option" }));

            // 2. Set Handle (This links them)
            const isMultiVariant = sourceProposal.variants && sourceProposal.variants.length > 1;
             if (isMultiVariant && variantId) {
                 dispatch(split_variant({ janCode, variantId, newHandle }));
                 // Follow up synchronously
                 dispatch(set_proposal_handle_thunk(variantId, undefined, newHandle));
                 return; 
             } else {
                 dispatch(update_proposal_field({ janCode, field: 'handle', value: newHandle }));
             }

            // 3. Import Existing Variants
            // Dispatch the intent to import existing variants for this handle.
            // The root reducer will intercept this, look up the items in inventory, and apply them.
            dispatch(import_existing_variants({ janCode, handle: newHandle }));

        } else {
            // SCENARIO C: New Handle (Update or Split)
            const isMultiVariant = sourceProposal.variants && sourceProposal.variants.length > 1;

            if (isMultiVariant && variantId) {
                 dispatch(split_variant({ janCode, variantId, newHandle }));
            } else {
                 dispatch(update_proposal_field({ janCode, field: 'handle', value: newHandle }));
            }
        }
    }
};
