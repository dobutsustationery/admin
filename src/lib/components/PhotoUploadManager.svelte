<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import { broadcast } from "$lib/redux-firestore";
  import { firestore } from "$lib/firebase";
  import {
    addDoc,
    collection,
    doc,
    getDoc,
    onSnapshot,
    query,
    serverTimestamp,
    setDoc,
    where,
  } from "firebase/firestore";
  import { getStoredToken as getPhotosToken } from "$lib/google-photos";
  import { getStoredToken as getDriveToken } from "$lib/google-drive";
  import {
    ensureFolderStructure,
    getFolderId,
    findFileByDerivationKey,
    generateDerivationKey,
  } from "$lib/google-drive";
  import { getUploadCandidates } from "$lib/upload-logic";
  import {
    PHOTOS_IMAGE_TRANSFER_REQUEST_EVENT,
    SYNC_COLLECTION,
    SYNC_SECRETS_COLLECTION,
  } from "$lib/sync-events";

  let interval: ReturnType<typeof setInterval>;
  let unsubscribeSecretRequests: (() => void) | null = null;
  let unsubscribeTransferRequests: (() => void) | null = null;
  let cachedOriginalsId: string | null = null;
  let processing = new Set<string>(); // Local lock to prevent double-processing in same cycle
  let respondedSecretRequestIds = new Set<string>();
  let requestedPhotoIds = new Set<string>();
  let secretListenerStartedAtMs = 0;
  let transferRequestsHydrated = false;

  // Configuration
  const MAX_RETRIES = 3;
  const UPLOAD_TIMEOUT = 5 * 60 * 1000; // backend sync transfers can take much longer than local uploads
  const CHECK_INTERVAL = 2000;
  onMount(() => {
    interval = setInterval(processQueue, CHECK_INTERVAL);
    startSecretRequestListener();
    startTransferRequestListener();
  });

  onDestroy(() => {
    if (interval) clearInterval(interval);
    if (unsubscribeSecretRequests) unsubscribeSecretRequests();
    if (unsubscribeTransferRequests) unsubscribeTransferRequests();
  });

  function getLongestAvailableDriveToken() {
    const photosToken = getPhotosToken();
    const driveToken = getDriveToken() || photosToken;
    return { photosToken, driveToken };
  }

  function hasDriveUploadScope(token: { scope?: string } | null | undefined) {
    const scope = String(token?.scope || "");
    return (
      scope.includes("https://www.googleapis.com/auth/drive.file") ||
      scope.includes("https://www.googleapis.com/auth/drive")
    );
  }

  function startTransferRequestListener() {
    if (unsubscribeTransferRequests) return;
    const q = query(
      collection(firestore, SYNC_COLLECTION),
      where("eventType", "==", PHOTOS_IMAGE_TRANSFER_REQUEST_EVENT),
    );
    unsubscribeTransferRequests = onSnapshot(
      q,
      (snap) => {
        for (const change of snap.docChanges()) {
          if (change.type !== "added") continue;
          const data = change.doc.data() as any;
          const photoId = String(
            data?.payload?.photoId || data?.photoId || "",
          ).trim();
          if (photoId) requestedPhotoIds.add(photoId);
        }
        transferRequestsHydrated = true;
      },
      (error) => {
        console.warn(
          "[PhotoUploadManager] transfer request listener failed",
          error,
        );
        transferRequestsHydrated = true;
      },
    );
  }

  function toSyncPhotoRequestDocId(photoId: string) {
    const safe = String(photoId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
    return `photos_request_${safe}`;
  }

  function startSecretRequestListener() {
    if (unsubscribeSecretRequests) return;
    secretListenerStartedAtMs = Date.now();
    const q = query(
      collection(firestore, SYNC_COLLECTION),
      where("eventType", "==", "photos/image_transfer_secret_required"),
    );
    unsubscribeSecretRequests = onSnapshot(
      q,
      (snap) => {
        for (const change of snap.docChanges()) {
          if (change.type !== "added") continue;
          const id = change.doc.id;
          if (respondedSecretRequestIds.has(id)) continue;
          const data = change.doc.data() as any;
          const createdAtMs = Number(data?.createdAtMs || 0);
          if (createdAtMs && createdAtMs < secretListenerStartedAtMs - 5000) {
            // Ignore historical backlog so a page refresh does not replay old secret handoffs.
            continue;
          }
          respondedSecretRequestIds.add(id);
          respondToSecretRequired(id, data).catch((error) => {
            console.warn(
              "[PhotoUploadManager] secret_required response failed",
              {
                id,
                error,
              },
            );
            respondedSecretRequestIds.delete(id);
          });
        }
      },
      (error) => {
        console.warn(
          "[PhotoUploadManager] secret_required listener failed",
          error,
        );
      },
    );
  }

  async function respondToSecretRequired(syncEventId: string, eventData: any) {
    if (!$user?.uid) return;
    const uid = $user.uid;
    const payload = eventData?.payload || {};

    const { photosToken, driveToken } = getLongestAvailableDriveToken();
    if (!driveToken?.access_token) {
      console.warn(
        "[PhotoUploadManager] No Drive token available for secret response",
        {
          syncEventId,
        },
      );
      return;
    }

    const secretDocId = `photos-secret-${uid}`;

    await setDoc(doc(firestore, SYNC_SECRETS_COLLECTION, secretDocId), {
      creator: uid,
      requestId: String(eventData?.requestId || "").trim(),
      source: "photo-upload-manager:secret-response",
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60 * 60 * 1000,
      // We cannot mint a refresh token here; these are the longest-lived tokens available in current client flow.
      photosAccessToken: photosToken?.access_token || null,
      driveAccessToken: driveToken.access_token,
    });

    await addDoc(collection(firestore, SYNC_COLLECTION), {
      eventType: "photos/image_transfer_secret_provided",
      creator: uid,
      requestedBy: uid,
      requestId: String(eventData?.requestId || "").trim(),
      source: "photo-upload-manager",
      payloadVersion: 1,
      payload: {
        targetRequestEventId: String(
          payload?.targetRequestEventId || eventData?.requestEventId || "",
        ).trim(),
        secretRef: {
          collection: SYNC_SECRETS_COLLECTION,
          docId: secretDocId,
        },
        secretRequiredEventId: syncEventId,
      },
      createdAtMs: Date.now(),
      createdAt: serverTimestamp(),
      timestamp: serverTimestamp(),
    });
  }

  async function processQueue() {
    // Requirements: User signed in (Firebase) AND a Drive-capable token available
    if (!$user || !$user.uid) return;
    const photosToken = getPhotosToken();
    const driveToken = getDriveToken() || photosToken;
    if (!driveToken) return;
    if (!hasDriveUploadScope(driveToken)) return;
    if (!transferRequestsHydrated) return;

    const state = $store.photos;
    const { selected, uploads } = state;
    const now = Date.now();

    // 1. Identify Candidates
    const candidates = getUploadCandidates(selected, uploads || {}, now, {
      maxRetries: MAX_RETRIES,
      uploadTimeout: UPLOAD_TIMEOUT,
    }).filter((item) => !requestedPhotoIds.has(String(item.id || "")));

    if (candidates.length > 0) {
      console.log(
        `[UploadManager] Found ${candidates.length} candidates`,
        candidates.map((c) => c.id),
      );
    }

    if (candidates.length === 0) return;

    // 2. Ensure Folder (One time setup)
    if (!cachedOriginalsId) {
      try {
        const { originalsId } = await ensureFolderStructure(
          driveToken.access_token,
        );
        cachedOriginalsId = originalsId;
      } catch (e) {
        const fallbackFolderId = getFolderId();
        if (!fallbackFolderId) {
          console.error(
            "[UploadManager] Failed to ensure folder structure:",
            e,
          );
          return; // Abort this cycle
        }
        console.warn(
          "[UploadManager] Falling back to root folder for uploads:",
          e,
        );
        cachedOriginalsId = fallbackFolderId;
      }
    }

    // 3. Process Batch
    // We process sequentially or parallel? Parallel up to limit (e.g. 3) to strictly avoid rate limits
    // But `candidates` implies "all needing work".
    // Let's take first 3 to avoid flooding.
    const batch = candidates.slice(0, 3);

    for (const item of batch) {
      if (processing.has(item.id)) continue; // Skip if local loop already picked it up

      processing.add(item.id);

      // Fire & Forget (async)
      uploadItem(item, cachedOriginalsId!).finally(() => {
        processing.delete(item.id);
      });
    }
  }

  async function uploadItem(item: any, folderId: string) {
    const uid = $user.uid!;
    const requestId = `photo-transfer-${item.id}-${Date.now()}`;

    try {
      const driveToken = getDriveToken() || getPhotosToken();
      if (!driveToken)
        throw new Error("No token available for pre-upload check");

      // 1. Idempotency Check: Search Before Sync Request
      const sourceType = item.baseUrl?.includes("googleusercontent.com")
        ? "photos"
        : "ext";
      const derivationKey = generateDerivationKey(
        sourceType,
        String(item.id),
        "identity",
      );

      try {
        const existing = await findFileByDerivationKey(
          driveToken.access_token,
          derivationKey,
        );
        if (existing) {
          console.info(
            `[PhotoUploadManager] Idempotent match found for ${item.id}: ${existing.id}`,
          );
          requestedPhotoIds.add(String(item.id));

          await broadcast(firestore, uid, {
            type: "photos/complete_upload",
            payload: {
              id: item.id,
              requestId: `idempotent-resolve-${Date.now()}`,
              permanentUrl: existing.publicUrl || existing.apiUrl,
              webViewLink: existing.webViewLink || "",
            },
          });
          return;
        }
      } catch (checkErr) {
        console.warn(
          "[PhotoUploadManager] Pre-upload check failed, continuing with request",
          checkErr,
        );
      }

      // 2. Queue append-only sync intent so the backend worker can process transfer.
      const syncRequestDocId = toSyncPhotoRequestDocId(item.id);
      const syncRequestRef = doc(firestore, SYNC_COLLECTION, syncRequestDocId);
      const existing = await getDoc(syncRequestRef);
      if (existing.exists()) {
        requestedPhotoIds.add(String(item.id));
        console.info(
          "[PhotoUploadManager] Sync request already exists, waiting",
          {
            photoId: item.id,
            syncRequestDocId,
          },
        );
        return;
      }

      await setDoc(syncRequestRef, {
        eventType: PHOTOS_IMAGE_TRANSFER_REQUEST_EVENT,
        requestId,
        creator: uid,
        requestedBy: uid,
        requestedAt: Date.now(),
        source: "photo-upload-manager",
        photoId: item.id,
        filename: item.filename || `${item.id}.jpg`,
        mimeType: item.mimeType || "image/jpeg",
        payloadVersion: 1,
        payload: {
          photoId: item.id,
          sourceBaseUrl: item.baseUrl || "",
          filename: item.filename || `${item.id}.jpg`,
          mimeType: item.mimeType || "image/jpeg",
          targetFolderId: folderId,
          sourceType: item.baseUrl?.includes("googleusercontent.com")
            ? "google_photos_url"
            : "url",
          sourceRef: {
            mediaItemId: item.id,
            url: item.baseUrl || "",
          },
        },
        createdAtMs: Date.now(),
        createdAt: serverTimestamp(),
        timestamp: serverTimestamp(),
      });
      requestedPhotoIds.add(String(item.id));

      // Broadcase Initiate
      await broadcast(firestore, uid, {
        type: "photos/initiate_upload",
        payload: { id: item.id, timestamp: Date.now(), requestId },
      });
    } catch (e: any) {
      if (String(e?.code || "").includes("permission-denied")) {
        requestedPhotoIds.add(String(item.id));
        console.info(
          "[PhotoUploadManager] Sync request deduped by rules, waiting",
          {
            photoId: item.id,
          },
        );
        return;
      }
      console.error(`[UploadManager] Fail ${item.filename}:`, e);
      await broadcast(firestore, uid, {
        type: "photos/fail_upload",
        payload: {
          id: item.id,
          requestId,
          error: e.message || String(e),
        },
      });
    }
  }
</script>

<!-- Headless Component -->
