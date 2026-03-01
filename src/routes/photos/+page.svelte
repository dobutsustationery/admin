<!-- Add Imports -->
<script context="module" lang="ts">
  import {
    schedule_edit_batch,
    begin_edit,
    complete_edit,
    fail_edit,
    toggle_edit_status,
    set_processing_config,
  } from "$lib/photos-slice";
  import {
    uploadImageToDrive,
    ensureFolderStructure,
    generateDerivationKey,
    calculateHash,
    extractDriveFileId,
    MERGE_WITH_PROPERTY,
    setFileProperty,
  } from "$lib/google-drive";
</script>

<script lang="ts">
  // ... existing imports ...
  import { onMount, onDestroy } from "svelte";
  import {
    createPickerSession,
    pollPickerSession,
    listSessionMediaItems,
    listAlbumMediaItems,
    getStoredToken,
    initiateOAuthFlow,
    handleOAuthCallback,
    isAuthenticated as checkAuth,
  } from "$lib/google-photos";
  import type { MediaItem } from "$lib/google-photos";
  import type {
    ProcessingConfig,
    ProcessingStep,
    ProcessingStepType,
  } from "$lib/photos-slice";
  import {
    listAllImages,
    findSingleImage,
    listRecentImages,
    getStoredToken as getDriveStoredToken,
    type DriveFile,
    findFileByDerivationKey,
  } from "$lib/google-drive";
  import { toGoogleDrivePublicImageUrl } from "$lib/drive-url";
  import SecureImage from "$lib/components/SecureImage.svelte";
  import ProcessingConfigModal from "$lib/components/ProcessingConfigModal.svelte";
  import { store } from "$lib/store";
  import { broadcast } from "$lib/redux-firestore";
  import { auth, firestore } from "$lib/firebase";
  import {
    addDoc,
    collection,
    query,
    where,
    limit,
    onSnapshot,
    serverTimestamp,
  } from "firebase/firestore";
  import { user } from "$lib/user-store";
  import { signOut } from "firebase/auth";
  import {
    SYNC_COLLECTION,
    PHOTOS_IMAGE_TRANSFORM_REQUEST_EVENT,
  } from "$lib/sync-events";

  // Local Auth State for UI
  let isPhotosAuthenticated = false;
  let connectedEmail: string | undefined = undefined;

  function checkAuthStatus() {
    const token = getStoredToken();
    isPhotosAuthenticated = !!token;
    connectedEmail = token?.user_email;
    return isPhotosAuthenticated;
  }

  function isAuthenticated() {
    return isPhotosAuthenticated;
  } // Helper for template

  function isDirectRenderableUrl(url: string): boolean {
    return (
      url.startsWith("data:") ||
      url.includes("drive.google.com") ||
      url.includes("googleapis.com") ||
      url.includes("googleusercontent.com")
    );
  }

  function displayUrl(url: string, suffix: string): string {
    return isDirectRenderableUrl(url) ? url : `${url}${suffix}`;
  }

  import type { PhotoEditQueue } from "$lib/photos-slice";

  // State from Redux Store
  $: photos = $store.photos.selected as MediaItem[];
  $: uploads = $store.photos.uploads || {};
  $: janCodeToPhotos = ($store.photos.janCodeToPhotos || {}) as Record<
    string,
    MediaItem[]
  >;
  $: edits = ($store.photos.edits || {}) as Record<string, PhotoEditQueue>;
  $: registry = ($store.photos.registry || {}) as Record<string, MediaItem>;
  $: isGenerating = $store.photos.generating;
  $: isCategorizing = $store.photos.categorizing;

  function isEphemeral(url: string) {
    return (
      !!url &&
      url.includes("googleusercontent.com") &&
      !url.includes("lh3.googleusercontent.com/d/")
    );
  }

  function cleanMediaItem(item: MediaItem): MediaItem {
    return {
      id: item.id,
      baseUrl: item.baseUrl,
      productUrl: item.productUrl,
      mimeType: item.mimeType,
      filename: item.filename,
      description: item.description,
      mediaMetadata: {
        creationTime: item.mediaMetadata.creationTime,
        width: item.mediaMetadata.width,
        height: item.mediaMetadata.height,
      },
    };
  }

  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import BatchProgressBanner from "$lib/components/BatchProgressBanner.svelte";
  import CategorizationProgressBanner from "$lib/components/CategorizationProgressBanner.svelte";
  import { activeBanners } from "$lib/banner-store";
  import ProgressBar from "$lib/components/ProgressBar.svelte";
  import {
    begin_categorize,
    end_categorize,
    merge_jan_groups,
    rename_jan_group,
    set_generating,
    select_photos,
    add_selected_photos,
    register_media_items,
  } from "$lib/photos-slice";

  import { categorizeMediaItems } from "$lib/gemini-client";
  let catProgress = { current: 0, total: 0, message: "" };

  async function handleCategorize(force = false) {
    if (photos.length === 0) return;

    // Broadcast begin (Sets flag)
    if ($user.uid) {
      broadcast(firestore, $user.uid, { type: "photos/begin_categorize" });
    }

    catProgress = { current: 0, total: photos.length, message: "Starting..." };

    try {
      const token = getStoredToken();
      if (!token) throw new Error("Not authenticated");
      const apiKey = import.meta.env.VITE_GOOGLE_API_KEY; // Optional

      // Pass a copy of photos to avoid mutation race conditions if UI updates
      const itemsToProcess = photos.map((p) => ({
        baseUrl: p.baseUrl,
        id: p.id,
      }));

      await categorizeMediaItems(
        itemsToProcess,
        token.access_token,
        apiKey,
        (item, janCode) => {
          // On Match -> Broadcast Action to move item
          if ($user.uid) {
            // We need the full MediaItem. Find it in current state (or known uploads)
            const fullItem = photos.find((p) => p.id === item.id) || {
              ...item,
            }; // Fallback

            broadcast(firestore, $user.uid, {
              type: "photos/categorize_photo",
              payload: { janCode, photo: fullItem },
            });
          }
        },
        (current, total, message) => {
          catProgress = { current, total, message };
        },
        force,
      );
    } catch (e: any) {
      checkAuthError(e);
      console.error("Categorize Error:", e);
      error = e.message;
    } finally {
      if ($user.uid) {
        broadcast(firestore, $user.uid, { type: "photos/end_categorize" });
        store.dispatch(end_categorize()); // Also dispatch locally to be sure
      }
    }
  }

  // --- EDIT QUEUE RUNNER ---
  let isEditing = false;
  let showConfigModal = false;
  let batchProgress = {
    current: 0,
    total: 0,
    operation: "",
    completedIds: [] as string[],
  };

  $: {
    if (isEditing && batchProgress.total > 0) {
      activeBanners.register({
        id: "batch-edit-progress",
        component: BatchProgressBanner,
        props: {
          batchProgress,
          registry,
          photos,
          janCodeToPhotos,
        },
        priority: 10,
      });
    } else {
      activeBanners.unregister("batch-edit-progress");
    }

    if (isCategorizing) {
      activeBanners.register({
        id: "categorize-progress",
        component: CategorizationProgressBanner,
        props: { progress: catProgress },
        priority: 15,
      });
    } else {
      activeBanners.unregister("categorize-progress");
    }
  }

  // Cleanup on destroy
  onDestroy(() => {
    activeBanners.unregister("batch-edit-progress");
    activeBanners.unregister("categorize-progress");
  });
  // In-flight request tracking to avoid redundant sync requests
  const inFlightEdits = new Set<string>();

  // Reactive list of pending items for UI progress display
  $: pendingEdits = Object.entries(edits).filter(
    ([id, q]) => q.queue.length > 0 && !q.active,
  );

  // Reactive pipeline steps with fallback for safety (hydration)
  $: pipelineSteps = ($store.photos.processingConfig?.steps || [])
    .filter((s: any) => s.enabled)
    .map((s: any) => s.type);

  async function dispatchTransformRequest(id: string, operation: string) {
    const transform =
      operation === "remove_background" ? "remove_bg" : operation;
    const requestId = `photo-edit-${transform}-${id}`;

    if (inFlightEdits.has(requestId)) return null;

    try {
      const token = getStoredToken();
      if (!token) throw new Error("Not authenticated");

      // 1. Get Item from Store State directly (reactive var 'photos' can be stale in loops)
      const state = store.getState().photos;
      let item = state.selected.find((p: any) => p.id === id);
      if (!item) {
        for (const code in state.janCodeToPhotos) {
          item = state.janCodeToPhotos[code].find((p: any) => p.id === id);
          if (item) break;
        }
      }
      if (!item) throw new Error("Photo not found in state");

      const driveId = extractDriveFileId(item.baseUrl);
      const sourceType = driveId
        ? "drive"
        : item.baseUrl?.includes("googleusercontent.com")
          ? "photos"
          : "ext";
      const sourceId = driveId || id;

      const derivationKey = generateDerivationKey(
        sourceType,
        sourceId,
        transform,
      );

      // 2. Idempotency Check: Search Before Work
      const existing = await findFileByDerivationKey(
        token.access_token,
        derivationKey,
      );

      if (existing) {
        console.info(
          `[EditQueue] Idempotent match found for ${derivationKey}: ${existing.id}`,
        );
        const finalUrl = existing.publicUrl || existing.apiUrl || "";

        const completeAction = complete_edit({
          id,
          operation: operation as any,
          permanentUrl: finalUrl,
        });

        if ($user.uid) {
          await broadcast(firestore, $user.uid, completeAction);
        } else {
          store.dispatch(completeAction);
        }
        return true; // Mark as successfully handled (idempotent)
      }

      // If we are here, we don't have a successful result in Drive for this derivation key.
      // If the current state thinks it IS done, it's a "lying" state (e.g. remembered a failure
      // or was partially synced). We should clear the status so the UI/logic knows it needs work.
      const currentStatus = edits[id]?.status;
      if (
        currentStatus &&
        currentStatus[operation as keyof typeof currentStatus]
      ) {
        console.info(
          `[EditQueue] Clearing stale 'done' status for ${id}:${operation} as no Drive file exists.`,
        );
        store.dispatch(toggle_edit_status({ id, operation: operation as any }));
      }

      // 3. Request Transform via Sync Queue
      console.info(
        `[EditQueue] Requesting transform for ${id} (${derivationKey})...`,
      );
      inFlightEdits.add(requestId);

      const driveToken = getDriveStoredToken() || getStoredToken();
      const folders = await ensureFolderStructure(driveToken!.access_token);

      const syncPayload: any = {
        photoId: id,
        sourceBaseUrl: item.baseUrl || "",
        filename: `edited_${operation}_${id}.png`,
        mimeType: "image/png",
        targetFolderId: folders.processedId,
        sourceType,
        transform,
        derivationKey,
        sourceRef: {
          mediaItemId: id,
          url: item.baseUrl || "",
          driveFileId: driveId,
        },
      };

      // We use addDoc because sync collection is append-only
      const docRef = await addDoc(collection(firestore, SYNC_COLLECTION), {
        eventType: PHOTOS_IMAGE_TRANSFORM_REQUEST_EVENT,
        requestId,
        creator: $user.uid,
        requestedBy: $user.uid,
        requestedAt: Date.now(),
        source: "edit-queue-runner",
        photoId: id,
        filename: `edited_${operation}_${id}.png`,
        mimeType: "image/png",
        payloadVersion: 1,
        payload: syncPayload,
        createdAtMs: Date.now(),
        createdAt: serverTimestamp(),
        timestamp: serverTimestamp(),
      });

      return docRef.id; // Return document ID for tracking if needed, or truthy for success
    } catch (e: any) {
      console.error(`Edit dispatch failed for ${id}:`, e);
      store.dispatch(
        fail_edit({ id, operation: operation as any, error: e.message }),
      );
      return null;
    }
  }

  const stepOperationLabels: Record<string, string> = {
    crop: "Auto-Cropping",
    color_correct: "Color Correcting",
    remove_background: "Removing Backgrounds",
  };

  async function handleProcessImages() {
    if (isEditing) return;
    isEditing = true;

    try {
      for (const step of pipelineSteps as ProcessingStepType[]) {
        const ids = scheduleBatch(step);
        if (ids.length === 0) continue;

        batchProgress = {
          current: 0,
          total: ids.length,
          operation: stepOperationLabels[step] || step,
          completedIds: [],
        };

        const idsToWait: string[] = [];

        // Dispatch with staggered delay
        for (const id of ids) {
          const result = await dispatchTransformRequest(id, step);
          if (result === true) {
            // Idempotent match - already done
            batchProgress.current++;
            batchProgress.completedIds = [...batchProgress.completedIds, id];
          } else if (result) {
            // New request dispatched
            idsToWait.push(id);
          } else {
            // Failed
            batchProgress.total--;
          }
          await new Promise((r) => setTimeout(r, 100));
        }

        if (idsToWait.length > 0) {
          console.log(
            `[Batch] Waiting for ${idsToWait.length} ${step} jobs...`,
          );
          await waitForBatchCompletion(idsToWait, step, (id) => {
            batchProgress.current++;
            batchProgress.completedIds = [...batchProgress.completedIds, id];
          });
        }
      }

      console.log("[Batch] All processing complete.");
    } catch (err: any) {
      console.error("[Batch] Image processing failed:", err);
      alert("Error during image processing: " + err.message);
    } finally {
      isEditing = false;
      batchProgress = { current: 0, total: 0, operation: "", completedIds: [] };
    }
  }

  async function waitForBatchCompletion(
    ids: string[],
    operation: string,
    onItemComplete: (id: string) => void,
  ) {
    const promises = ids.map((id) => {
      return new Promise<void>((resolve) => {
        const transform =
          operation === "remove_background" ? "remove_bg" : operation;

        const requestId = `photo-edit-${transform}-${id}`;

        const q = query(
          collection(firestore, SYNC_COLLECTION),
          where("requestId", "==", requestId),
          where("eventType", "in", [
            "photos/image_transform_completed",
            "photos/image_transfer_completed",
            "photos/image_transfer_failed",
            "photos/image_transform_failed",
          ]),
          limit(1),
        );

        const unsubscribe = onSnapshot(
          q,
          (snap) => {
            if (snap.empty) return;
            const data = snap.docs[0].data();

            if (data.eventType.endsWith("completed")) {
              const payload = data.payload || {};
              const finalUrl = payload.permanentUrl || payload.apiUrl || null;
              if (finalUrl) {
                // The worker already broadcasted the completion event via idempotent broadcast action.
                // We just need to update our internal list of completed items for the progress UI.
                onItemComplete(id);
              }
              unsubscribe();
              inFlightEdits.delete(requestId);
              resolve();
            } else if (data.eventType.endsWith("failed")) {
              console.error(
                `[Batch] Transform failed for ${id}:`,
                data.payload?.errorMessage,
              );
              unsubscribe();
              inFlightEdits.delete(requestId);
              resolve();
            }
          },
          (err) => {
            console.error(`[Batch] Error polling ${requestId}:`, err);
            unsubscribe();
            inFlightEdits.delete(requestId);
            resolve();
          },
        );

        // Safety timeout
        setTimeout(() => {
          unsubscribe();
          inFlightEdits.delete(requestId);
          resolve();
        }, 300000); // 5 minutes for batch items
      });
    });

    await Promise.all(promises);
  }

  function scheduleBatch(op: "crop" | "color_correct" | "remove_background") {
    // Schedule for CATEGORIZED photos only (as per user request)
    const allIds = new Set<string>();
    Object.values(janCodeToPhotos)
      .flat()
      .forEach((p) => {
        const q = edits[p.id];
        const status = q?.status;
        const isDone = status && status[op];

        // We skip ONLY if it is truly done (successful idempotent result exists or was just completed).
        // If it was previously failed, it won't be 'done' in status, so it will be included.
        if (!isDone) {
          allIds.add(p.id);
        }
      });

    const ids = Array.from(allIds);
    if (ids.length === 0) return [];

    const action = schedule_edit_batch({ ids, operation: op });

    if ($user.uid) {
      console.log(
        `[Batch] Broadcasting schedule batch ${op} for ${ids.length} items.`,
      );
      broadcast(firestore, $user.uid, action);
    } else {
      store.dispatch(action);
    }

    return ids;
  }

  // State
  let error = "";
  let isPolling = false;
  let loading = false;
  let pollInterval: ReturnType<typeof setInterval>;
  let staleFlagInterval: ReturnType<typeof setInterval> | null = null;
  let pollAttempts = 0;

  const MAX_POLL_ATTEMPTS = 60; // 2 minutes (approx)
  let pickerWindow: Window | null = null;
  // ... existing checkAuthError etc ...
  // LIFECYCLE
  onMount(async () => {
    console.log("Photos Page Mounted. Checking Auth...");

    // Handle OAuth Callback (hash parsing)
    const tokenCaptured = await handleOAuthCallback();
    if (tokenCaptured) {
      console.log(
        "OAuth Callback processed successfully. Token stored.",
        tokenCaptured,
      );
    } else {
      console.log("No OAuth callback detected (or failed).");
    }

    // Check Photos Auth
    checkAuthStatus();
    console.log(
      "Final Auth Status:",
      isPhotosAuthenticated,
      "Email:",
      connectedEmail,
    );

    // Trigger re-render explicit
    isPhotosAuthenticated = isPhotosAuthenticated;

    // Safety: Reset categorization state if it was stuck from a previous session/reload
    if ($store.photos.categorizing) {
      console.log("Resetting stuck 'categorizing' state on mount.");
      store.dispatch(end_categorize());
    }
    if ($store.photos.generating) {
      console.log("Resetting stuck 'generating' state on mount.");
      store.dispatch(set_generating(false));
    }

    staleFlagInterval = setInterval(() => {
      if ($store.photos.categorizing && catProgress.total === 0) {
        console.log("Resetting stale 'categorizing' state.");
        store.dispatch(end_categorize());
      }
    }, 1000);

    (window as any).__E2E_IMPORT_PHOTOS_FROM_ALBUM__ =
      importPhotosFromConfiguredAlbum;
    (window as any).__E2E_IMPORT_PHOTOS_FROM_DRIVE__ = importPhotosFromDrive;
  });

  onDestroy(() => {
    stopPolling();
    if (staleFlagInterval) {
      clearInterval(staleFlagInterval);
      staleFlagInterval = null;
    }
    if (
      typeof window !== "undefined" &&
      (window as any).__E2E_IMPORT_PHOTOS_FROM_ALBUM__
    ) {
      delete (window as any).__E2E_IMPORT_PHOTOS_FROM_ALBUM__;
    }
    if (
      typeof window !== "undefined" &&
      (window as any).__E2E_IMPORT_PHOTOS_FROM_DRIVE__
    ) {
      delete (window as any).__E2E_IMPORT_PHOTOS_FROM_DRIVE__;
    }
  });

  function checkAuthError(e: any): boolean {
    const msg = e.message || String(e);
    if (
      msg.includes("401") ||
      msg.includes("UNAUTHENTICATED") ||
      msg.includes("invalid authentication credentials")
    ) {
      console.warn("Caught authentication error, signing out user.");
      signOut(auth);
      return true;
    }
    return false;
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
    }
    isPolling = false;
    pollAttempts = 0;
  }

  let selectionMode: "replace" | "add" = "replace";

  async function handleSelectPhotos(mode: "replace" | "add" = "replace") {
    selectionMode = mode;
    error = "";
    loading = true;

    try {
      const session = await createPickerSession();
      // The picker URI needs to be opened in a way the user can interact.
      // We append /autoclose to let Google handle the window closing after selection.
      let uri = session.pickerUri;
      if (!uri.endsWith("/autoclose")) {
        uri = uri.endsWith("/") ? `${uri}autoclose` : `${uri}/autoclose`;
      }
      pickerWindow = window.open(uri, "_blank", "width=800,height=600");

      startPolling(session.id);
    } catch (e: any) {
      checkAuthError(e);
      error = e.message;
      loading = false;
    }
  }

  function startPolling(sessionId: string) {
    stopPolling();
    isPolling = true;
    loading = true; // Still loading from user perspective until photos appear

    // Poll every 2 seconds
    pollInterval = setInterval(async () => {
      pollAttempts++;
      if (pollAttempts > MAX_POLL_ATTEMPTS) {
        stopPolling();
        error = "Selection timed out. Please try again.";
        loading = false;
        return;
      }

      try {
        const session = await pollPickerSession(sessionId);
        if (session.mediaItemsSet) {
          // User finished selection
          if (pickerWindow) {
            // Try to close
            pickerWindow.close();
            // Focus parent window to bring it forward if closure fails
            window.focus();
            pickerWindow = null;
          }
          stopPolling();
          await loadSelectedPhotos(sessionId);
        }
      } catch (e: any) {
        checkAuthError(e);
        console.error("Polling error:", e);
      }
    }, 2000);
  }

  // ... imports ...

  async function loadSelectedPhotos(sessionId: string) {
    try {
      const newItems = await listSessionMediaItems(sessionId);

      // Sort New Items
      newItems.sort((a, b) => {
        const tA = new Date(a.mediaMetadata?.creationTime || 0).getTime();
        const tB = new Date(b.mediaMetadata?.creationTime || 0).getTime();
        return tA - tB;
      });

      if ($user.uid) {
        // 1. Register (Fact) - Filtered
        const itemsToRegister = newItems.filter((item) => {
          const existing = registry[item.id];
          if (!existing) return true;
          if (!isEphemeral(item.baseUrl)) return true;
          return isEphemeral(existing.baseUrl);
        });

        if (itemsToRegister.length > 0) {
          const cleanItems = itemsToRegister.map(cleanMediaItem);
          store.dispatch(register_media_items({ items: cleanItems }));
          broadcast(firestore, $user.uid, {
            type: "photos/register_media_items",
            payload: { items: cleanItems },
          });
        }

        // 2. Select (Intent)
        const ids = newItems.map((p) => p.id);
        if (selectionMode === "replace") {
          store.dispatch({
            type: "photos/select_photos",
            payload: { ids },
          });
          broadcast(firestore, $user.uid, {
            type: "photos/select_photos",
            payload: { ids },
          });
        } else {
          // ADD Mode: Append Only
          store.dispatch({
            type: "photos/add_selected_photos",
            payload: { ids },
          });
          broadcast(firestore, $user.uid, {
            type: "photos/add_selected_photos",
            payload: { ids },
          });
        }
      }
    } catch (e: any) {
      checkAuthError(e);
      error = "Failed to load photos: " + e.message;
    } finally {
      loading = false;
    }
  }

  async function importPhotosFromConfiguredAlbum(
    mode: "replace" | "add" = "replace",
    maxItems = 24,
    preferredPhoto: string | null = null,
  ) {
    const albumId = (window as any).__GOOGLE_PHOTOS_ALBUM_ID__;
    if (!albumId) {
      throw new Error("No configured Google Photos album ID for import.");
    }

    selectionMode = mode;
    const albumItems = await listAlbumMediaItems(albumId);
    if (albumItems.length === 0) {
      throw new Error(
        `Configured Google Photos album has no API-visible media items (albumId=${albumId}).`,
      );
    }
    const processableItems = albumItems.filter((item) => {
      const mime = (item.mimeType || "").toLowerCase();
      const filename = (item.filename || "").toLowerCase();
      const extension = filename.includes(".")
        ? filename.split(".").pop() || ""
        : "";
      const mimeProcessable =
        mime === "image/jpeg" || mime === "image/jpg" || mime === "image/png";
      const extensionProcessable =
        extension === "jpg" || extension === "jpeg" || extension === "png";
      return mimeProcessable || extensionProcessable;
    });
    const sourceItems =
      processableItems.length > 0 ? processableItems : albumItems;
    const cappedCount = Math.max(1, maxItems);
    let orderedSourceItems = sourceItems;
    if (preferredPhoto) {
      const preferredIndex = sourceItems.findIndex(
        (item) =>
          item.id === preferredPhoto || item.filename === preferredPhoto,
      );
      if (preferredIndex < 0) {
        throw new Error(
          `Preferred photo "${preferredPhoto}" not found in configured album.`,
        );
      }
      const preferredItem = sourceItems[preferredIndex];
      orderedSourceItems = [
        preferredItem,
        ...sourceItems.filter((item) => item.id !== preferredItem.id),
      ];
    }
    const limitedItems = orderedSourceItems.slice(0, cappedCount);

    // Sort limitedItems
    limitedItems.sort((a, b) => {
      const tA = new Date(a.mediaMetadata?.creationTime || 0).getTime();
      const tB = new Date(b.mediaMetadata?.creationTime || 0).getTime();
      return tA - tB;
    });

    if (!$user.uid) {
      throw new Error("No signed-in user to broadcast selected photos.");
    }
    const userUid = $user.uid;

    // 1. Register (Filtered)
    const itemsToRegister = limitedItems.filter((item) => {
      const existing = registry[item.id];
      if (!existing) return true;
      if (!isEphemeral(item.baseUrl)) return true;
      return isEphemeral(existing.baseUrl);
    });

    if (itemsToRegister.length > 0) {
      const cleanItems = itemsToRegister.map(cleanMediaItem);
      await broadcast(firestore, $user.uid, {
        type: "photos/register_media_items",
        payload: { items: cleanItems },
      });
      store.dispatch(register_media_items({ items: cleanItems }));
    }

    // 2. Select
    const ids = limitedItems.map((p) => p.id);
    if (selectionMode === "replace") {
      await broadcast(firestore, $user.uid, {
        type: "photos/select_photos",
        payload: { ids },
      });
      store.dispatch({
        type: "photos/select_photos",
        payload: { ids },
      });
    } else {
      await broadcast(firestore, $user.uid, {
        type: "photos/add_selected_photos",
        payload: { ids },
      });
      store.dispatch({
        type: "photos/add_selected_photos",
        payload: { ids },
      });
    }

    return {
      importedItems: limitedItems.map((item) => ({
        id: item.id,
        filename: item.filename,
        mimeType: item.mimeType,
      })),
    };
  }

  async function importPhotosFromDrive(
    mode: "replace" | "add" = "replace",
    maxItems = 24,
    preferredPhoto: string | null = null,
  ) {
    const driveToken = getDriveStoredToken();
    if (!driveToken) {
      throw new Error("No Google Drive token available for import.");
    }

    const toMediaItem = (item: DriveFile) =>
      ({
        id: item.id,
        description: "",
        productUrl: item.webViewLink || "",
        baseUrl: item.publicUrl || "",
        mimeType: item.mimeType || "image/jpeg",
        filename: item.name || item.id,
        mediaMetadata: {
          creationTime: item.modifiedTime || "",
          width: "0",
          height: "0",
        },
      }) as MediaItem;

    const looksLikeDriveFileId = (value: string) =>
      /^[A-Za-z0-9_-]{20,}$/.test(value.trim());

    let sourceItems: MediaItem[] = [];
    if (
      preferredPhoto &&
      maxItems === 1 &&
      looksLikeDriveFileId(preferredPhoto)
    ) {
      sourceItems = [
        {
          id: preferredPhoto,
          description: "",
          productUrl: "",
          baseUrl: toGoogleDrivePublicImageUrl(preferredPhoto),
          mimeType: "image/jpeg",
          filename: preferredPhoto,
          mediaMetadata: {
            creationTime: "",
            width: "0",
            height: "0",
          },
        } as MediaItem,
      ];
    }

    if (preferredPhoto && sourceItems.length === 0) {
      const preferredDriveImage = await findSingleImage(
        driveToken.access_token,
        preferredPhoto,
      );
      if (
        preferredDriveImage?.publicUrl?.includes("lh3.googleusercontent.com/d/")
      ) {
        sourceItems = [toMediaItem(preferredDriveImage)];
      }
    }

    if (sourceItems.length === 0 || maxItems > 1) {
      const driveItems =
        maxItems <= 4
          ? await listRecentImages(
              driveToken.access_token,
              Math.max(8, maxItems * 4),
            )
          : await listAllImages(driveToken.access_token);
      sourceItems = driveItems
        .filter(
          (item) =>
            item.mimeType?.startsWith("image/") &&
            typeof item.publicUrl === "string" &&
            item.publicUrl.includes("lh3.googleusercontent.com/d/"),
        )
        .map(toMediaItem);
    }

    let orderedItems = sourceItems;
    if (preferredPhoto) {
      const preferredIndex = sourceItems.findIndex(
        (item) =>
          item.id === preferredPhoto || item.filename === preferredPhoto,
      );
      if (preferredIndex < 0) {
        throw new Error(
          `Preferred photo "${preferredPhoto}" not found in Drive fixtures.`,
        );
      }
      const preferredItem = sourceItems[preferredIndex];
      orderedItems = [
        preferredItem,
        ...sourceItems.filter((item) => item.id !== preferredItem.id),
      ];
    }
    const limitedItems = orderedItems.slice(0, Math.max(1, maxItems));

    if (!$user.uid) {
      throw new Error("No signed-in user to broadcast selected photos.");
    }
    const userUid = $user.uid;

    const broadcastBestEffort = (
      action:
        | {
            type: "photos/register_media_items";
            payload: { items: MediaItem[] };
          }
        | { type: "photos/select_photos"; payload: { ids: string[] } }
        | { type: "photos/add_selected_photos"; payload: { ids: string[] } },
    ) => {
      broadcast(firestore, userUid, action).catch((error) => {
        console.warn("[e2e-drive-import] broadcast failed", error);
      });
    };

    // 1. Register (Filtered)
    const itemsToRegister = limitedItems.filter((item) => {
      const existing = registry[item.id];
      if (!existing) return true;
      if (!isEphemeral(item.baseUrl)) return true;
      return isEphemeral(existing.baseUrl);
    });

    if (itemsToRegister.length > 0) {
      const cleanItems = itemsToRegister.map(cleanMediaItem);
      store.dispatch(register_media_items({ items: cleanItems }));
      broadcastBestEffort({
        type: "photos/register_media_items",
        payload: { items: cleanItems },
      });
    }

    // 2. Select
    const ids = limitedItems.map((p) => p.id);
    if (mode === "replace") {
      store.dispatch({
        type: "photos/select_photos",
        payload: { ids },
      });
      broadcastBestEffort({
        type: "photos/select_photos",
        payload: { ids },
      });
    } else {
      store.dispatch({
        type: "photos/add_selected_photos",
        payload: { ids },
      });
      broadcastBestEffort({
        type: "photos/add_selected_photos",
        payload: { ids },
      });
    }

    return {
      importedItems: limitedItems.map((item) => ({
        id: item.id,
        filename: item.filename,
        mimeType: item.mimeType,
      })),
    };
  }

  function handleClearPhotos() {
    if (confirm("Remove all selected photos?")) {
      // Clear via broadcast
      if ($user.uid) {
        store.dispatch({
          type: "photos/select_photos",
          payload: { ids: [] },
        });
        broadcast(firestore, $user.uid, {
          type: "photos/select_photos",
          payload: { ids: [] },
        });
      }
    }
  }

  // Merge Logic
  import { fade } from "svelte/transition";
  import { goto } from "$app/navigation";

  let hoveredRowIndex: number | null = null;
  let hoveredColumn: "jan" | "photos" | null = null;
  let showCompleted = false;

  // Compute Listed JANs
  $: listedJans = (() => {
    const listed = new Set<string>();
    const idToHandle = $store.listings.idToHandle || {};
    const idToItem = $store.inventory.idToItem || {};
    const handleToListing = $store.listings.handleToListing || {};

    // Iterate all items in inventory
    for (const itemId in idToItem) {
      const item = idToItem[itemId];
      // Check if this item is linked to a listing
      const handle = idToHandle[itemId];
      const listing = handle ? handleToListing[handle] : null;

      if (item && item.janCode && listing) {
        // Only consider "Listed" if it has a bodyHtml (implying description generated/listing created)
        if (listing.bodyHtml) {
          // Add base JAN
          listed.add(item.janCode);
          // Add subtype-specific key if applicable
          if (item.subtype) {
            listed.add(`${item.janCode}:${item.subtype}`);
          }
        }
      }
    }
    return listed;
  })();

  $: categorizedEntries = (
    Object.entries(janCodeToPhotos) as [string, MediaItem[]][]
  ).filter(([jan, _]) => showCompleted || !listedJans.has(jan));

  // JAN Validation (EAN-13 Checksum)
  function isValidJan(code: string): boolean {
    // Split to handle subtype suffix (e.g. "4542804104370:Blue")
    const baseJan = code.split(":")[0];

    if (!/^\d{13}$/.test(baseJan)) return false; // Must be 13 digits for standard JAN

    const digits = baseJan.split("").map(Number);
    const checksum = digits.pop()!;

    const sum = digits.reduce((acc, curr, idx) => {
      // Even index (0, 2...) -> Odd Position (1st, 3rd...) -> x1
      // Odd index (1, 3...) -> Even Position (2nd, 4th...) -> x3
      const weight = idx % 2 === 0 ? 1 : 3;
      return acc + curr * weight;
    }, 0);

    const calcChecksum = (10 - (sum % 10)) % 10;
    return calcChecksum === checksum;
  }

  function handleJanRename(oldJan: string, newJan: string) {
    newJan = newJan.trim();
    if (newJan === oldJan) return; // Allow empty!

    if ($user.uid) {
      broadcast(firestore, $user.uid, {
        type: "photos/rename_jan_group",
        payload: { oldJan, newJan },
      });
    }
    store.dispatch(rename_jan_group({ oldJan, newJan }));

    // Persist to Metadata if possible
    if (newJan) {
      const photosToUpdate = janCodeToPhotos[oldJan] || [];
      const token = getStoredToken() || getDriveStoredToken();
      if (token) {
        photosToUpdate.forEach((p) => {
          const driveId = extractDriveFileId(p.baseUrl);
          if (driveId) {
            setFileProperty(
              driveId,
              MERGE_WITH_PROPERTY,
              newJan,
              token.access_token,
            );
          }
        });
      }
    }
  }

  function handleInputKey(e: KeyboardEvent, oldJan: string) {
    if (e.key === "Enter") {
      (e.target as HTMLInputElement).blur();
    }
  }

  function handleMergeUp(index: number) {
    if (index <= 0) return;

    const [sourceJan] = categorizedEntries[index];
    const [targetJan] = categorizedEntries[index - 1];

    if ($user.uid) {
      broadcast(firestore, $user.uid, {
        type: "photos/merge_jan_groups",
        payload: { sourceJan, targetJan },
      });
    }
    // Optimistic
    store.dispatch(merge_jan_groups({ sourceJan, targetJan }));

    // Persist to Metadata
    const photosToUpdate = janCodeToPhotos[sourceJan] || [];
    const token = getStoredToken() || getDriveStoredToken();
    if (token) {
      photosToUpdate.forEach((p) => {
        const driveId = extractDriveFileId(p.baseUrl);
        if (driveId) {
          setFileProperty(
            driveId,
            MERGE_WITH_PROPERTY,
            targetJan,
            token.access_token,
          );
        }
      });
    }

    hoveredRowIndex = null;
  }

  function handleSaveConfig(e: CustomEvent<ProcessingConfig>) {
    const action = set_processing_config(e.detail);
    if ($user.uid) {
      broadcast(firestore, $user.uid, action);
    } else {
      store.dispatch(action);
    }
  }
</script>

<ProcessingConfigModal
  bind:open={showConfigModal}
  config={$store.photos.processingConfig}
  on:save={handleSaveConfig}
/>

<div class="page-container">
  <div class="header-section">
    <div>
      <h1 class="page-title">Google Photos Import</h1>
      <div class="auth-status-row">
        <!-- Status Indicator -->
        {#if isPhotosAuthenticated}
          <span class="status-badge connected" title={connectedEmail}>
            <span class="status-dot green"></span>
            Connected {connectedEmail ? `as ${connectedEmail}` : ""}
          </span>
        {:else}
          <span class="status-badge disconnected">
            <span class="status-dot gray"></span>
            Not Connected
          </span>
        {/if}

        <!-- Switch Button -->
        <button
          on:click={() => initiateOAuthFlow(true)}
          class="btn-auth-action"
        >
          {isPhotosAuthenticated ? "Switch Account" : "Connect Account"}
        </button>
      </div>
    </div>
  </div>

  <!-- CONTENT AREA -->
  <div class="selection-area-card" data-testid="selection-area">
    {#if error}
      <div class="error-alert">
        {error}
      </div>
    {/if}

    {#if !isGenerating}
      <div class="selection-controls-card">
        <!-- Controls area inside card -->
        <div class="controls-toolbar">
          <div class="btn-group">
            <button
              on:click={handleClearPhotos}
              class="btn-clear"
              title="Remove all photos"
            >
              Clear
            </button>

            <button
              on:click={() => handleSelectPhotos("replace")}
              disabled={loading || isPolling}
              class="btn-action primary-green"
            >
              {#if isPolling && selectionMode === "replace"}
                <span class="spinner-small"></span>
                Waiting...
              {:else}
                Select Photos
              {/if}
            </button>

            <button
              on:click={() => handleSelectPhotos("add")}
              disabled={loading || isPolling}
              class="btn-action primary-blue"
            >
              {#if isPolling && selectionMode === "add"}
                <span class="spinner-small"></span>
                Waiting...
              {:else}
                Add Photos
              {/if}
            </button>
          </div>

          <div class="btn-group">
            {#if photos.length > 0}
              <button
                on:click={() => handleCategorize(false)}
                disabled={isCategorizing || isGenerating}
                class="btn-action primary-teal"
                title="Categorize using metadata if available"
              >
                Categorize Photos
              </button>

              <button
                on:click={() => handleCategorize(true)}
                disabled={isCategorizing || isGenerating}
                class="btn-action secondary-outline"
                title="Force Gemini re-analysis for all photos"
              >
                Re-categorize
              </button>
            {/if}
          </div>
        </div>

        <!-- Thumbnails Row (Selected / Uncategorized) -->
        <div class="photo-thumbnails-row" data-testid="selected-queue">
          {#if photos.length > 0}
            <!-- EXISTING PHOTO LOOP -->
            {#each photos as photo (photo.id)}
              <div
                class="photo-card"
                role="button"
                tabindex="0"
                data-testid="photo-thumbnail-{photo.id}"
                data-upload-status={uploads[photo.id]?.status || "none"}
                data-photo-state={(!!uploads[photo.id] &&
                  uploads[photo.id].status === "uploading") ||
                (!uploads[photo.id] && isEphemeral(photo.baseUrl))
                  ? "uploading"
                  : "ready"}
                aria-label="View photo history"
                on:click={() => goto(`/photo-history?id=${photo.id}`)}
                on:keydown={(e) =>
                  e.key === "Enter" && goto(`/photo-history?id=${photo.id}`)}
              >
                <ImageThumbnail
                  src={photo.baseUrl}
                  alt={photo.filename}
                  width="100%"
                  height="100%"
                  isUploading={(!!uploads[photo.id] &&
                    uploads[photo.id].status === "uploading") ||
                    (!uploads[photo.id] && isEphemeral(photo.baseUrl))}
                />

                <!-- Edit Status Overlay -->
                {#if edits[photo.id]}
                  {@const q = edits[photo.id]}
                  {#if q.active}
                    <div class="edit-overlay active">
                      <div class="edit-status-content">
                        <span class="spinner-small white"></span>
                        <span class="edit-op-label"
                          >{q.active.operation.replace("_", " ")}</span
                        >
                      </div>
                    </div>
                  {:else if q.queue.length > 0}
                    <div class="edit-queue-badge">
                      {q.queue.length}
                    </div>
                  {/if}
                {/if}

                <!-- Upload Status Overlay -->
                {#if uploads[photo.id]}
                  {#if uploads[photo.id].status === "uploading"}
                    <div class="upload-overlay uploading">
                      <span class="spinner-small white large"></span>
                    </div>
                  {:else if uploads[photo.id].status === "failed"}
                    <div
                      class="upload-overlay failed"
                      title={uploads[photo.id].error}
                    >
                      <span class="error-icon">!</span>
                    </div>
                  {/if}
                {/if}
              </div>
            {/each}
          {:else if isPolling}
            <div class="empty-queue-msg">
              <p>Selection in progress...</p>
            </div>
          {:else if isCategorizing}
            <!-- While categorizing, list empties, so this might show temporarily. -->
            <div class="empty-queue-msg italic">Processing...</div>
          {:else}
            <div class="empty-queue-msg italic muted">
              No photos queued. Select or Add photos to begin.
            </div>
          {/if}
        </div>
      </div>

      <!-- CATEGORIZED RESULTS -->
      {#if Object.keys(janCodeToPhotos).length > 0}
        <div class="categorized-section-card" data-testid="categorized-section">
          <div class="section-header">
            <h2 class="section-title">Categorized Photos</h2>
            <div class="section-actions-row">
              <label class="toggle-completed-label">
                <input
                  type="checkbox"
                  bind:checked={showCompleted}
                  class="checkbox-input"
                />
                <span>Show completed groups</span>
              </label>

              <button
                on:click={() => (showConfigModal = true)}
                class="btn-config"
                title="Configure processing steps and order"
              >
                <span>⚙️</span>
              </button>

              <button
                on:click={handleProcessImages}
                disabled={isEditing}
                class="btn-action primary-indigo"
                title="Auto-process all categorized images using the configured pipeline"
              >
                {#if isEditing}
                  <span class="spinner-small"></span>
                {/if}
                <span>Process Images</span>
              </button>
              <button
                on:click={() => goto("/listings/create")}
                class="btn-action primary-green"
                title="Create listings from these photos"
              >
                <span>Create Listings →</span>
              </button>
            </div>
          </div>
          <div class="categorized-table-container">
            <!-- Header -->
            <div class="table-header-row">
              <div class="col-jan-header">JAN Code</div>
              <div class="col-photos-header">Photos</div>
            </div>

            {#each categorizedEntries as [jan, items], index}
              <div
                class="categorized-row-item group"
                class:related-highlight={hoveredRowIndex === index + 1 &&
                  hoveredColumn === "photos"}
                role="group"
                data-testid="group-{jan}"
                on:mouseleave={() => {
                  hoveredRowIndex = null;
                  hoveredColumn = null;
                }}
              >
                <!-- JAN Column -->
                <div
                  class="col-jan-cell"
                  class:invalid-jan={!isValidJan(jan)}
                  role="group"
                  on:mouseenter={() => {
                    hoveredRowIndex = index;
                    hoveredColumn = "jan";
                  }}
                >
                  <input
                    type="text"
                    value={jan}
                    class="editable-jan"
                    data-testid="jan-input-{jan}"
                    on:blur={(e) => handleJanRename(jan, e.currentTarget.value)}
                    on:keyup={(e) => handleInputKey(e, jan)}
                  />
                </div>

                <!-- Photos Column: The Merge Trigger Zone -->
                <div
                  class="col-photos-cell"
                  role="group"
                  on:mouseenter={() => {
                    hoveredRowIndex = index;
                    hoveredColumn = "photos";
                  }}
                >
                  <!-- Merge Trigger Button (Only if NOT the first row) -->
                  {#if hoveredRowIndex === index && hoveredColumn === "photos" && index > 0}
                    <button
                      class="btn-merge-up"
                      on:click|stopPropagation={() => handleMergeUp(index)}
                      title="Merge these photos into the previous group"
                      transition:fade={{ duration: 100 }}
                    >
                      <span>↑ Merge Up</span>
                    </button>
                  {/if}

                  <div class="categorized-photos-grid">
                    {#each items as item}
                      <div
                        class="photo-card small"
                        role="button"
                        tabindex="0"
                        data-testid="photo-thumbnail-{item.id}"
                        data-upload-status={uploads[item.id]?.status || "none"}
                        data-photo-state={(!!uploads[item.id] &&
                          uploads[item.id].status === "uploading") ||
                        (!uploads[item.id] && isEphemeral(item.baseUrl))
                          ? "uploading"
                          : "ready"}
                        aria-label="View photo history"
                        on:click={() => goto(`/photo-history?id=${item.id}`)}
                        on:keydown={(e) =>
                          e.key === "Enter" &&
                          goto(`/photo-history?id=${item.id}`)}
                      >
                        <ImageThumbnail
                          src={item.baseUrl}
                          alt={item.filename}
                          width="100%"
                          height="100%"
                          isUploading={!!uploads[item.id] &&
                            uploads[item.id].status === "uploading"}
                        />
                        <!-- Filename Overlay -->
                        <div class="filename-overlay">
                          {item.filename}
                        </div>

                        <!-- Status Icons -->
                        <div class="status-dots-container">
                          {#if edits[item.id]?.status?.crop}
                            <div
                              class="status-dot-mini green"
                              title="Cropped"
                            ></div>
                          {/if}
                          {#if edits[item.id]?.status?.color_correct}
                            <div
                              class="status-dot-mini indigo"
                              title="Color Corrected"
                            ></div>
                          {/if}
                          {#if edits[item.id]?.status?.remove_background}
                            <div
                              class="status-dot-mini pink"
                              title="BG Removed"
                            ></div>
                          {/if}
                        </div>

                        {#if uploads[item.id]}
                          {#if uploads[item.id].status === "uploading"}
                            <div class="upload-overlay-mini uploading">
                              <span class="spinner-mini"></span>
                            </div>
                          {:else if uploads[item.id].status === "failed"}
                            <div class="upload-overlay-mini failed">!</div>
                          {/if}
                        {/if}
                      </div>
                    {/each}
                  </div>
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {/if}
  </div>

  <!-- BATCH PROGRESS OVERLAY -->
</div>

<style>
  .page-container {
    padding: 2rem;
    max-width: 80rem;
    margin: 0 auto;
    position: relative;
  }
  .header-section {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
  }
  .page-title {
    font-size: 1.875rem;
    font-weight: 700;
    color: #1f2937;
    margin: 0;
  }
  .auth-status-row {
    margin-top: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.125rem 0.625rem;
    border-radius: 9999px;
    font-size: 0.875rem;
    font-weight: 500;
  }
  .status-badge.connected {
    background-color: #dcfce7;
    color: #166534;
  }
  .status-badge.disconnected {
    background-color: #f3f4f6;
    color: #1f2937;
  }
  .status-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 9999px;
  }
  .status-dot.green {
    background-color: #16a34a;
  }
  .status-dot.gray {
    background-color: #9ca3af;
  }
  .btn-auth-action {
    font-size: 0.875rem;
    color: #2563eb;
    background: none;
    border: none;
    cursor: pointer;
    font-weight: 500;
  }
  .btn-auth-action:hover {
    color: #1e40af;
    text-decoration: underline;
  }

  .selection-area-card {
    background-color: white;
    padding: 1.5rem;
    border-radius: 0.5rem;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    min-height: 400px;
  }
  .error-alert {
    padding: 1rem;
    background-color: #fef2f2;
    color: #b91c1c;
    border-radius: 0.375rem;
    margin-bottom: 1rem;
    margin-top: 1.5rem;
  }

  .selection-controls-card {
    background-color: #f8fafc;
    position: relative;
    margin-top: 2rem;
    padding: 0.5rem;
    border: 2px solid #e2e8f0;
    border-radius: 16px;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  }
  .controls-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1rem 0.5rem;
  }
  .btn-group {
    display: flex;
    gap: 0.5rem;
  }
  .btn-clear {
    background-color: #fee2e2;
    color: #b91c1c;
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    font-weight: 500;
    border: none;
    cursor: pointer;
    font-size: 0.875rem;
    margin-right: 0.5rem;
    transition: background-color 0.2s;
  }
  .btn-clear:hover {
    background-color: #fecaca;
  }
  .btn-action {
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    font-weight: 500;
    border: none;
    cursor: pointer;
    font-size: 0.875rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    transition: background-color 0.2s;
  }
  .btn-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .primary-green {
    background-color: #16a34a;
    color: white;
  }
  .primary-green:hover:not(:disabled) {
    background-color: #15803d;
  }
  .primary-blue {
    background-color: #2563eb;
    color: white;
  }
  .primary-blue:hover:not(:disabled) {
    background-color: #1d4ed8;
  }
  .primary-teal {
    background-color: #0d9488;
    color: white;
  }
  .primary-teal:hover:not(:disabled) {
    background-color: #0f766e;
  }
  .primary-indigo {
    background-color: #4f46e5;
    color: white;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  }
  .primary-indigo:hover:not(:disabled) {
    background-color: #4338ca;
  }
  .secondary-outline {
    background-color: #f9fafb;
    color: #374151;
    border: 1px solid #d1d5db;
  }
  .secondary-outline:hover:not(:disabled) {
    background-color: #f3f4f6;
  }

  .photo-thumbnails-row {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    margin-top: 0.5rem;
    margin-bottom: 1.5rem;
    padding: 1rem;
    min-height: 160px;
  }
  .photo-card {
    background-color: white;
    border-radius: 0.5rem;
    overflow: hidden;
    border: 1px solid #e5e7eb;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    position: relative;
    cursor: pointer;
    transition: all 0.2s;
    width: 148px;
    height: 148px;
    flex-shrink: 0;
  }
  .photo-card:hover {
    box-shadow: 0 0 0 2px #6366f1;
  }
  .photo-card.small {
    width: 80px;
    height: 80px;
  }

  .edit-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 20;
    backdrop-filter: blur(1px);
  }
  .edit-overlay.active {
    background-color: rgba(37, 99, 235, 0.4);
  }
  .edit-status-content {
    color: white;
    font-size: 0.75rem;
    font-weight: 700;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  }
  .edit-op-label {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 10px;
  }
  .edit-queue-badge {
    position: absolute;
    top: 0.25rem;
    right: 0.25rem;
    background-color: #facc15;
    color: #713f12;
    font-size: 10px;
    font-weight: 700;
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    z-index: 20;
    border: 1px solid #eab308;
  }

  .upload-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .upload-overlay.uploading {
    background-color: rgba(0, 0, 0, 0.3);
  }
  .upload-overlay.failed {
    background-color: rgba(239, 68, 68, 0.3);
  }
  .error-icon {
    color: white;
    font-weight: 700;
    font-size: 1.25rem;
  }

  .empty-queue-msg {
    width: 100%;
    text-align: center;
    padding: 2.5rem 0;
    color: #6b7280;
  }
  .empty-queue-msg.italic {
    font-style: italic;
  }
  .empty-queue-msg.muted {
    color: #9ca3af;
  }

  .categorized-section-card {
    background-color: white;
    padding: 1.5rem;
    border-radius: 0.5rem;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    margin-top: 2rem;
    border-top: 4px solid #14b8a6;
  }
  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }
  .section-title {
    font-size: 1.25rem;
    font-weight: 700;
    color: #1f2937;
    margin: 0;
  }
  .section-actions-row {
    display: flex;
    gap: 1rem;
    align-items: center;
  }
  .toggle-completed-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: #4b5563;
    background-color: #f9fafb;
    padding: 0.375rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #e5e7eb;
    cursor: pointer;
    transition: background-color 0.2s;
  }
  .toggle-completed-label:hover {
    background-color: #f3f4f6;
  }
  .checkbox-input {
    border-radius: 0.25rem;
    color: #0d9488;
  }
  .btn-config {
    background-color: #e2e8f0;
    color: #334155;
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    font-weight: 700;
    border: none;
    cursor: pointer;
    font-size: 0.875rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    transition: background-color 0.2s;
  }
  .btn-config:hover {
    background-color: #cbd5e1;
  }

  .categorized-table-container {
    border: 1px solid #d1d5db;
    border-radius: 0.5rem;
    overflow: hidden;
    background-color: white;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  }
  .table-header-row {
    display: flex;
    background-color: #e2e8f0;
    border-bottom: 2px solid #cbd5e1;
    color: #334155;
  }
  .col-jan-header {
    width: 200px;
    flex: none;
    padding: 1rem;
    font-weight: 700;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.875rem;
  }
  .col-photos-header {
    flex: 1;
    padding: 1rem;
    font-weight: 700;
    font-size: 0.875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .categorized-row-item {
    display: flex;
    border-bottom: 1px solid #e2e8f0;
    transition: background-color 0.1s;
    position: relative;
  }
  .categorized-row-item:hover {
    background-color: #eff6ff;
  }
  .categorized-row-item.related-highlight {
    background-color: #fef9c3 !important;
    border: 2px dashed #facc15 !important;
  }

  .col-jan-cell {
    width: 200px;
    flex: none;
    padding: 1rem;
    font-family: monospace;
    font-size: 1.125rem;
    font-weight: 500;
    color: #0f766e;
    word-break: break-all;
    background-color: rgba(249, 250, 251, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    border-right: 1px solid #e2e8f0;
    z-index: 10;
  }
  .col-jan-cell.invalid-jan {
    background-color: #fee2e2;
    color: #991b1b;
  }
  .col-photos-cell {
    flex: 1;
    padding: 1rem;
    min-width: 0;
    position: relative;
  }
  .btn-merge-up {
    position: absolute;
    top: -12px;
    right: 16px;
    background-color: #fef9c3;
    color: #854d0e;
    border: 1px solid #fde68a;
    border-radius: 9999px;
    padding: 0.25rem 0.75rem;
    font-size: 0.75rem;
    font-weight: 700;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    z-index: 50;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    cursor: pointer;
    transition: transform 0.2s;
  }
  .btn-merge-up:hover {
    background-color: #fef08a;
    transform: scale(1.05);
  }

  .categorized-photos-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    margin: 1.5rem 0;
    padding: 1rem;
  }
  .filename-overlay {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background-color: rgba(0, 0, 0, 0.6);
    color: white;
    font-size: 9px;
    padding: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0;
    transition: opacity 0.2s;
  }
  .photo-card:hover .filename-overlay {
    opacity: 1;
  }
  .status-dots-container {
    position: absolute;
    top: 0.25rem;
    right: 0.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .status-dot-mini {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 9999px;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    border: 1px solid white;
  }
  .status-dot-mini.green {
    background-color: #22c55e;
  }
  .status-dot-mini.indigo {
    background-color: #6366f1;
  }
  .status-dot-mini.pink {
    background-color: #ec4899;
  }

  .upload-overlay-mini {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .upload-overlay-mini.uploading {
    background-color: rgba(0, 0, 0, 0.3);
  }
  .upload-overlay-mini.failed {
    background-color: rgba(239, 68, 68, 0.3);
    color: white;
    font-weight: 700;
    font-size: 0.75rem;
  }

  .spinner-small {
    animation: spin 1s linear infinite;
    height: 0.75rem;
    width: 0.75rem;
    border: 2px solid #ffffff;
    border-top-color: transparent;
    border-radius: 9999px;
  }
  .spinner-small.white {
    border-color: white;
    border-top-color: transparent;
  }
  .spinner-small.large {
    height: 1.5rem;
    width: 1.5rem;
  }
  .spinner-mini {
    animation: spin 1s linear infinite;
    height: 1.25rem;
    width: 1.25rem;
    border: 2px solid white;
    border-top-color: transparent;
    border-radius: 9999px;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .editable-jan {
    width: 100%;
    text-align: center;
    background-color: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 2px 4px;
    outline: none;
    transition: all 0.2s;
  }
  .editable-jan:hover {
    background-color: white;
    border-color: #d1d5db;
  }
  .editable-jan:focus {
    background-color: white;
    border-color: #14b8a6;
    box-shadow: 0 0 0 1px #14b8a6;
  }
</style>
