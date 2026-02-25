<!-- Add Imports -->
<script context="module" lang="ts">
  import {
    schedule_edit_batch,
    begin_edit,
    complete_edit,
    fail_edit,
    toggle_edit_status,
  } from "$lib/photos-slice";
  import {
    uploadImageToDrive,
    ensureFolderStructure,
    generateDerivationKey,
    calculateHash,
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

  async function handleCategorize() {
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
  // In-flight request tracking to avoid redundant sync requests
  const inFlightEdits = new Set<string>();

  // Reactive list of pending items for UI progress display
  $: pendingEdits = Object.entries(edits).filter(
    ([id, q]) => q.queue.length > 0 && !q.active,
  );

  async function dispatchTransformRequest(id: string, operation: string) {
    const transform =
      operation === "remove_background" ? "remove_bg" : operation;
    const requestId = `photo-edit-${transform}-${id}`;

    if (inFlightEdits.has(requestId)) return null;

    try {
      const token = getStoredToken();
      if (!token) throw new Error("Not authenticated");

      // 1. Get Item
      let item = photos.find((p) => p.id === id);
      if (!item) {
        for (const code in janCodeToPhotos) {
          const found = janCodeToPhotos[code].find((p) => p.id === id);
          if (found) {
            item = found;
            break;
          }
        }
      }
      if (!item) throw new Error("Photo not found in state");

      const sourceType = item.baseUrl?.includes("googleusercontent.com")
        ? "photos"
        : "ext";
      const derivationKey = generateDerivationKey(sourceType, id, transform);

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
          operation,
          permanentUrl: finalUrl,
        });

        if ($user.uid) {
          await broadcast(firestore, $user.uid, completeAction);
        } else {
          store.dispatch(completeAction);
        }
        return "idempotent";
      }

      // 3. Request Transform via Sync Queue
      console.info(
        `[EditQueue] Requesting transform for ${id} (${derivationKey})...`,
      );
      inFlightEdits.add(requestId);

      const driveToken = getDriveStoredToken() || getStoredToken();
      const folders = await ensureFolderStructure(driveToken!.access_token);

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
        payload: {
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
          },
        },
        createdAtMs: Date.now(),
        createdAt: serverTimestamp(),
        timestamp: serverTimestamp(),
      });

      return docRef.id;
    } catch (e: any) {
      console.error(`Edit dispatch failed for ${id}:`, e);
      store.dispatch(
        fail_edit({ id, operation: operation as any, error: e.message }),
      );
      return null;
    }
  }

  async function handleProcessImages() {
    if (isEditing) return;
    isEditing = true;

    try {
      // 1. Color Correct ALL Categorized Photos
      const colorIds = scheduleBatch("color_correct");
      if (colorIds.length > 0) {
        console.log(
          `[Batch] Dispatching ${colorIds.length} color_correct jobs...`,
        );
        // Dispatch with staggered delay to avoid quota spikes
        for (const id of colorIds) {
          await dispatchTransformRequest(id, "color_correct");
          await new Promise((r) => setTimeout(r, 250));
        }

        console.log(
          `[Batch] Waiting for ${colorIds.length} color_correct jobs to complete...`,
        );
        await waitForBatchCompletion(colorIds, "color_correct");
      }

      // 2. Remove Background ALL Categorized Photos
      const bgIds = scheduleBatch("remove_background");
      if (bgIds.length > 0) {
        console.log(
          `[Batch] Dispatching ${bgIds.length} remove_background jobs...`,
        );
        for (const id of bgIds) {
          await dispatchTransformRequest(id, "remove_background");
          await new Promise((r) => setTimeout(r, 250));
        }

        console.log(
          `[Batch] Waiting for ${bgIds.length} remove_background jobs to complete...`,
        );
        await waitForBatchCompletion(bgIds, "remove_background");
      }

      console.log("[Batch] All processing complete.");
    } catch (err: any) {
      console.error("[Batch] Image processing failed:", err);
      alert("Error during image processing: " + err.message);
    } finally {
      isEditing = false;
    }
  }

  async function waitForBatchCompletion(ids: string[], operation: string) {
    const promises = ids.map((id) => {
      return new Promise<void>((resolve) => {
        const transform =
          operation === "remove_background" ? "remove_bg" : operation;
        const requestId = `photo-edit-${transform}-${id}`;

        // Poll for this specific job, filtering for NEW events (created after now - 1 minute)
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

            // Important: With addDoc and non-unique requestId, we might see old events.
            // But since the result is deterministic (same derivation key), any completed event is good.

            if (data.eventType.endsWith("completed")) {
              const payload = data.payload || {};
              const finalUrl = payload.permanentUrl || payload.apiUrl || null;
              if (finalUrl) {
                const completeAction = complete_edit({
                  id,
                  operation,
                  permanentUrl: finalUrl,
                });
                if ($user.uid) {
                  broadcast(firestore, $user.uid, completeAction);
                } else {
                  store.dispatch(completeAction);
                }
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
        }, 180000); // 3 minutes for batch
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
        const status = edits[p.id]?.status;
        const isDone = status && status[op];
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

    hoveredRowIndex = null;
  }
</script>

<div class="p-8 max-w-6xl mx-auto relative">
  <!-- BATCH PROGRESS OVERLAY -->
  {#if isEditing}
    {@const activeEntry = Object.entries(edits).find(([_, q]) => q.active)}
    {@const activeId = activeEntry ? activeEntry[0] : null}
    {@const activeOp = activeEntry ? activeEntry[1].active?.operation : null}

    <div class="batch-progress-overlay" transition:fade>
      <div class="overlay-content">
        <div class="status-indicator">
          <div class="relative">
            <span
              class="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"
            ></span>
            <span
              class="relative inline-flex rounded-full h-3 w-3 bg-indigo-500"
            ></span>
          </div>
          <div>
            <h3>Processing Images</h3>
            <p>{pendingEdits.length} task(s) remaining in queue</p>
          </div>
        </div>

        {#if activeId}
          {@const item =
            photos.find((p) => p.id === activeId) ||
            Object.values(janCodeToPhotos)
              .flat()
              .find((p) => p.id === activeId)}
          {#if item}
            <div class="active-item-card">
              <div class="thumbnail-wrapper">
                <SecureImage
                  src={displayUrl(item.baseUrl, "=w64-h64-c")}
                  className="w-full h-full object-cover"
                />
              </div>
              <div class="operation-details">
                <span class="op-label">Current Operation</span>
                <span class="op-value">{activeOp?.replace("_", " ")}</span>
              </div>
            </div>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
  <div class="flex justify-between items-center mb-8">
    <div>
      <h1 class="text-3xl font-bold text-gray-800">Google Photos Import</h1>
      <div class="mt-2 flex items-center gap-3">
        <!-- Status Indicator -->
        {#if isPhotosAuthenticated}
          <span
            class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-sm font-medium bg-green-100 text-green-800"
            title={connectedEmail}
          >
            <span class="w-2 h-2 rounded-full bg-green-600"></span>
            Connected {connectedEmail ? `as ${connectedEmail}` : ""}
          </span>
        {:else}
          <span
            class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-sm font-medium bg-gray-100 text-gray-800"
          >
            <span class="w-2 h-2 rounded-full bg-gray-400"></span>
            Not Connected
          </span>
        {/if}

        <!-- Switch Button -->
        <button
          on:click={() => initiateOAuthFlow(true)}
          class="text-sm text-blue-600 hover:text-blue-800 hover:underline font-medium"
        >
          {isPhotosAuthenticated ? "Switch Account" : "Connect Account"}
        </button>
      </div>
    </div>
  </div>

  <!-- CONTENT AREA -->
  <div
    class="bg-white p-6 rounded-lg shadow-md min-h-[400px]"
    data-testid="selection-area"
  >
    {#if error}
      <div class="p-4 bg-red-50 text-red-700 rounded mb-4 mt-6">
        {error}
      </div>
    {/if}

    {#if !isGenerating}
      <div
        class="bg-slate-50 relative mt-8"
        style="margin: 1em; padding: 0.5em; border: 2px solid #e2e8f0; border-radius: 16px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);"
      >
        <!-- Controls area inside card -->
        <div class="flex justify-between items-center px-4 pt-4 pb-2">
          <div class="flex gap-2">
            <button
              on:click={handleClearPhotos}
              class="bg-red-100 text-red-700 px-3 py-2 rounded-md font-medium hover:bg-red-200 transition text-sm mr-2"
              title="Remove all photos"
            >
              Clear
            </button>

            <button
              on:click={() => handleSelectPhotos("replace")}
              disabled={loading || isPolling}
              class="bg-green-600 text-white px-4 py-2 rounded-md font-medium hover:bg-green-700 transition disabled:opacity-50 flex items-center gap-2 text-sm"
            >
              {#if isPolling && selectionMode === "replace"}
                <span
                  class="animate-spin h-3 w-3 border-2 border-white border-t-transparent rounded-full"
                ></span>
                Waiting...
              {:else}
                Select Photos
              {/if}
            </button>

            <button
              on:click={() => handleSelectPhotos("add")}
              disabled={loading || isPolling}
              class="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 transition disabled:opacity-50 flex items-center gap-2 text-sm"
            >
              {#if isPolling && selectionMode === "add"}
                <span
                  class="animate-spin h-3 w-3 border-2 border-white border-t-transparent rounded-full"
                ></span>
                Waiting...
              {:else}
                Add Photos
              {/if}
            </button>
          </div>

          <div class="flex gap-2">
            {#if photos.length > 0}
              <button
                on:click={handleCategorize}
                disabled={isCategorizing || isGenerating}
                class="bg-teal-600 text-white px-4 py-2 rounded-md font-medium hover:bg-teal-700 transition disabled:opacity-50 flex items-center gap-2 text-sm"
              >
                Categorize Photos
              </button>
            {/if}
          </div>
        </div>

        <!-- Progress Bar for Categorization -->
        {#if isCategorizing}
          <ProgressBar
            current={catProgress.current}
            total={catProgress.total}
            message={`Categorizing... ${catProgress.message}`}
            colorClass="bg-teal-500"
          />
        {/if}

        <!-- Thumbnails Row (Selected / Uncategorized) -->
        <div
          class="flex flex-row flex-wrap gap-4 mt-2 mb-6 p-4 min-h-[160px]"
          data-testid="selected-queue"
          style="display: flex; flex-direction: row; flex-wrap: wrap;"
        >
          {#if photos.length > 0}
            <!-- EXISTING PHOTO LOOP -->
            {#each photos as photo (photo.id)}
              <div
                class="bg-white rounded-lg overflow-hidden border border-gray-200 shadow-sm relative group cursor-pointer hover:ring-2 hover:ring-indigo-500 transition-all"
                style="width: 148px; height: 148px; flex-shrink: 0;"
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
                    <div
                      class="absolute inset-0 bg-blue-600/40 flex items-center justify-center z-20 backdrop-blur-[1px]"
                    >
                      <div
                        class="text-white text-xs font-bold flex flex-col items-center drop-shadow-md"
                      >
                        <span
                          class="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full mb-1"
                        ></span>
                        <span class="uppercase tracking-wider text-[10px]"
                          >{q.active.operation.replace("_", " ")}</span
                        >
                      </div>
                    </div>
                  {:else if q.queue.length > 0}
                    <div
                      class="absolute top-1 right-1 bg-yellow-400 text-yellow-900 text-[10px] font-bold px-1.5 py-0.5 rounded shadow-sm z-20 border border-yellow-500"
                    >
                      {q.queue.length}
                    </div>
                  {/if}
                {/if}

                <!-- Upload Status Overlay -->
                {#if uploads[photo.id]}
                  {#if uploads[photo.id].status === "uploading"}
                    <div
                      class="absolute inset-0 bg-black/30 flex items-center justify-center"
                    >
                      <span
                        class="animate-spin h-6 w-6 border-2 border-white border-t-transparent rounded-full"
                      ></span>
                    </div>
                  {:else if uploads[photo.id].status === "failed"}
                    <div
                      class="absolute inset-0 bg-red-500/30 flex items-center justify-center"
                      title={uploads[photo.id].error}
                    >
                      <span class="text-white font-bold text-xl">!</span>
                    </div>
                  {/if}
                {/if}
              </div>
            {/each}
          {:else if isPolling}
            <div class="w-full text-center py-10 text-gray-500">
              <p>Selection in progress...</p>
            </div>
          {:else if isCategorizing}
            <!-- While categorizing, list empties, so this might show temporarily. -->
            <div class="w-full text-center py-10 text-gray-500 italic">
              Processing...
            </div>
          {:else}
            <div class="w-full text-center py-10 text-gray-400 italic">
              No photos queued. Select or Add photos to begin.
            </div>
          {/if}
        </div>
      </div>

      <!-- CATEGORIZED RESULTS -->
      {#if Object.keys(janCodeToPhotos).length > 0}
        <div
          class="bg-white p-6 rounded-lg shadow-md mt-8 border-t-4 border-teal-500"
          data-testid="categorized-section"
        >
          <div class="flex justify-between items-center mb-4">
            <h2 class="text-xl font-bold text-gray-800">Categorized Photos</h2>
            <div class="flex gap-4 items-center">
              <label
                class="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 px-3 py-1.5 rounded border border-gray-200 cursor-pointer hover:bg-gray-100 transition"
              >
                <input
                  type="checkbox"
                  bind:checked={showCompleted}
                  class="rounded text-teal-600 focus:ring-teal-500"
                />
                <span>Show completed groups</span>
              </label>

              <button
                on:click={handleProcessImages}
                disabled={isEditing}
                class="bg-indigo-600 text-white px-4 py-2 rounded-md font-bold hover:bg-indigo-700 transition disabled:opacity-50 text-sm flex items-center gap-2 shadow-sm"
                title="Auto-process all categorized images (Color Correct + Remove Background)"
              >
                {#if isEditing}
                  <span
                    class="animate-spin h-3 w-3 border-2 border-white border-t-transparent rounded-full"
                  ></span>
                {/if}
                <span>Process Images</span>
              </button>

              <button
                on:click={() => goto("/listings/create")}
                class="bg-green-600 text-white px-4 py-2 rounded-md font-bold hover:bg-green-700 transition text-sm flex items-center gap-2 shadow-sm"
                title="Create listings from these photos"
              >
                <span>Create Listings →</span>
              </button>
            </div>
          </div>
          <div
            class="border border-gray-300 rounded-lg overflow-hidden bg-white shadow-sm"
          >
            <!-- Header -->
            <div
              class="flex flex-row bg-slate-200 border-b-2 border-slate-300 text-slate-700"
              style="display: flex; flex-direction: row;"
            >
              <div
                class="w-48 flex-none p-4 font-bold text-center uppercase tracking-wide text-sm"
                style="width: 200px; flex: none;"
              >
                JAN Code
              </div>
              <div
                class="flex-1 p-4 font-bold text-sm uppercase tracking-wide"
                style="flex: 1;"
              >
                Photos
              </div>
            </div>

            {#each categorizedEntries as [jan, items], index}
              <!-- 
                        Highlight Logic:
                        - Current Row Hover: Handled by .categorized-row:hover (CSS)
                        - Previous Row (Highlight): IF `hoveredRowIndex` is `index + 1` (the row below this one), highlight THIS one.
                        - AND `hoveredColumn` must be 'photos' as requested.
                    -->
              <div
                class="flex flex-row categorized-row group"
                class:related-highlight={hoveredRowIndex === index + 1 &&
                  hoveredColumn === "photos"}
                style="display: flex; flex-direction: row relative;"
                role="group"
                data-testid="group-{jan}"
                on:mouseleave={() => {
                  hoveredRowIndex = null;
                  hoveredColumn = null;
                }}
              >
                <!-- JAN Column -->
                <div
                  class="w-48 flex-none p-4 font-mono text-lg font-medium text-teal-700 break-all bg-gray-50/50 group-hover:bg-transparent transition-colors z-10"
                  class:bg-red-100={!isValidJan(jan)}
                  class:text-red-800={!isValidJan(jan)}
                  style="width: 200px; flex: none; display: flex; align-items: center; justify-content: center; border-right: 1px solid #e2e8f0; {!isValidJan(
                    jan,
                  )
                    ? 'background-color: #fee2e2;'
                    : ''}"
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
                  class="flex-1 p-4 min-w-0 relative"
                  style="flex: 1; min-width: 0; position: relative;"
                  role="group"
                  on:mouseenter={() => {
                    hoveredRowIndex = index;
                    hoveredColumn = "photos";
                  }}
                >
                  <!-- Merge Trigger Button (Only if NOT the first row) -->
                  {#if hoveredRowIndex === index && hoveredColumn === "photos" && index > 0}
                    <button
                      class="absolute -top-3 right-4 bg-yellow-100 hover:bg-yellow-200 text-yellow-800 border border-yellow-300 rounded-full px-3 py-1 text-xs font-bold shadow-sm z-50 flex items-center gap-1 cursor-pointer transition-transform hover:scale-105"
                      style="position: absolute; top: -12px; right: 16px;"
                      on:click|stopPropagation={() => handleMergeUp(index)}
                      title="Merge these photos into the previous group"
                      transition:fade={{ duration: 100 }}
                    >
                      <span>↑ Merge Up</span>
                    </button>
                  {/if}

                  <div
                    class="flex flex-row flex-wrap gap-4 mt-6 mb-6 p-4"
                    style="display: flex; flex-direction: row; flex-wrap: wrap;"
                  >
                    {#each items as item}
                      <div
                        class="bg-white rounded-lg overflow-hidden border border-gray-200 shadow-sm relative group/item cursor-pointer hover:ring-2 hover:ring-indigo-500 transition-all"
                        style="width: 80px; height: 80px; flex-shrink: 0;"
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
                        <div
                          class="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[9px] p-0.5 truncate opacity-0 group-hover/item:opacity-100 transition-opacity"
                        >
                          {item.filename}
                        </div>

                        <!-- Status Icons -->
                        <div
                          class="absolute top-1 right-1 flex flex-col gap-0.5"
                        >
                          {#if edits[item.id]?.status?.crop}
                            <div
                              class="w-1.5 h-1.5 rounded-full bg-green-500 shadow-sm border border-white"
                              title="Cropped"
                            ></div>
                          {/if}
                          {#if edits[item.id]?.status?.color_correct}
                            <div
                              class="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-sm border border-white"
                              title="Color Corrected"
                            ></div>
                          {/if}
                          {#if edits[item.id]?.status?.remove_background}
                            <div
                              class="w-1.5 h-1.5 rounded-full bg-pink-500 shadow-sm border border-white"
                              title="BG Removed"
                            ></div>
                          {/if}
                        </div>

                        {#if uploads[item.id]}
                          {#if uploads[item.id].status === "uploading"}
                            <div
                              class="absolute inset-0 bg-black/30 flex items-center justify-center"
                            >
                              <span
                                class="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full"
                              ></span>
                            </div>
                          {:else if uploads[item.id].status === "failed"}
                            <div
                              class="absolute inset-0 bg-red-500/30 flex items-center justify-center font-bold text-white text-xs"
                            >
                              !
                            </div>
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
  .categorized-row {
    border-bottom: 1px solid #e2e8f0;
    transition: background-color 0.1s;
  }
  .categorized-row:hover {
    background-color: #eff6ff; /* blue-50 */
  }
  .related-highlight {
    background-color: #fef9c3 !important; /* yellow-100 */
    border: 2px dashed #facc15 !important; /* yellow-400 */
  }

  .editable-jan {
    width: 100%;
    text-align: center;
    background-color: transparent;
    border: 1px solid transparent; /* Reserve space for border */
    border-radius: 4px;
    padding: 2px 4px;
    outline: none;
    transition: all 0.2s;
  }
  .editable-jan:hover {
    background-color: white;
    border-color: #d1d5db; /* gray-300 */
  }
  .editable-jan:focus {
    background-color: white;
    border-color: #14b8a6; /* teal-500 */
    box-shadow: 0 0 0 1px #14b8a6;
  }
  /* Let's fix the highlighting logic in the HTML block instead of CSS tricks */

  .batch-progress-overlay {
    position: sticky;
    top: 0;
    left: 0;
    right: 0;
    background-color: rgba(17, 24, 39, 0.9); /* gray-900 / 90% */
    color: white;
    padding: 1rem;
    z-index: 50;
    backdrop-filter: blur(4px);
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    border-bottom-left-radius: 0.5rem;
    border-bottom-right-radius: 0.5rem;
    margin-bottom: 1.5rem;
    margin-left: -1rem;
    margin-right: -1rem;
    margin-top: -1rem;
    transition: transform 0.3s;
  }
  .overlay-content {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .status-indicator {
    display: flex;
    align-items: center;
    gap: 1.5rem;
  }
  .status-indicator h3 {
    font-weight: 700;
    font-size: 1.125rem;
  }
  .status-indicator p {
    color: #d1d5db; /* gray-300 */
    font-size: 0.875rem;
  }
  .active-item-card {
    display: flex;
    align-items: center;
    gap: 1rem;
    background-color: #1f2937; /* gray-800 */
    border-radius: 0.5rem;
    padding: 0.5rem;
    padding-right: 1rem;
    box-shadow: inset 0 2px 4px 0 rgba(0, 0, 0, 0.06);
    border: 1px solid #374151; /* gray-700 */
  }
  .thumbnail-wrapper {
    width: 2.5rem; /* 10 */
    height: 2.5rem;
    flex-shrink: 0;
    border-radius: 0.25rem;
    overflow: hidden;
    background-color: #374151;
    position: relative;
    border: 1px solid #4b5563; /* gray-600 */
  }
  .operation-details {
    display: flex;
    flex-direction: column;
  }
  .op-label {
    font-size: 0.625rem; /* 10px */
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #9ca3af; /* gray-400 */
    font-weight: 700;
  }
  .op-value {
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      "Courier New", monospace;
    font-size: 0.75rem; /* xs */
    color: #a5b4fc; /* indigo-300 */
    white-space: nowrap;
  }
</style>
