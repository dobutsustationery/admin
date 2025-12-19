<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import { broadcast } from "$lib/redux-firestore";
  import { firestore } from "$lib/firebase";
  import { getStoredToken } from "$lib/google-photos";
  import { ensureFolderStructure, uploadImageToDrive } from "$lib/google-drive";
  import { getUploadCandidates } from "$lib/upload-logic";

  let interval: ReturnType<typeof setInterval>;
  let cachedOriginalsId: string | null = null;
  let processing = new Set<string>(); // Local lock to prevent double-processing in same cycle

  // Configuration
  const MAX_RETRIES = 3;
  const UPLOAD_TIMEOUT = 5000; // 5s for easier testing
  const CHECK_INTERVAL = 2000;
  const HIGH_RES_SUFFIX = "=w4096-h4096";

  onMount(() => {
    interval = setInterval(processQueue, CHECK_INTERVAL);
  });

  onDestroy(() => {
    if (interval) clearInterval(interval);
  });

  async function processQueue() {
    // Requirements: User signed in (Firebase) AND Google Token available
    if (!$user || !$user.uid) return;
    const token = getStoredToken();
    if (!token) return; // Cannot upload without token

    const state = $store.photos;
    const { selected, uploads } = state;
    const now = Date.now();

    // 1. Identify Candidates
    const candidates = getUploadCandidates(selected, uploads || {}, now, { 
        maxRetries: MAX_RETRIES, 
        uploadTimeout: UPLOAD_TIMEOUT 
    });

    if (candidates.length > 0) {
        console.log(`[UploadManager] Found ${candidates.length} candidates`, candidates.map(c => c.id));
    }

    if (candidates.length === 0) return;

    // 2. Ensure Folder (One time setup)
    if (!cachedOriginalsId) {
        try {
            const { originalsId } = await ensureFolderStructure(token.access_token);
            cachedOriginalsId = originalsId;
        } catch (e) {
            console.error("[UploadManager] Failed to ensure folder structure:", e);
            return; // Abort this cycle
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
        uploadItem(item, token.access_token, cachedOriginalsId!).finally(() => {
            processing.delete(item.id);
        });
    }
  }

  async function uploadItem(item: any, accessToken: string, folderId: string) {
      const uid = $user.uid!;
      
      try {
          // Broadcase Initiate
          await broadcast(firestore, uid, {
              type: "photos/initiate_upload",
              payload: { id: item.id, timestamp: Date.now() }
          });
          
          // Fetch Blob
          // Use high-res URL
          // If fallback URL (baseUrl) is already invalid, this fails.
          // But that's handled by retry limit.
          const fetchUrl = `${item.baseUrl}${HIGH_RES_SUFFIX}`;
          
          // Use query param for auth to avoid CORS preflight while still authenticating.
          const separator = fetchUrl.includes('?') ? '&' : '?';
          const fetchUrlWithAuth = `${fetchUrl}${separator}access_token=${accessToken}`;
          const resp = await fetch(fetchUrlWithAuth, { referrerPolicy: "no-referrer" });
          
          if (!resp.ok) {
              throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);
          }
          
          const blob = await resp.blob();
          const driveFilename = `${Date.now()}_${item.filename}`;
          
          // Upload
          const driveFile = await uploadImageToDrive(blob, driveFilename, folderId, accessToken);
          
          // Determine Permanent URL
          // google-drive.ts now forces a constructed thumbnail link if needed
          const permanentUrl = driveFile.thumbnailLink || driveFile.webContentLink;
          
          if (!permanentUrl) {
              throw new Error("No permanent URL returned from Drive");
          }
          
          // Broadcast Success
          await broadcast(firestore, uid, {
              type: "photos/complete_upload",
              payload: { 
                  id: item.id, 
                  permanentUrl: permanentUrl,
                  webViewLink: driveFile.webViewLink 
              }
          });
          
      } catch (e: any) {
          console.error(`[UploadManager] Fail ${item.filename}:`, e);
          await broadcast(firestore, uid, {
              type: "photos/fail_upload",
              payload: { id: item.id, error: e.message || String(e) }
          });
      }
  }
</script>
<!-- Headless Component -->
