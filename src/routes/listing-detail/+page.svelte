<script lang="ts">
  import { page } from "$app/stores";
  import { onMount } from "svelte";
  import { addDoc, collection, serverTimestamp } from "firebase/firestore";
  import { store } from "$lib/store";
  import {
    update_listing,
    add_listing_image,
    remove_listing_image,
    type ListingImage,
  } from "$lib/listings-slice";
  import {
    approve_proposal_thunk,
    regenerate_title,
    regenerate_description,
    update_proposal_field,
    update_variant_qty,
    update_variant_value,
    update_variant_image,
    set_variant_photo_group,
    add_listing_only_image,
    remove_listing_only_image,
    exclude_proposal_photo,
    include_proposal_photo,
    set_current_step,
    remove_proposal,
    complete_batch,
    reorder_variants,
    add_variant_requested,
    remove_variant_requested,
  } from "$lib/listing-creation-slice";
  import { update_field, split_inventory_item } from "$lib/inventory";
  import { makeInventoryItemKey } from "$lib/sku";
  import { uncategorize_photo } from "$lib/photos-slice";
  import { goto } from "$app/navigation";
  import { broadcast } from "$lib/redux-firestore";
  import { firestore } from "$lib/firebase";
  import { user } from "$lib/user-store";
  import { generateHandle, generateSku } from "$lib/handle-utils";
  import {
    ensureFolderStructure,
    uploadImageToDrive,
    getStoredToken,
    initiateOAuthFlow,
    generateDerivationKey,
    calculateHash,
  } from "$lib/google-drive";
  import { reorderListingImages } from "$lib/listing-image-ordering";
  import { buildDraftListingImages } from "$lib/listing-image-logic";
  import { toGoogleDrivePublicImageUrl } from "$lib/drive-url";
  import ListingEditor from "$lib/components/ListingEditor.svelte";
  import ListingVariantModal from "$lib/components/ListingVariantModal.svelte";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import BodyHtmlModal from "$lib/components/BodyHtmlModal.svelte";
  import type { ShopifySyncRequestView } from "$lib/shopify-sync-model";
  import {
    SHOPIFY_SYNC_REQUEST_EVENT,
    SHOPIFY_REQUEST_COLLECTION,
  } from "$lib/sync-events";

  // --- State ---
  $: mode = $page.url.searchParams.get("mode");
  $: janCode =
    $page.url.searchParams.get("janCode") || $page.url.searchParams.get("jan");
  $: handle = $page.url.searchParams.get("handle");
  $: isLiveMode = mode === "live" || (!!handle && mode !== "create");
  $: proposal = janCode ? $store.listingCreation.proposals[janCode] : null;
  $: readOnly = !isLiveMode && proposal?.status === "approved";

  // Variant Modal State
  let showVariantModal = false;
  let variantModalMode: "add" | "split" | "remove" = "add";
  let variantModalJan = "";
  let variantModalSourceItem: any = null;
  let variantModalOtherVariants: any[] = [];

  // Batch Navigation State
  $: activeBatchJans = $store.listingCreation.activeBatchJans || [];
  $: currentIndex = activeBatchJans.indexOf(janCode || "");
  $: prevJan = currentIndex > 0 ? activeBatchJans[currentIndex - 1] : null;
  $: nextJan =
    currentIndex >= 0 && currentIndex < activeBatchJans.length - 1
      ? activeBatchJans[currentIndex + 1]
      : null;

  let searchTerm = "";
  let matchingHandles: string[] = [];
  let fileInput: HTMLInputElement;

  onMount(() => {
    // Safety: Force reset stuck AI flags on load to prevent deadlocks
    if (mode === "create" && janCode) {
      store.dispatch(
        update_proposal_field({
          janCode,
          field: "isGeneratingTitle",
          value: false,
        }),
      );
      store.dispatch(
        update_proposal_field({
          janCode,
          field: "isGeneratingDescription",
          value: false,
        }),
      );
    }
  });

  // Prompt Modal State
  let showPromptModal = false;
  let promptTarget: "title" | "description" | null = null;
  let customPrompt = "";
  let showBodyModal = false;
  let bodyModalValue = "";

  // Image Picker State (Listing Photos)
  let showImagePicker = false;
  let showAllPhotos = false;
  let imagePickerTargetJan: string | null = null;

  // AI Loading State
  let isGeneratingTitle = false;
  let isGeneratingDescription = false;
  let syncMessage = "";
  let syncMessageLevel: "info" | "success" | "error" = "info";
  let isQueueingSync = false;
  let trackedSyncRequestId: string | null = null;
  let syncDetailsHref = "/sync-status";
  let successMessageTimeout: ReturnType<typeof setTimeout> | null = null;
  let dismissedSuccessRequestId: string | null = null;
  let syncState: any = {};
  let latestSyncRequestIdForHandle: string | null = null;
  let activeSyncRequestId: string | null = null;
  let activeSyncRequest: ShopifySyncRequestView | null = null;
  let lastObservedHandle: string | null = null;

  // Polymorphic Data Load
  let listingData: {
    title: string;
    bodyHtml: string;
    productCategory?: string;
    option1Name?: string;
    titlePrompt?: string;
    descriptionPrompt?: string;
  } | null = null;

  let listingImages: ListingImage[] = [];
  let associatedItems: any[] = [];
  let siblingProposals: any[] = []; // Hoisted for shared updates

  // Image Upload State
  let uploadingImageId: string | null = null;
  let replacingImagePosition: number | null = null;
  let replacingSubtypeId: string | null = null;
  let targetProposalJan: string | null = null;

  $: {
    if (mode === "create" && janCode) {
      // --- Creation Mode ---
      const primaryProposal = $store.listingCreation.proposals[janCode];

      if (primaryProposal) {
        // 1. Identify Handle Group
        const primaryHandle =
          primaryProposal.handle ||
          generateHandle(primaryProposal.title, primaryProposal.janCode);

        // 2. Find all proposals in this group (Aggregation)
        siblingProposals = Object.values(
          $store.listingCreation.proposals,
        ).filter((p: any) => {
          // Only check active batch if filtered, or all drafts?
          // Ideally we check all "in batch". But proposals are global.
          // Let's just catch all with same handle.
          const h = p.handle || generateHandle(p.title, p.janCode);
          return h === primaryHandle;
        });

        listingData = {
          title: primaryProposal.title,
          bodyHtml: primaryProposal.bodyHtml,
          productCategory: primaryProposal.productCategory,
          option1Name: primaryProposal.option1Name,
          titlePrompt: primaryProposal.titlePrompt,
          descriptionPrompt: primaryProposal.descriptionPrompt,
        };

        isGeneratingTitle = !!primaryProposal.isGeneratingTitle;
        isGeneratingDescription = !!primaryProposal.isGeneratingDescription;

        associatedItems = [];
        const allPhotos: any[] = [];
        const seenPhotoIds = new Set<string>();

        // 3. Map Variants to Items & Photos
        // We now iterate VARIANTS to support splitting one item into multiple.
        const variants = primaryProposal.variants || [];
        variants.forEach((v: any) => {
          const item = $store.inventory.idToItem[v.itemId];
          if (item) {
            associatedItems.push({
              ...item,
              id: v.itemId, // Inventory ID (source)
              variantId: v.id, // Unique Instance ID
              price:
                primaryProposal.price !== undefined
                  ? primaryProposal.price
                  : item.price,
              subtype: v.option1Value || item.subtype,
              qty: item.qty, // Total source inventory quantity (for validation)
              allocatedQty: v.qty, // Variant-specific allocation
              photoGroupKey: v.photoGroupKey,
              variantImage: v.image,
            });
          }
        });

        // Photos: Aggregate from all variants' photo keys or proposal's photoGroupIds
        // If variants have photoGroupKey, prioritize those?
        // The review said: "UI does not honor photoGroupKey".
        // We need to load photos for ALL groups involved.

        const groupIds = new Set<string>(primaryProposal.photoGroupIds || []);
        variants.forEach((v: any) => {
          if (v.photoGroupKey) groupIds.add(v.photoGroupKey);
        });

        // Photos: Aggregate using Canonical Builder
        // Ensure Primary is first and unique
        const otherSiblings = siblingProposals.filter(
          (p: any) => p !== primaryProposal,
        );

        listingImages = buildDraftListingImages(
          [primaryProposal, ...otherSiblings],
          $store.photos,
          $store.inventory,
        );
      } else {
        listingData = null;
      }
    } else {
      // ... (Live mode remains same)
      const liveListing = handle
        ? $store.listings.handleToListing[handle]
        : null;
      if (liveListing) {
        listingData = liveListing;
        // In live mode, render listing images exactly as persisted.
        listingImages = liveListing.images || [];
        associatedItems = Object.entries($store.listings.idToHandle || {})
          .filter(([id, h]) => h === handle)
          .map(([id]) => {
            const item = $store.inventory.idToItem[id];
            return item ? { ...item, id } : null;
          })
          .filter((item): item is NonNullable<typeof item> => !!item)
          .sort((a, b) => {
            const posA = a.imagePosition !== undefined ? a.imagePosition : 9999;
            const posB = b.imagePosition !== undefined ? b.imagePosition : 9999;
            if (posA !== posB) return posA - posB;
            return (a.subtype || "").localeCompare(b.subtype || "");
          });

        console.log(
          "[ListingDetail] Live Mode Associated Items:",
          associatedItems,
        );
      } else {
        listingData = null;
      }
    }
  }

  function dispatchBroadcast(action: any) {
    if ($user && $user.uid) {
      broadcast(firestore, $user.uid, action);
    } else {
      console.warn("User not authenticated, falling back to local dispatch");
      store.dispatch(action);
    }
  }

  // Sync Step Index if in Batch
  let isExiting = false;
  $: if (
    !isExiting &&
    mode === "create" &&
    janCode &&
    activeBatchJans.length > 0
  ) {
    const idx = activeBatchJans.indexOf(janCode);
    const currentStepIndex = $store.listingCreation.currentStepIndex;
    if (idx !== -1 && idx !== currentStepIndex) {
      dispatchBroadcast(set_current_step(idx));
    }
  }

  // --- Actions ---

  // AI Prompt Logic
  function openPromptModal(target: "title" | "description") {
    promptTarget = target;

    // Load persisted prompt or default
    if (listingData) {
      const globalState = $store.listingCreation;
      if (target === "title") {
        customPrompt =
          globalState.globalTitlePrompt ||
          "Generate a concise, catchy product title. Return ONLY the title text.";
      } else {
        customPrompt =
          globalState.globalDescriptionPrompt ||
          "Write a playful product description in HTML.";
      }
    }
    showPromptModal = true;
  }

  function openBodyModal() {
    if (!listingData) return;
    bodyModalValue = listingData.bodyHtml || "";
    showBodyModal = true;
  }

  $: if (showBodyModal && listingData) {
    const next = listingData.bodyHtml || "";
    if (next !== bodyModalValue) {
      bodyModalValue = next;
    }
  }

  function handleBodyModalRegenerate() {
    if (mode === "create" && janCode) {
      regenerate_description(janCode)(
        dispatchBroadcast,
        store.getState,
        undefined,
      );
    }
  }

  function handleToolbarRegenerateDescription() {
    if (mode === "create" && janCode) {
      regenerate_description(janCode)(
        dispatchBroadcast,
        store.getState,
        undefined,
      );
    }
  }

  function saveBodyModal(e: CustomEvent<{ value: string }>) {
    if (!$user.uid) return;
    const value = e.detail.value;
    if (mode === "create" && janCode) {
      dispatchBroadcast(
        update_proposal_field({ janCode, field: "bodyHtml", value }),
      );
    } else if (handle) {
      broadcast(
        firestore,
        $user.uid,
        update_listing({ handle, changes: { bodyHtml: value } }),
      );
    }
    showBodyModal = false;
  }

  function cancelBodyModal() {
    showBodyModal = false;
  }

  function handleRunPrompt() {
    if (mode === "create" && janCode && promptTarget) {
      if (promptTarget === "title") {
        regenerate_title(janCode, customPrompt)(
          dispatchBroadcast,
          store.getState,
          undefined,
        );
      } else {
        regenerate_description(janCode, customPrompt)(
          dispatchBroadcast,
          store.getState,
          undefined,
        );
      }
    }
    showPromptModal = false;
  }

  function clearSuccessMessageTimer() {
    if (successMessageTimeout) {
      clearTimeout(successMessageTimeout);
      successMessageTimeout = null;
    }
  }

  function getLatestApiCall(request: ShopifySyncRequestView) {
    if (!request.apiCalls || request.apiCalls.length === 0) return null;
    return [...request.apiCalls].sort((a, b) => b.loggedAt - a.loggedAt)[0];
  }

  function buildSyncMessageFromRequest(
    request: ShopifySyncRequestView,
    syncHandle: string,
  ) {
    if (request.status === "queued") {
      return {
        level: "info" as const,
        text: `Sync requested for '${syncHandle}'. Waiting for processor claim...`,
      };
    }

    if (request.status === "processing") {
      const latestCall = getLatestApiCall(request);
      if (!latestCall) {
        return {
          level: "info" as const,
          text: `Sync in progress for '${syncHandle}'...`,
        };
      }

      if (latestCall.success) {
        return {
          level: "info" as const,
          text: `Sync in progress: ${latestCall.requestType} completed.`,
        };
      }

      const apiError = latestCall?.response?.error
        ? ` (${String(latestCall.response.error)})`
        : "";
      return {
        level: "info" as const,
        text: `Sync in progress: ${latestCall.requestType} failed${apiError}. Awaiting final status...`,
      };
    }

    if (request.status === "success") {
      return {
        level: "success" as const,
        text: `Sync completed successfully for '${syncHandle}'.`,
      };
    }

    const finalError =
      typeof request.result?.error === "string" ? request.result.error : "";
    return {
      level: "error" as const,
      text: finalError
        ? `Sync failed for '${syncHandle}': ${finalError}`
        : `Sync failed for '${syncHandle}'.`,
    };
  }

  $: {
    const nextHandle = handle || null;
    if (nextHandle !== lastObservedHandle) {
      lastObservedHandle = nextHandle;
      trackedSyncRequestId = null;
      dismissedSuccessRequestId = null;
      clearSuccessMessageTimer();
    }
  }

  $: syncState = ($store as any).shopifySync || {};
  $: latestSyncRequestIdForHandle = handle
    ? (syncState.handleToLatestRequestId?.[handle] ?? null)
    : null;
  $: activeSyncRequestId =
    trackedSyncRequestId || latestSyncRequestIdForHandle || null;
  $: activeSyncRequest = activeSyncRequestId
    ? (syncState.requestsById?.[
        activeSyncRequestId
      ] as ShopifySyncRequestView) || null
    : null;
  $: syncDetailsHref = activeSyncRequestId
    ? `/sync-status?requestId=${encodeURIComponent(activeSyncRequestId)}`
    : "/sync-status";
  $: {
    if (
      trackedSyncRequestId &&
      latestSyncRequestIdForHandle &&
      trackedSyncRequestId !== latestSyncRequestIdForHandle
    ) {
      trackedSyncRequestId = null;
    }
  }

  $: {
    const syncHandle = handle || "";
    if (!syncHandle || !activeSyncRequestId) {
      // Keep the last non-sync-specific message (for example queue failures).
    } else if (!activeSyncRequest) {
      syncMessageLevel = "info";
      syncMessage = `Sync requested for '${syncHandle}'. Waiting for processor claim...`;
    } else if (
      activeSyncRequest.status === "success" &&
      dismissedSuccessRequestId === activeSyncRequest.requestId
    ) {
      syncMessage = "";
    } else {
      const next = buildSyncMessageFromRequest(activeSyncRequest, syncHandle);
      syncMessageLevel = next.level;
      syncMessage = next.text;
    }
  }

  $: {
    if (!activeSyncRequest || activeSyncRequest.status !== "success") {
      clearSuccessMessageTimer();
    } else if (dismissedSuccessRequestId === activeSyncRequest.requestId) {
      clearSuccessMessageTimer();
    } else {
      const requestId = activeSyncRequest.requestId;
      clearSuccessMessageTimer();
      successMessageTimeout = setTimeout(() => {
        dismissedSuccessRequestId = requestId;
      }, 30_000);
    }
  }

  function findUndefinedPaths(value: unknown, path = "root"): string[] {
    if (value === undefined) return [path];
    if (value === null) return [];
    if (Array.isArray(value)) {
      return value.flatMap((entry, idx) =>
        findUndefinedPaths(entry, `${path}[${idx}]`),
      );
    }
    if (typeof value === "object") {
      return Object.entries(value as Record<string, unknown>).flatMap(
        ([key, entry]) => findUndefinedPaths(entry, `${path}.${key}`),
      );
    }
    return [];
  }

  function sanitizeForDebug(value: unknown): unknown {
    if (value === undefined) return "__undefined__";
    if (value === null) return null;
    if (Array.isArray(value))
      return value.map((entry) => sanitizeForDebug(entry));
    if (typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          key,
          sanitizeForDebug(entry),
        ]),
      );
    }
    return value;
  }

  async function queueShopifyListingSync() {
    if (!handle) return;

    const uid = $user?.uid;
    if (!uid) {
      syncMessage = "Sign in to queue a Shopify sync request.";
      return;
    }

    const requestId = `listing-sync-${Date.now()}-${uid}`;
    const listingSnapshot = {
      handle,
      title: listingData?.title || "",
      bodyHtml: listingData?.bodyHtml || "",
      productCategory: listingData?.productCategory || "",
      option1Name: listingData?.option1Name || "Subtype",
      images: (listingImages || []).map((img, idx) => ({
        id: String(img?.id || ""),
        url: toGoogleDrivePublicImageUrl(String(img?.url || "")),
        position: Number.isFinite(Number(img?.position))
          ? Number(img.position)
          : idx + 1,
        altText: String(img?.altText || ""),
      })),
    };

    const variantsSnapshot = (associatedItems || [])
      .map((item: any) => {
        const janCode = String(item?.janCode || "").trim();
        const subtype = String(item?.subtype || "").trim();
        const sku = generateSku(janCode, subtype);
        const qty = Number(item?.qty || 0);
        const shipped = Number(item?.shipped || 0);
        const available = Math.max(0, qty - shipped);

        return {
          itemId: item?.id || "",
          sku,
          janCode,
          subtype,
          available,
          price: Number(item?.price || 0),
          weight: Number(item?.weight || 0),
          image: toGoogleDrivePublicImageUrl(String(item?.image || "")),
        };
      })
      .filter((v) => !!v.itemId && !!v.sku && !!v.janCode);

    if (variantsSnapshot.length === 0) {
      syncMessage = "Cannot sync: listing has no inventory variants.";
      return;
    }

    isQueueingSync = true;
    syncMessage = "";
    syncMessageLevel = "info";
    dismissedSuccessRequestId = null;
    clearSuccessMessageTimer();

    const syncRequestEvent = {
      eventType: SHOPIFY_SYNC_REQUEST_EVENT,
      requestId,
      handle,
      listing: listingSnapshot,
      variants: variantsSnapshot,
      source: "listing-detail",
      creator: uid,
      requestedBy: uid,
      requestedAt: Date.now(),
      payloadVersion: 1,
      createdAtMs: Date.now(),
      createdAt: serverTimestamp(),
      timestamp: serverTimestamp(),
    };

    try {
      const undefinedPaths = findUndefinedPaths(syncRequestEvent);
      if (undefinedPaths.length > 0) {
        console.error(
          "[Shopify Sync] Undefined fields in queued request payload",
          {
            requestId,
            handle,
            undefinedPaths,
            payload: sanitizeForDebug(syncRequestEvent),
            associatedItems: sanitizeForDebug(associatedItems),
          },
        );
      }

      await addDoc(
        collection(firestore, SHOPIFY_REQUEST_COLLECTION),
        syncRequestEvent,
      );
      trackedSyncRequestId = requestId;
      syncMessage = `Sync requested for '${handle}'. Waiting for processor claim...`;
      syncMessageLevel = "info";
    } catch (error) {
      console.error(
        `[Shopify Sync] addDoc(${SHOPIFY_REQUEST_COLLECTION}) failed`,
        {
          requestId,
          handle,
          error,
          undefinedPaths: findUndefinedPaths(syncRequestEvent),
          payload: sanitizeForDebug(syncRequestEvent),
        },
      );
      trackedSyncRequestId = null;
      syncMessage =
        error instanceof Error
          ? `Failed to queue sync: ${error.message}`
          : "Failed to queue sync request.";
      syncMessageLevel = "error";
    } finally {
      isQueueingSync = false;
    }
  }

  function goToJan(targetJan: string) {
    goto(`/listing-detail?mode=create&jan=${targetJan}`);
  }

  // Subtype Selection
  let selectedSubtypeId: string | null = null;
  $: if (associatedItems.length > 0 && selectedSubtypeId === null) {
    selectedSubtypeId = associatedItems[0].variantId || associatedItems[0].id;
  }

  function handleSelectSubtype(e: CustomEvent<string>) {
    selectedSubtypeId = e.detail;
  }

  // Updates
  function handleUpdateTitle(e: CustomEvent<string>) {
    if (!$user.uid) return;
    if (mode === "create" && janCode) {
      // Sync Title across all siblings to keep them grouped
      const targets =
        siblingProposals.length > 0 ? siblingProposals : [{ janCode }];
      targets.forEach((p) => {
        dispatchBroadcast(
          update_proposal_field({
            janCode: p.janCode,
            field: "title",
            value: e.detail,
          }),
        );
      });
    } else if (handle) {
      broadcast(
        firestore,
        $user.uid,
        update_listing({ handle, changes: { title: e.detail } }),
      );
    }
  }

  function handleUpdateDescription(e: CustomEvent<string>) {
    if (!$user.uid) return;
    if (mode === "create" && janCode) {
      // Sync Body across all siblings
      const targets =
        siblingProposals.length > 0 ? siblingProposals : [{ janCode }];
      targets.forEach((p) => {
        dispatchBroadcast(
          update_proposal_field({
            janCode: p.janCode,
            field: "bodyHtml",
            value: e.detail,
          }),
        );
      });
    } else if (handle) {
      broadcast(
        firestore,
        $user.uid,
        update_listing({ handle, changes: { bodyHtml: e.detail } }),
      );
    }
  }

  function handleUpdateCategory(e: CustomEvent<string>) {
    if (!$user.uid) return;
    if (mode === "create" && janCode) {
      // Sync Category across all siblings to keep them grouped
      const targets =
        siblingProposals.length > 0 ? siblingProposals : [{ janCode }];
      targets.forEach((p) => {
        dispatchBroadcast(
          update_proposal_field({
            janCode: p.janCode,
            field: "productCategory",
            value: e.detail,
          }),
        );
      });
    } else if (handle) {
      broadcast(
        firestore,
        $user.uid,
        update_listing({ handle, changes: { productCategory: e.detail } }),
      );
    }
  }

  function handleUpdatePrice(e: CustomEvent<number>) {
    const uid = $user.uid;
    if (!uid) return;
    const newPrice = e.detail;

    if (mode === "create" && janCode) {
      // Draft Mode: Update Redux state only
      dispatchBroadcast(
        update_proposal_field({ janCode, field: "price", value: newPrice }),
      );
    } else {
      // Live Mode: Update inventory directly
      associatedItems.forEach((item) => {
        if (item && item.id) {
          broadcast(
            firestore,
            uid,
            update_field({
              id: item.id as string,
              field: "price",
              from: item.price || 0,
              to: newPrice,
            }),
          );
        }
      });
    }
  }

  function handleUpdateVariantQty(e: CustomEvent<{ id: string; qty: number }>) {
    if (mode === "create" && janCode) {
      const editedVariantId = e.detail.id;
      const editedQty = Math.max(0, Number(e.detail.qty) || 0);
      const editedItem = associatedItems.find(
        (item) => (item.variantId || item.id) === editedVariantId,
      );

      dispatchBroadcast(
        update_variant_qty({
          janCode,
          variantId: editedVariantId,
          qty: editedQty,
        }),
      );

      // If this is a 2-way split of a single source inventory item, persist the complementary
      // allocation so the UI reflects real reducer state instead of a derived remainder.
      if (editedItem?.id) {
        const siblings = associatedItems.filter(
          (item) => item.id === editedItem.id,
        );
        if (siblings.length === 2) {
          const other = siblings.find(
            (item) => (item.variantId || item.id) !== editedVariantId,
          );
          const totalQty = Math.max(0, Number(editedItem.qty) || 0);
          if (other?.variantId) {
            const otherQty = Math.max(0, totalQty - editedQty);
            dispatchBroadcast(
              update_variant_qty({
                janCode,
                variantId: other.variantId,
                qty: otherQty,
              }),
            );
          }
        }
      }
    }
  }

  function handleUpdateVariantValue(
    e: CustomEvent<{ id: string; value: string }>,
  ) {
    const { id, value } = e.detail;
    if (mode === "create" && janCode) {
      dispatchBroadcast(
        update_variant_value({ janCode, variantId: id, value }),
      );
    } else {
      // Live Mode: Update Inventory Item
      const currentItem = $store.inventory.idToItem[id];
      const from = currentItem ? currentItem.subtype : "";

      dispatchBroadcast(
        update_field({
          id,
          field: "subtype",
          from,
          to: value,
        }),
      );
    }
  }

  // Image Deletion
  function handleDeleteImage(e: CustomEvent<any>) {
    if (mode === "create" && janCode) {
      const proposal = $store.listingCreation.proposals[janCode];
      const listingOnly = proposal?.listingOnlyImages || [];
      const isListingOnly = listingOnly.some(
        (img: { id: string }) => img.id === e.detail.id,
      );

      if (isListingOnly) {
        // Listing only images are attached to the PROPOSAL (base JAN)
        // But if we support splitting listing-only images? Not yet.
        dispatchBroadcast(
          remove_listing_only_image({ janCode: janCode, imageId: e.detail.id }),
        );
      } else {
        // Exclude from proposal instead of removing from source
        dispatchBroadcast(
          exclude_proposal_photo({ janCode, photoId: e.detail.id }),
        );
      }

      // Sync Order: Remove ID from listingImageOrder to ensure strict/robust removal
      if (proposal.listingImageOrder) {
        const newOrder = proposal.listingImageOrder.filter(
          (id: string) => id !== e.detail.id,
        );
        if (newOrder.length !== proposal.listingImageOrder.length) {
          dispatchBroadcast(
            update_proposal_field({
              janCode,
              field: "listingImageOrder",
              value: newOrder,
            }),
          );
        }
      }
      return;
    }
    if (!$user.uid || !handle) return;
    broadcast(
      firestore,
      $user.uid,
      remove_listing_image({ handle, imageId: e.detail.id }),
    );
  }

  function handleDeleteSubtypeImage(e: CustomEvent<any>) {
    if (!$user.uid) return;
    const { id, image } = e.detail;

    if (mode === "create" && janCode) {
      // Find item to get variantId if 'id' is a JAN
      const item = associatedItems.find((i) => (i.variantId || i.id) === id);
      const vId = item?.variantId || id;
      dispatchBroadcast(
        update_variant_image({
          janCode,
          variantId: vId,
          image: "",
        }),
      );
    } else {
      broadcast(
        firestore,
        $user.uid,
        update_field({
          id,
          field: "image",
          from: image,
          to: "",
        }),
      );
    }
  }

  // Image Upload / Replace Logic
  function handleReplaceImage(e: CustomEvent<any>) {
    const img = e.detail;
    uploadingImageId = img.id;
    replacingImagePosition = img.position;
    replacingSubtypeId = null;
    targetProposalJan = mode === "create" ? janCode : null;
    fileInput.click();
  }

  function handleReplaceSubtypeImage(e: CustomEvent<any>) {
    const item = e.detail;
    // CRITICAL: Use variantId if available to avoid finding the first item with a shared JAN
    replacingSubtypeId = item.variantId || item.id;
    uploadingImageId = null;
    targetProposalJan = mode === "create" ? janCode : null;

    // Open Image Picker instead of file upload (supports both create and live mode)
    imagePickerTargetJan = mode === "create" ? janCode : null;
    showAllPhotos = false;
    showImagePicker = true;
  }

  async function handleFileUpload(event: Event) {
    const target = event.target as HTMLInputElement;
    if (!target.files || target.files.length === 0) return;

    const file = target.files[0];

    try {
      const token = getStoredToken();
      if (!token) {
        initiateOAuthFlow(window.location.href);
        return;
      }

      const folders = await ensureFolderStructure(token.access_token);
      const uploadKey = mode === "create" ? janCode : handle;
      const filename = `replace_${uploadKey}_${Date.now()}.jpg`;
      const contentHash = await calculateHash(file);
      const result = await uploadImageToDrive(
        file,
        filename,
        folders.processedId,
        token.access_token,
        generateDerivationKey("ext", contentHash, "identity"),
      );
      const newUrl = toGoogleDrivePublicImageUrl(
        result.publicUrl ||
          result.apiUrl ||
          result.thumbnailLink ||
          result.webViewLink ||
          "",
      );

      if ($user.uid) {
        if (replacingSubtypeId) {
          const item = associatedItems.find(
            (i) => (i.variantId || i.id) === replacingSubtypeId,
          );
          if (item) {
            if (mode === "create" && janCode) {
              const vId = item.variantId || item.id;
              dispatchBroadcast(
                update_variant_image({
                  janCode,
                  variantId: vId,
                  image: newUrl,
                }),
              );
            } else {
              broadcast(
                firestore,
                $user.uid,
                update_field({
                  id: item.id,
                  field: "image",
                  from: item.image,
                  to: newUrl,
                }),
              );
            }
          }
        } else if (mode === "create") {
          // Draft Gallery Replacement
          if (uploadingImageId && replacingImagePosition !== null && janCode) {
            // 1. Identify Old Image Type
            const oldImage = listingImages.find(
              (img) => img.id === uploadingImageId,
            );
            // @ts-ignore
            const isListingOnly = oldImage?.isListingOnly;

            // 2. Add new image as listing-only
            const newImageId = crypto.randomUUID();
            const newImage: ListingImage = {
              id: newImageId,
              url: newUrl,
              position: replacingImagePosition,
              altText: listingData?.title || "",
            };
            dispatchBroadcast(
              add_listing_only_image({ janCode, image: newImage }),
            );

            // 3. Update Order to swap ID
            // Current order might be implicit or explicit.
            let currentOrder =
              $store.listingCreation.proposals[janCode]?.listingImageOrder ||
              [];

            // If explicit order doesn't exist, we must build it from the current view
            if (currentOrder.length === 0) {
              currentOrder = listingImages.map((img) => img.id);
            }

            // Swap
            const index = currentOrder.indexOf(uploadingImageId);
            if (index !== -1) {
              const newOrder = [...currentOrder];
              newOrder[index] = newImageId;
              dispatchBroadcast(
                update_proposal_field({
                  janCode,
                  field: "listingImageOrder",
                  value: newOrder,
                }),
              );
            } else {
              // Fallback: append if not found (shouldn't happen)
              console.warn(
                "Could not find image to replace in order",
                uploadingImageId,
              );
              // Force append? No, order is critical for replacement.
            }

            // 4. Remove Old Image
            // Use sourceGroup/sourceJan from the image object if available
            // Draft images have extra metadata injected by buildDraftListingImages
            type DraftListingImage = ListingImage & {
              sourceGroup?: string;
              sourceJan?: string;
              isListingOnly?: boolean;
            };
            const oldImageTyped = oldImage as DraftListingImage;

            const targetJan =
              oldImageTyped?.sourceGroup || oldImageTyped?.sourceJan || janCode;

            if (isListingOnly) {
              dispatchBroadcast(
                remove_listing_only_image({
                  janCode: janCode,
                  imageId: uploadingImageId,
                }),
              );
            } else {
              dispatchBroadcast(
                uncategorize_photo({
                  janCode: targetJan,
                  photoId: uploadingImageId,
                }),
              );
            }
          }
        } else {
          if (handle) {
            if (uploadingImageId && replacingImagePosition !== null) {
              // Replace existing
              broadcast(
                firestore,
                $user.uid,
                remove_listing_image({ handle, imageId: uploadingImageId }),
              );
              const newImage: ListingImage = {
                id: crypto.randomUUID(),
                url: newUrl,
                position: replacingImagePosition,
                altText: listingData?.title || "",
              };
              broadcast(
                firestore,
                $user.uid,
                add_listing_image({ handle, image: newImage }),
              );
            } else {
              // Add New
              const newImage: ListingImage = {
                id: crypto.randomUUID(),
                url: newUrl,
                position: listingImages.length + 1,
                altText: listingData?.title || "",
                isListingOnly: true,
              };
              broadcast(
                firestore,
                $user.uid,
                add_listing_image({ handle, image: newImage }),
              );
            }
          }
        }
      }
    } catch (e) {
      console.error("Upload failed", e);
      alert("Failed to upload image. Check console.");
    } finally {
      uploadingImageId = null;
      replacingImagePosition = null;
      replacingSubtypeId = null;
      targetProposalJan = null;
      if (fileInput) fileInput.value = "";
    }
  }

  // Approval
  function handleApprove() {
    if (mode === "create" && janCode) {
      // Preflight check for items that will be "stolen" from other listings
      const proposal = $store.listingCreation.proposals[janCode];
      if (proposal) {
        const targetHandle =
          proposal.handle || generateHandle(proposal.title, proposal.janCode);
        const collisions: { itemId: string; currentHandle: string }[] = [];

        proposal.variants.forEach((v: any) => {
          const item = $store.inventory.idToItem[v.itemId];
          if (item && item.handle && item.handle !== targetHandle) {
            collisions.push({ itemId: v.itemId, currentHandle: item.handle });
          }
        });

        if (collisions.length > 0) {
          const warning =
            `Warning: ${collisions.length} item(s) in this proposal currently belong to other listings:\n\n` +
            collisions
              .map((c) => `- Item ${c.itemId} belongs to '${c.currentHandle}'`)
              .join("\n") +
            `\n\nApproving will move these items to '${targetHandle}'. Continue?`;

          if (!confirm(warning)) return;
        }
      }

      approve_proposal_thunk(janCode)(
        dispatchBroadcast,
        store.getState,
        undefined,
      );
      // Navigation is handled reactively when the item leaves activeBatchJans
    }
  }

  // Reactive Navigation for Batch Flow
  $: if (!isExiting && mode === "create" && janCode) {
    // If the current item is no longer in the active batch (e.g. approved)
    // We must advance to the valid item at the current step.
    if (activeBatchJans.length > 0 && !activeBatchJans.includes(janCode)) {
      const nextIndex = $store.listingCreation.currentStepIndex;
      // Ensure index is valid
      const validIndex = Math.min(
        Math.max(0, nextIndex),
        activeBatchJans.length - 1,
      );
      const nextJan = activeBatchJans[validIndex];
      if (nextJan) {
        goto(`/listing-detail?mode=create&jan=${nextJan}`);
      }
    } else if (activeBatchJans.length === 0) {
      // Check if it was just approved
      const allProposals = Object.values($store.listingCreation.proposals);
      if (
        allProposals.some(
          (p: any) => p.janCode === janCode && p.status === "approved",
        )
      ) {
        goto("/listings/create");
      } else {
        // Fallback for safety
        goto("/listings/create");
      }
    }
  }

  function openImagePicker() {
    showAllPhotos = false;
    if (mode === "create" && janCode) {
      imagePickerTargetJan = janCode;
      replacingSubtypeId = null;
      showImagePicker = true;
    } else if (handle) {
      // Live Mode: Open Picker for Gallery Addition
      imagePickerTargetJan = null;
      replacingSubtypeId = null;
      showImagePicker = true;
    }
  }

  function buildImagePickerCandidates(showAll: boolean = false) {
    const candidates = new Map<
      string,
      { id: string; url: string; altText: string }
    >();

    console.log(
      "[ImagePicker] Building candidates for mode:",
      mode,
      "handle:",
      handle,
      "janCode:",
      janCode,
      "associatedItems:",
      associatedItems,
      "showAll:",
      showAll,
    );

    if (showAll) {
      const allKeys = Object.keys($store.photos.janCodeToPhotos || {});
      allKeys.forEach((k) => {
        const photos = $store.photos.janCodeToPhotos[k] || [];
        photos.forEach((p: any, idx: number) => {
          const url = p.baseUrl || p.thumbnailLink || p.productUrl;
          if (!url) return;
          if (!candidates.has(url)) {
            candidates.set(url, {
              id: p.id || `group-${k}-${idx}`,
              url,
              altText: p.filename || `Group ${k}`,
            });
          }
        });
      });
      return Array.from(candidates.values());
    }

    if (handle) {
      const allKeys = Object.keys($store.photos.janCodeToPhotos || {});
      console.log("[ImagePicker] All Store Keys:", allKeys);

      // Live Mode: Scan all associated JANs
      const seenJans = new Set<string>();
      associatedItems.forEach((item) => {
        if (item.janCode && !seenJans.has(item.janCode)) {
          seenJans.add(item.janCode);
          const searchJan = item.janCode.toString().trim();

          console.log(`[ImagePicker] Searching for JAN: '${searchJan}'`);

          // Find all keys starting with this JAN (Base + Subtypes)
          // Explicitly checking for Exact Match OR Prefix Match
          const relatedKeys = allKeys.filter(
            (k) => k === searchJan || k.startsWith(searchJan + ":"),
          );

          console.log(
            `[ImagePicker] Found related keys for '${searchJan}':`,
            relatedKeys,
          );

          relatedKeys.forEach((k) => {
            const photos = $store.photos.janCodeToPhotos[k] || [];
            photos.forEach((p: any, idx: number) => {
              const url = p.baseUrl || p.thumbnailLink || p.productUrl;
              if (!url) return;
              candidates.set(url, {
                id: p.id || `group-${k}-${idx}`,
                url,
                altText: p.filename || `Photo Group ${k}`,
              });
            });
          });
        }
      });
      return Array.from(candidates.values());
    }

    if (mode !== "create" || !janCode) return [];
    const primary = $store.listingCreation.proposals[janCode];
    if (!primary) return [];
    const handleKey =
      primary.handle || generateHandle(primary.title, primary.janCode);
    const proposals = Object.values($store.listingCreation.proposals);
    const siblings = proposals.filter((p: any) => {
      const h = p.handle || generateHandle(p.title, p.janCode);
      return h === handleKey;
    });

    // 1. Photos from related groups (Base JAN prefix search)
    const allPhotoKeys = Object.keys($store.photos.janCodeToPhotos || {});
    const searchPrefix = primary.janCode.toString().trim();
    const relatedKeys = allPhotoKeys.filter(
      (k) => k === searchPrefix || k.startsWith(searchPrefix + ":"),
    );

    relatedKeys.forEach((k) => {
      const photos = $store.photos.janCodeToPhotos[k] || [];
      photos.forEach((p: any, idx: number) => {
        const url = p.baseUrl || p.thumbnailLink || p.productUrl;
        if (!url) return;
        if (!candidates.has(url)) {
          candidates.set(url, {
            id: p.id || `group-${k}-${idx}`,
            url,
            altText: p.filename || `Photo Group ${k}`,
          });
        }
      });
    });

    // 2. Photos from Linked Photo Groups (Explicitly mentioned ones that might not match prefix)
    if (primary.photoGroupIds) {
      primary.photoGroupIds.forEach((gid: string) => {
        if (relatedKeys.includes(gid)) return; // Already added
        const groupPhotos = $store.photos.janCodeToPhotos?.[gid] || [];
        groupPhotos.forEach((p: any, idx: number) => {
          const url = p.baseUrl || p.thumbnailLink || p.productUrl;
          if (!url) return;
          if (!candidates.has(url)) {
            candidates.set(url, {
              id: p.id || `group-${gid}-${idx}`,
              url,
              altText: p.filename || `Photo Group ${gid}`,
            });
          }
        });
      });
    }

    // 3. Photos from Variant Photo Groups (Aggregation from all variants)
    siblings.forEach((p: any) => {
      // New: Check variants for photo groups
      if (p.variants) {
        p.variants.forEach((v: any) => {
          if (v.photoGroupKey) {
            // Avoid duplicates if already processed via relatedKeys
            if (relatedKeys.includes(v.photoGroupKey)) return;

            const groupPhotos =
              $store.photos.janCodeToPhotos?.[v.photoGroupKey] || [];
            groupPhotos.forEach((photo: any, idx: number) => {
              const url =
                photo.baseUrl || photo.thumbnailLink || photo.productUrl;
              if (!url) return;
              if (!candidates.has(url)) {
                candidates.set(url, {
                  id: photo.id || `group-${v.photoGroupKey}-${idx}`,
                  url,
                  altText: photo.filename || `Photo Group ${v.photoGroupKey}`,
                });
              }
            });
          }
        });
      }

      // Existing: Check Inventory Item Images
      p.inventoryItemIds.forEach((id: string) => {
        const item = $store.inventory.idToItem[id];
        if (!item?.image) return;
        const url = item.image;
        if (!candidates.has(url)) {
          candidates.set(url, {
            id: `variant-${id}`,
            url,
            altText: item.subtype || "Variant image",
          });
        }
      });
    });

    return Array.from(candidates.values());
  }

  function handlePickListingImage(candidate: {
    id: string;
    url: string;
    altText: string;
  }) {
    const candidateUrl = toGoogleDrivePublicImageUrl(candidate.url || "");

    if (handle) {
      if (replacingSubtypeId) {
        // Live Mode: Update Inventory Item
        if ($user && $user.uid) {
          broadcast(
            firestore,
            $user.uid,
            update_field({
              id: replacingSubtypeId,
              field: "image",
              from: "",
              to: candidateUrl,
            }),
          );
        }
      } else {
        // Add New Image to Listing
        if ($user && $user.uid) {
          const newImage: ListingImage = {
            id: crypto.randomUUID(),
            url: candidateUrl,
            position: listingImages.length + 1,
            altText: candidate.altText || "",
            isListingOnly: true,
          };
          broadcast(
            firestore,
            $user.uid,
            add_listing_image({ handle, image: newImage }),
          );
        }
      }
      showImagePicker = false;
      replacingSubtypeId = null;
      return;
    }

    if (!imagePickerTargetJan) return;

    if (replacingSubtypeId) {
      // Replace Subtype Image
      if ($user && $user.uid) {
        if (mode === "create" && janCode) {
          // Draft Mode: Update ListingVariant image override
          const item = associatedItems.find(
            (i) => (i.variantId || i.id) === replacingSubtypeId,
          );
          const vId = item?.variantId || replacingSubtypeId;

          dispatchBroadcast(
            update_variant_image({
              janCode,
              variantId: vId,
              image: candidateUrl,
            }),
          );
        } else {
          // Live Mode: Update Inventory Item directly
          broadcast(
            firestore,
            $user.uid,
            update_field({
              id: replacingSubtypeId,
              field: "image",
              from: "",
              to: candidateUrl,
            }),
          );
        }
      }
      replacingSubtypeId = null;
    } else {
      // Check for exclusion first
      const proposal = $store.listingCreation.proposals[imagePickerTargetJan];
      const isExcluded = proposal?.excludedPhotoIds?.includes(candidate.id);

      if (isExcluded) {
        dispatchBroadcast(
          include_proposal_photo({
            janCode: imagePickerTargetJan,
            photoId: candidate.id,
          }),
        );

        // If explicit order exists, ensure this ID is added
        if (
          proposal.listingImageOrder &&
          proposal.listingImageOrder.length > 0
        ) {
          const newOrder = [...proposal.listingImageOrder, candidate.id];
          dispatchBroadcast(
            update_proposal_field({
              janCode: imagePickerTargetJan,
              field: "listingImageOrder",
              value: newOrder,
            }),
          );
        }
      } else {
        // Add to Gallery (New Listing Only Image)
        const imageId =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `img-${Date.now()}`;
        const image = {
          id: imageId,
          url: candidateUrl,
          altText: candidate.altText || "",
          position: listingImages.length + 1,
        };
        if ($user && $user.uid) {
          dispatchBroadcast(
            add_listing_only_image({ janCode: imagePickerTargetJan, image }),
          );
        }
      }
    }
    showImagePicker = false;
    imagePickerTargetJan = null;
  }

  function handleAddVariant() {
    if (readOnly) return;
    variantModalMode = "add";
    variantModalJan =
      janCode || (associatedItems.length > 0 ? associatedItems[0].janCode : "");
    variantModalSourceItem = null;
    showVariantModal = true;
  }

  function handleRemovals(removals: string[]) {
    console.log("[ListingDetail] handleRemovals", removals);
    if (!removals || removals.length === 0) return;

    if (isLiveMode && handle) {
      removals.forEach((itemId: string) => {
        const item = $store.inventory.idToItem[itemId];
        const handleInListings = $store.listings.idToHandle[itemId];
        const handleInInventory = item?.handle || "";

        console.log(`[ListingDetail] Removing item ${itemId}:`, {
          existsInInventory: !!item,
          handleInListings,
          handleInInventory,
          targetHandle: handle,
          match: handleInListings === handle || handleInInventory === handle,
        });

        if (handleInListings === handle || handleInInventory === handle) {
          dispatchBroadcast(
            update_field({
              id: itemId,
              field: "handle",
              from: handleInInventory || handle, // Use existing or target
              to: "",
            }),
          );
        }
      });
    } else if (mode === "create" && janCode) {
      removals.forEach((rowId: string) => {
        const proposal = $store.listingCreation.proposals[janCode];
        if (proposal) {
          const variant = proposal.variants.find(
            (v: any) => v.id === rowId || v.itemId === rowId,
          );
          if (variant) {
            console.log(
              `[ListingDetail] Requesting removal of variant ${variant.id} (rowId: ${rowId})`,
            );
            dispatchBroadcast(
              remove_variant_requested({ janCode, variantId: variant.id }),
            );
          }
        }
      });
    }
  }

  function onConfirmAddVariant(e: CustomEvent<any>) {
    const {
      itemId,
      subtype,
      qty,
      proposedQtys,
      removals,
      janCode: detailJanCode,
    } = e.detail;
    showVariantModal = false;

    if (mode === "create" && janCode) {
      const targetJan = detailJanCode || variantModalJan;
      const variantId = `${targetJan}:${subtype}:${crypto.randomUUID().slice(0, 8)}`;

      // 1. Apply all quantity changes for existing variants
      if (proposedQtys) {
        Object.entries(proposedQtys).forEach(([id, newQty]) => {
          const proposal = $store.listingCreation.proposals[janCode];
          const variant = proposal?.variants.find((v: any) => v.id === id);
          if (variant && variant.qty !== newQty) {
            dispatchBroadcast(
              update_variant_qty({
                janCode,
                variantId: id,
                qty: newQty as number,
              }),
            );
          }
        });
      }

      // 2. Request adding the new variant
      dispatchBroadcast(
        add_variant_requested({
          targetJan: janCode,
          janCode: targetJan,
          variantId,
          subtype,
          qty,
        }),
      );
      handleRemovals(removals);
    } else if (isLiveMode && handle) {
      // 1. Apply all quantity changes from the allocation view
      if (proposedQtys) {
        Object.entries(proposedQtys).forEach(([id, newQty]) => {
          const item = $store.inventory.idToItem[id];
          if (item && item.qty !== newQty) {
            dispatchBroadcast(
              update_field({
                id,
                field: "qty",
                from: item.qty,
                to: newQty as number,
              }),
            );
          }
        });
      }

      const item = $store.inventory.idToItem[itemId];
      if (!item) {
        handleRemovals(removals);
        return;
      }

      const fromHandle = item.handle || "";
      // 2. Sync Handle
      dispatchBroadcast(
        update_field({
          id: itemId,
          field: "handle",
          from: fromHandle,
          to: handle,
        }),
      );
      // 3. Sync Subtype
      if (subtype && subtype !== item.subtype) {
        dispatchBroadcast(
          update_field({
            id: itemId,
            field: "subtype",
            from: item.subtype || "",
            to: subtype,
          }),
        );
      }
      // 4. Sync Qty (for the new item itself)
      if (typeof qty === "number" && qty !== item.qty) {
        dispatchBroadcast(
          update_field({
            id: itemId,
            field: "qty",
            from: item.qty,
            to: qty,
          }),
        );
      }
      handleRemovals(removals);
    }
  }

  function onConfirmSplitVariant(e: CustomEvent<any>) {
    const {
      sourceId,
      sourceVariantId,
      sourceSubtype,
      sourceQty,
      newSubtype,
      newQty,
      proposedQtys,
      removals,
      janCode: detailJanCode,
    } = e.detail;
    showVariantModal = false;

    if (mode === "create" && janCode) {
      const targetJan = detailJanCode || variantModalJan;
      const variantId = `${targetJan}:${newSubtype}:${crypto.randomUUID().slice(0, 8)}`;

      // 1. Apply all other quantity changes for existing variants
      if (proposedQtys) {
        Object.entries(proposedQtys).forEach(([id, qty]) => {
          const proposal = $store.listingCreation.proposals[janCode];
          const variant = proposal?.variants.find((v: any) => v.id === id);
          if (variant && variant.qty !== qty) {
            dispatchBroadcast(
              update_variant_qty({
                janCode,
                variantId: id,
                qty: qty as number,
              }),
            );
          }
        });
      }

      // 2. Request the split (adds the new variant)
      dispatchBroadcast(
        add_variant_requested({
          targetJan: janCode,
          janCode: targetJan,
          variantId,
          sourceVariantId,
          subtype: newSubtype,
          qty: newQty,
        }),
      );
      handleRemovals(removals);
    } else if (isLiveMode && handle) {
      // 1. Apply all other quantity changes first
      if (proposedQtys) {
        Object.entries(proposedQtys).forEach(([id, qty]) => {
          if (id === sourceId) return; // Skip source as it's handled by split
          const item = $store.inventory.idToItem[id];
          if (item && item.qty !== qty) {
            dispatchBroadcast(
              update_field({
                id,
                field: "qty",
                from: item.qty,
                to: qty as number,
              }),
            );
          }
        });
      }

      const targetJan = detailJanCode || variantModalJan;
      const newId = makeInventoryItemKey(targetJan, newSubtype);

      // 2. Perform Split
      dispatchBroadcast(
        split_inventory_item({
          sourceId: sourceId as any,
          splits: [{ newId: newId as any, qty: newQty, subtype: newSubtype }],
        }),
      );

      // 3. Update Source Subtype if changed
      const item = $store.inventory.idToItem[sourceId];
      if (item && sourceSubtype !== item.subtype) {
        dispatchBroadcast(
          update_field({
            id: sourceId,
            field: "subtype",
            from: item.subtype || "",
            to: sourceSubtype,
          }),
        );
      }

      // 4. Ensure Handle is set on NEW item
      dispatchBroadcast(
        update_field({
          id: newId,
          field: "handle",
          from: "",
          to: handle,
        }),
      );
      handleRemovals(removals);
    }
  }

  function onConfirmManage(e: CustomEvent<any>) {
    const { proposedQtys, removals } = e.detail;
    console.log("[ListingDetail] onConfirmManage", {
      proposedQtys,
      removals,
      mode,
      handle,
      janCode,
      isLiveMode,
    });
    showVariantModal = false;

    if (isLiveMode && handle) {
      // 1. Apply all quantity changes
      Object.entries(proposedQtys).forEach(([itemId, newQty]) => {
        const item = $store.inventory.idToItem[itemId];
        if (item && item.qty !== newQty) {
          console.log(
            `[ListingDetail] Updating live qty for ${itemId}: ${item.qty} -> ${newQty}`,
          );
          dispatchBroadcast(
            update_field({
              id: itemId,
              field: "qty",
              from: item.qty,
              to: newQty as number,
            }),
          );
        }
      });

      handleRemovals(removals);
    } else if (mode === "create" && janCode) {
      // 1. Apply quantity changes to variants
      Object.entries(proposedQtys).forEach(([rowId, newQty]) => {
        const proposal = $store.listingCreation.proposals[janCode];
        if (proposal) {
          const variant = proposal.variants.find(
            (v: any) => v.id === rowId || v.itemId === rowId,
          );
          if (variant && variant.qty !== newQty) {
            console.log(
              `[ListingDetail] Updating draft qty for variant ${variant.id} (rowId ${rowId}): ${variant.qty} -> ${newQty}`,
            );
            dispatchBroadcast(
              update_variant_qty({
                janCode,
                variantId: variant.id,
                qty: newQty as number,
              }),
            );
          }
        }
      });

      handleRemovals(removals);
    }
  }

  function handleRemoveProposal() {
    if (mode !== "create" || !janCode) return;
    const stateBefore = store.getState().listingCreation;
    const currentIndex = stateBefore.activeBatchJans.indexOf(janCode);

    // Identify items to remove (current + siblings sharing handle)
    const primaryProposal = stateBefore.proposals[janCode];
    let removedJans: string[] = [janCode];

    if (primaryProposal) {
      const handle =
        primaryProposal.handle ||
        generateHandle(primaryProposal.title, primaryProposal.janCode);
      const siblingProposals = Object.values(stateBefore.proposals).filter(
        (p: any) => {
          const h = p.handle || generateHandle(p.title, p.janCode);
          return h === handle;
        },
      );

      removedJans = siblingProposals.map((p: any) => p.janCode);
      if (!removedJans.includes(janCode)) removedJans.push(janCode);

      removedJans.forEach((jan: string) => {
        dispatchBroadcast(remove_proposal({ janCode: jan }));
      });
    } else {
      dispatchBroadcast(remove_proposal({ janCode }));
    }

    // Optimistically calculate remaining items
    const remaining = stateBefore.activeBatchJans.filter(
      (j: string) => !removedJans.includes(j),
    );

    console.log("[handleDrop] Debug:", {
      currentJan: janCode,
      activeBatch: stateBefore.activeBatchJans,
      removed: removedJans,
      remaining: remaining,
      currentIndex,
      nextIndexCalc: currentIndex >= remaining.length ? 0 : currentIndex,
    });

    if (remaining.length === 0) {
      dispatchBroadcast(complete_batch());
      goto("/listings/create");
      return;
    }

    let nextIndex = currentIndex;
    if (nextIndex >= remaining.length) {
      nextIndex = 0; // Wrap to start if we dropped the last item
    }

    const nextJan = remaining[nextIndex];
    dispatchBroadcast(set_current_step(nextIndex));
    goto(`/listing-detail?mode=create&jan=${nextJan}`);
  }

  function handleReorderImages(
    e: CustomEvent<{ sourceId: string; targetId: string }>,
  ) {
    const { sourceId, targetId } = e.detail;

    const proposal =
      mode === "create" && janCode
        ? $store.listingCreation.proposals[janCode]
        : null;
    const listingOnly = proposal?.listingOnlyImages || [];

    const result = reorderListingImages({
      listingImages,
      associatedItems,
      sourceId,
      targetId,
      listingOnlyImages: listingOnly,
    });

    if (!result) return;

    listingImages = result.updatedImages;

    if (mode === "create" && janCode) {
      dispatchBroadcast(
        update_proposal_field({
          janCode,
          field: "listingImageOrder",
          value: result.reorderedGalleryIds,
        }),
      );
      dispatchBroadcast(
        update_proposal_field({
          janCode,
          field: "listingOnlyImages",
          value: result.updatedListingOnly,
        }),
      );
    } else if (handle && $user?.uid) {
      broadcast(
        firestore,
        $user.uid,
        update_listing({ handle, changes: { images: result.updatedImages } }),
      );
    }

    result.variantPositions.forEach(({ id, position }) => {
      const item = associatedItems.find((i) => (i.variantId || i.id) === id);
      if (!item) return;
      dispatchBroadcast(
        update_field({
          id,
          field: "imagePosition",
          from: item.imagePosition || 0,
          to: position,
        }),
      );
    });
  }

  function handleReorderSubtypes(e: CustomEvent<{ order: string[] }>) {
    if (mode === "create" && janCode) {
      dispatchBroadcast(
        reorder_variants({ janCode, newVariantOrder: e.detail.order }),
      );
    } else if (handle) {
      // Live Mode: Update imagePosition to persist order
      e.detail.order.forEach((id, index) => {
        const item = associatedItems.find((i) => (i.variantId || i.id) === id);
        // imagePosition is 1-based usually
        const newPos = index + 1;
        if (item && item.imagePosition !== newPos) {
          dispatchBroadcast(
            update_field({
              id: item.id as string,
              field: "imagePosition",
              from: item.imagePosition || 0,
              to: newPos,
            }),
          );
        }
      });
    }
  }

  // Search (Live Mode)
  function handleSearch() {
    if (!searchTerm) {
      matchingHandles = [];
      return;
    }
    const q = searchTerm.toLowerCase();
    matchingHandles = Object.keys($store.listings.handleToListing).filter((h) =>
      h.toLowerCase().includes(q),
    );

    if (matchingHandles.length === 1) {
      goto(`/listing-detail?mode=live&handle=${matchingHandles[0]}`);
      searchTerm = "";
      matchingHandles = [];
    }
  }

  function selectHandle(h: string) {
    goto(`/listing-detail?mode=live&handle=${h}`);
    searchTerm = "";
    matchingHandles = [];
  }
</script>

<div class="container">
  <!-- Header / Navigation -->
  {#if isLiveMode}
    <div class="search-header">
      <div class="search-bar-row">
        <input
          class="search-input"
          type="text"
          placeholder="Search by handle..."
          bind:value={searchTerm}
          on:input={handleSearch}
          on:keydown={(e) => e.key === "Enter" && handleSearch()}
        />
        <button class="back-btn" on:click={() => goto("/shopify-products")}
          >Back to List</button
        >
      </div>
      {#if matchingHandles.length > 0 && searchTerm}
        <div class="search-results">
          {#each matchingHandles as h}
            <button class="result-item" on:click={() => selectHandle(h)}>
              {h}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <div class="search-header">
      <div class="nav-row">
        <button
          class="back-btn"
          on:click={() => {
            isExiting = true;
            dispatchBroadcast(set_current_step(-1));
            goto("/listings/create");
          }}>Back to Batch</button
        >

        <!-- Quick Batch Nav -->
        {#if activeBatchJans.length > 0}
          <div class="mini-nav">
            <button
              class="icon-btn"
              disabled={!prevJan}
              on:click={() => prevJan && goToJan(prevJan)}
              aria-label="Previous item"
            >
              <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <span class="step-text"
              >{currentIndex + 1} / {activeBatchJans.length}</span
            >
            <button
              class="icon-btn"
              disabled={!nextJan}
              on:click={() => nextJan && goToJan(nextJan)}
              aria-label="Next item"
            >
              <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#if listingData}
    <div class="ai-controls-toolbar">
      <div class="ai-group">
        {#if mode === "create"}
          <span class="label">AI Tools:</span>

          <div class="btn-group">
            <button
              class="ai-btn"
              disabled={isGeneratingTitle}
              on:click={() =>
                janCode &&
                regenerate_title(janCode)(
                  dispatchBroadcast,
                  store.getState,
                  undefined,
                )}
            >
              {#if isGeneratingTitle}
                <span class="spinner small"></span>
              {:else}
                ↻
              {/if} Title
            </button>
            <button
              class="ai-btn icon-only"
              disabled={isGeneratingTitle}
              on:click={() => openPromptModal("title")}
              title="Edit Prompt">✎</button
            >
          </div>

          <span class="sep">|</span>

          <div class="btn-group">
            <button
              class="ai-btn"
              disabled={isGeneratingDescription}
              on:click={handleToolbarRegenerateDescription}
            >
              {#if isGeneratingDescription}
                <span class="spinner small"></span>
              {:else}
                ↻
              {/if} Desc
            </button>
            <button
              class="ai-btn icon-only"
              disabled={isGeneratingDescription}
              on:click={() => openPromptModal("description")}
              title="Edit Prompt">✎</button
            >
          </div>
        {/if}

        <span class="sep">|</span>
        <div class="btn-group">
          {#if mode === "create" || handle}
            <button class="ai-btn" on:click={openImagePicker}
              >Add Listing Photo</button
            >
          {/if}
          <button class="ai-btn" on:click={openBodyModal}
            >Edit Description</button
          >
          {#if mode !== "create" && handle}
            <button
              class="ai-btn"
              disabled={isQueueingSync}
              on:click={queueShopifyListingSync}
              title="Queue this listing for Shopify API sync"
            >
              {isQueueingSync ? "Queueing..." : "Sync This Listing"}
            </button>
          {/if}
        </div>
      </div>
    </div>

    {#if syncMessage}
      <div class={`sync-message ${syncMessageLevel}`}>
        <span>{syncMessage}</span>
        {#if activeSyncRequestId}
          <a class="sync-link" href={syncDetailsHref}>View details</a>
        {/if}
      </div>
    {/if}

    <ListingEditor
      listing={listingData}
      images={listingImages}
      {associatedItems}
      knownCategories={$store.listings.knownCategories || []}
      bind:selectedSubtypeId
      {readOnly}
      isCreationMode={mode === "create"}
      {isGeneratingTitle}
      {isGeneratingDescription}
      on:updateTitle={handleUpdateTitle}
      on:updateDescription={handleUpdateDescription}
      on:updateCategory={handleUpdateCategory}
      on:updatePrice={handleUpdatePrice}
      on:updateVariantQty={handleUpdateVariantQty}
      on:updateVariantValue={handleUpdateVariantValue}
      on:deleteImage={handleDeleteImage}
      on:selectSubtype={handleSelectSubtype}
      on:deleteSubtypeImage={handleDeleteSubtypeImage}
      on:replaceImage={handleReplaceImage}
      on:replaceSubtypeImage={handleReplaceSubtypeImage}
      on:reorderImages={handleReorderImages}
      on:reorderSubtypes={handleReorderSubtypes}
      on:addImage={openImagePicker}
      on:approve={handleApprove}
      on:drop={handleRemoveProposal}
      on:addVariant={handleAddVariant}
    />
    <ListingVariantModal
      open={showVariantModal}
      mode={variantModalMode}
      janCode={variantModalJan}
      sourceItem={variantModalSourceItem}
      otherVariants={variantModalOtherVariants}
      {associatedItems}
      inventory={$store.inventory.idToItem}
      on:cancel={() => (showVariantModal = false)}
      on:confirmAdd={onConfirmAddVariant}
      on:confirmSplit={onConfirmSplitVariant}
      on:confirmManage={onConfirmManage}
    />

    <!-- Batch Navigation Footer -->
    {#if mode === "create" && activeBatchJans.length > 0}
      <div class="batch-nav-bar">
        <button
          class="nav-btn"
          disabled={!prevJan}
          on:click={() => prevJan && goToJan(prevJan)}>← Previous Item</button
        >
        <button
          class="nav-btn"
          disabled={!nextJan}
          on:click={() => nextJan && goToJan(nextJan)}>Next Item →</button
        >
      </div>
    {/if}
  {:else if (mode === "live" && handle) || (mode === "create" && janCode)}
    <div class="not-found">
      <p class="not-found-text">
        {#if mode === "create"}
          Proposal not found for JAN: <span class="handle-text">{janCode}</span>
        {:else}
          Listing not found for handle: <span class="handle-text">{handle}</span
          >
        {/if}
      </p>
      <button
        class="link-btn"
        on:click={() =>
          goto(mode === "create" ? "/listings/create" : "/shopify-products")}
        >Return</button
      >
    </div>
  {:else}
    <div class="empty-state">
      <p class="empty-text">Search for a listing or start a creation batch.</p>
    </div>
  {/if}

  {#if showImagePicker}
    {@const candidates = buildImagePickerCandidates(showAllPhotos)}
    <div class="modal-backdrop">
      <div class="modal image-picker-modal">
        <div class="modal-header-row">
          <h3 class="modal-title">Select listing image</h3>
          <label class="show-all-label">
            <input type="checkbox" bind:checked={showAllPhotos} />
            Show all photos
          </label>
        </div>

        {#if candidates.length > 0}
          <div class="image-picker-grid">
            {#each candidates as candidate}
              <button
                class="image-picker-item"
                on:click={() => handlePickListingImage(candidate)}
              >
                <ImageThumbnail src={candidate.url} alt={candidate.altText} />
              </button>
            {/each}
          </div>
        {:else}
          <div class="empty-picker-state">
            <p class="empty-picker-main">No photos found.</p>
            <p class="empty-picker-sub">
              Searched for photos associated with JAN codes:
            </p>
            <code class="jan-code-list">
              {associatedItems.map((i) => i.janCode).join(", ") || "None"}
            </code>
            <p class="debug-text">
              (Debug: Store has {Object.keys(
                $store.photos.janCodeToPhotos || {},
              ).length} photo groups)
            </p>
          </div>
        {/if}

        <div class="modal-actions">
          <button
            class="btn-cancel"
            on:click={() => {
              showImagePicker = false;
              imagePickerTargetJan = null;
            }}>Cancel</button
          >
        </div>
      </div>
    </div>
  {/if}

  <!-- Hidden File Input for Replacements -->
  <input
    type="file"
    accept="image/*"
    class="hidden-input"
    bind:this={fileInput}
    on:change={handleFileUpload}
  />

  <!-- Prompt Modal -->
  {#if showPromptModal}
    <div class="modal-backdrop prompt-backdrop">
      <div class="modal prompt-modal">
        <h3 class="modal-title">
          Custom AI Prompt for {promptTarget === "title"
            ? "Title"
            : "Description"}
        </h3>
        <textarea
          bind:value={customPrompt}
          rows="10"
          class="body-textarea"
          placeholder="Enter your instructions for the AI..."
        ></textarea>
        <div class="modal-actions">
          <button class="btn-cancel" on:click={() => (showPromptModal = false)}
            >Cancel</button
          >
          <button class="btn-save" on:click={handleRunPrompt}>Generate</button>
        </div>
      </div>
    </div>
  {/if}

  {#if showBodyModal}
    <BodyHtmlModal
      open={showBodyModal}
      value={bodyModalValue}
      title="Edit Description HTML"
      showRegenerate={mode === "create"}
      showPrompt={mode === "create"}
      on:save={saveBodyModal}
      on:cancel={cancelBodyModal}
      on:regenerate={handleBodyModalRegenerate}
      on:editPrompt={() => openPromptModal("description")}
    />
  {/if}
</div>

<style>
  .container {
    margin: 0 auto;
    padding: 2rem;
    font-family: sans-serif;
    color: #333;
  }
  .hidden-input {
    display: none;
  }

  /* Navigation & Toolbar */
  .search-header {
    margin-bottom: 2rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    position: relative;
  }
  .search-bar-row {
    display: flex;
    gap: 0.5rem;
  }
  .nav-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
  }

  .mini-nav {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 1px solid #e5e7eb;
    border-radius: 4px;
    background: white;
    cursor: pointer;
    padding: 0;
  }
  .nav-icon {
    width: 14px;
    height: 14px;
    stroke: currentColor;
    stroke-width: 2;
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .icon-btn:hover:not(:disabled) {
    background: #f3f4f6;
  }
  .icon-btn:disabled {
    color: #ccc;
    cursor: default;
  }
  .step-text {
    font-size: 0.9rem;
    font-weight: 500;
    color: #666;
  }

  .search-input {
    border: 1px solid #ccc;
    border-radius: 4px;
    padding: 0.5rem 1rem;
    width: 100%;
    max-width: 400px;
    font-size: 1rem;
  }
  .search-input:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
  }
  .back-btn {
    background: #f3f4f6;
    padding: 0.5rem 1rem;
    border-radius: 4px;
    border: none;
    cursor: pointer;
  }
  .back-btn:hover {
    background: #e5e7eb;
  }

  .ai-controls-toolbar {
    margin-bottom: 1.5rem;
    padding: 0.75rem;
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
    border-radius: 6px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .ai-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .label {
    font-weight: 600;
    font-size: 0.85rem;
    color: #166534;
    margin-right: 0.5rem;
  }
  .ai-btn {
    background: white;
    border: 1px solid #d1d5db;
    padding: 0.25rem 0.75rem;
    border-radius: 4px;
    font-size: 0.85rem;
    cursor: pointer;
    color: #374151;
  }
  .ai-btn:hover {
    border-color: #10b981;
    color: #059669;
  }
  .ai-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .sync-message {
    margin-top: -0.75rem;
    margin-bottom: 1rem;
    font-size: 0.9rem;
    border-radius: 6px;
    padding: 0.55rem 0.75rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .sync-message.info {
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    color: #1e3a8a;
  }
  .sync-message.success {
    background: #ecfdf5;
    border: 1px solid #a7f3d0;
    color: #065f46;
  }
  .sync-message.error {
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #991b1b;
  }
  .sync-link {
    color: inherit;
    font-weight: 600;
    text-decoration: underline;
    white-space: nowrap;
  }
  .sep {
    color: #d1d5db;
    margin: 0 0.25rem;
  }

  .batch-nav-bar {
    margin-top: 2rem;
    border-top: 1px solid #e5e7eb;
    padding-top: 1rem;
    display: flex;
    justify-content: space-between;
  }
  .nav-btn {
    padding: 0.75rem 1.5rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    background: white;
    cursor: pointer;
    font-weight: 500;
  }
  .nav-btn:hover:not(:disabled) {
    background: #f9fafb;
    border-color: #9ca3af;
  }
  .nav-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Search Results */
  .search-results {
    position: absolute;
    top: 100%;
    left: 0;
    width: 100%;
    max-width: 400px;
    background: white;
    border: 1px solid #e5e7eb;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    border-radius: 4px;
    z-index: 10;
    max-height: 240px;
    overflow-y: auto;
  }
  .result-item {
    width: 100%;
    text-align: left;
    padding: 0.5rem 1rem;
    background: none;
    border: none;
    cursor: pointer;
  }
  .result-item:hover {
    background: #eff6ff;
  }

  .not-found,
  .empty-state {
    text-align: center;
    padding: 5rem 0;
    color: #6b7280;
  }
  .not-found-text,
  .empty-text {
    font-size: 1.25rem;
  }
  .handle-text {
    font-family: monospace;
    color: #374151;
  }
  .link-btn {
    margin-top: 1rem;
    color: #2563eb;
    background: none;
    border: none;
    text-decoration: underline;
    cursor: pointer;
    font-size: 1rem;
  }
  .link-btn:hover {
    color: #1d4ed8;
  }

  /* Modal */
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
  }
  .modal {
    background: white;
    padding: 1.5rem;
    border-radius: 8px;
    width: 100%;
    max-width: 500px;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
  }
  .modal-header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }
  .show-all-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    cursor: pointer;
    user-select: none;
  }
  .empty-picker-state {
    padding: 2rem;
    text-align: center;
    color: #6b7280;
    background-color: #f9fafb;
    border-radius: 0.5rem;
    border: 1px dashed #d1d5db;
    margin-top: 1rem;
  }
  .empty-picker-main {
    font-weight: 500;
  }
  .empty-picker-sub {
    font-size: 0.75rem;
    margin-top: 0.5rem;
  }
  .jan-code-list {
    font-size: 0.75rem;
    display: block;
    margin-top: 0.25rem;
    background-color: white;
    padding: 0.25rem;
    border-radius: 0.25rem;
    border: 1px solid #e5e7eb;
  }
  .debug-text {
    font-size: 0.75rem;
    margin-top: 0.5rem;
    color: #9ca3af;
  }
  /* .image-tools-toolbar removed */
  .prompt-modal {
    max-width: 720px;
    z-index: 2001;
    position: relative;
  }
  .prompt-backdrop {
    z-index: 2000;
  }
  .body-textarea {
    min-height: 320px;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 0.75rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85rem;
    width: 100%;
  }
  .btn-save {
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    background: #2563eb;
    color: white;
    border: none;
    cursor: pointer;
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 1.5rem;
    gap: 0.5rem;
  }
  .image-picker-modal {
    max-width: 720px;
  }
  .image-picker-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
    gap: 0.75rem;
    margin-top: 1rem;
    max-height: 420px;
    overflow: auto;
  }
  .image-picker-item {
    border: 1px solid #e5e7eb;
    background: white;
    padding: 0;
    border-radius: 6px;
    overflow: hidden;
    cursor: pointer;
  }
  :global(.image-picker-img) {
    width: 100%;
    height: 90px;
    object-fit: cover;
    display: block;
  }
  .image-picker-item:hover {
    border-color: #3b82f6;
    box-shadow: 0 0 0 1px #3b82f6;
  }
</style>
