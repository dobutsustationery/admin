import { createSlice, type PayloadAction, type ThunkAction } from "@reduxjs/toolkit";
import type { AnyAction } from "redux"; 
import type { GlobalState } from "./store";
import { update_field, type Item } from "./inventory";
import { imagePrompt, fetchImage } from "./gemini-client";
import { getStoredToken } from "./google-drive";
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
      },
      remove_listing_only_image: (state, action: PayloadAction<{ janCode: string, imageId: string }>) => {
          const { janCode, imageId } = action.payload;
          const proposal = state.proposals[janCode];
          if (!proposal?.listingOnlyImages) return;
          proposal.listingOnlyImages = proposal.listingOnlyImages.filter(img => img.id !== imageId);
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
      
      // UI
      next_step: (state) => {
          state.currentStepIndex++;
      },
      complete_batch: (state) => {
          state.activeBatchJans = [];
          state.currentStepIndex = 0;
          state.activeBatchId = undefined;
          state.activeBatchCreatedAt = undefined;
          // Optionally archive proposals here
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
    approve_proposal,
    next_step,
    complete_batch,
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
    const organizedJans = Object.keys(photos.janCodeToPhotos || {});
    
    for (const janCode of organizedJans) {
        // Find matching inventory items
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
                 photoGroupIds: [janCode], 
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
                 status: 'draft',
                 listingOnlyImages: [],
                 // Inherit globals by default (undefined)
             });
        }
        // Limit
        if (candidates.length >= 10) break;
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

         // A. Update Inventory Items (Price + Handle)
         proposal.inventoryItemIds.forEach((id: string) => {
             // Commit Price if set
             if (proposal.price !== undefined) {
                 dispatch(update_field({ id, field: 'price', from: 0, to: proposal.price! }));
             }
             // Commit Handle (Crucial for merging)
             dispatch(update_field({ id, field: 'handle', from: "", to: finalHandle }));
         });

         // B. Create/Update Listing
         // Identify images from Photo State (In-Memory)
         const janToPhotos = state.photos.janCodeToPhotos || {};
         // @ts-ignore
         const driveFiles = janToPhotos[janCode] || [];
         
         // @ts-ignore
        const listingImages = driveFiles.map((f: any, i: number) => ({
             url: f.url, // Ensure this is a usable URL (SecureImage handles it) // @ts-ignore
             id: f.id || `img-${i}`,
             altText: f.name,
             position: i + 1
         }));
         
         const listingOnly = proposal.listingOnlyImages || [];
         const mergedImages = [...listingImages, ...listingOnly].map((img, i) => ({
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
            const combinedImages = [...(existingListing.images || []), ...mergedImages];
             // Re-index positions
             combinedImages.forEach((img, i) => img.position = i + 1);
             
             dispatch(create_listing({ listing: { ...existingListing, ...listing, images: combinedImages } }));
         } else {
             dispatch(create_listing({ listing }));
         }

         // Remove all proposals sharing this handle to avoid stale drafts
         const allProposals = getState().listingCreation.proposals;
         const matchingJans = Object.values(allProposals)
             .filter(p => {
                 const h = p.handle || generateHandle(p.title, p.janCode);
                 return h === finalHandle;
             })
             .map(p => p.janCode);
         matchingJans.forEach(jan => dispatch(remove_proposal({ janCode: jan })));
    }

    // 3. Advance UI
    const updatedState = getState().listingCreation;
    const remaining = updatedState.activeBatchJans.length;
    if (remaining === 0) {
        dispatch(complete_batch());
        return;
    }

    let nextIndex = updatedState.currentStepIndex;
    if (nextIndex < 0) nextIndex = 0;
    if (nextIndex >= remaining) nextIndex = 0;
    dispatch(set_current_step(nextIndex));
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
    const driveGroup = janToPhotos[janCode] || [];
    
    if (driveGroup.length === 0) {
        alert("No photos found for this item to generate description from.");
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

        const imagesToUse = driveGroup.slice(0, 5);
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
    } finally {
        dispatch(update_proposal_field({ janCode, field: 'isGeneratingDescription', value: false }));
    }
};
