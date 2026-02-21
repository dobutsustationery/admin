<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import { broadcast } from "$lib/redux-firestore";
  import { firestore } from "$lib/firebase";
  import { getStoredToken as getPhotosToken } from "$lib/google-photos";
  import { getStoredToken as getDriveToken } from "$lib/google-drive";
  import { ensureFolderStructure, uploadImageToDrive, getFolderId } from "$lib/google-drive";
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
    // Requirements: User signed in (Firebase) AND a Drive-capable token available
    if (!$user || !$user.uid) return;
    const photosToken = getPhotosToken();
    const driveToken = getDriveToken() || photosToken;
    if (!driveToken) return;

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
            const { originalsId } = await ensureFolderStructure(driveToken.access_token);
            cachedOriginalsId = originalsId;
        } catch (e) {
            const fallbackFolderId = getFolderId();
            if (!fallbackFolderId) {
                console.error("[UploadManager] Failed to ensure folder structure:", e);
                return; // Abort this cycle
            }
            console.warn("[UploadManager] Falling back to root folder for uploads:", e);
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
        uploadItem(item, photosToken?.access_token, driveToken.access_token, cachedOriginalsId!).finally(() => {
            processing.delete(item.id);
        });
    }
  }

  async function uploadItem(item: any, photosAccessToken: string | undefined, driveAccessToken: string, folderId: string) {
      const uid = $user.uid!;
      
      try {
          // Broadcase Initiate
          await broadcast(firestore, uid, {
              type: "photos/initiate_upload",
              payload: { id: item.id, timestamp: Date.now() }
          });
          
          // Fetch Blob using URL/header strategy that mirrors browser behavior.
          let fetchUrl = item.baseUrl;
          const isGoogleusercontent = fetchUrl.includes("googleusercontent.com");
          if (!isGoogleusercontent && !fetchUrl.includes("googleapis.com") && !fetchUrl.includes("drive.google.com")) {
              fetchUrl += HIGH_RES_SUFFIX;
          }

          let resp: Response | null = null;
          const candidateUrls = isGoogleusercontent
              ? (() => {
                    const base = item.baseUrl.replace(/=[a-z0-9,-]+$/i, "");
                    // Strict mode: only fetch original bytes for Google Photos sources.
                    return [`${base}=d`];
                })()
              : [fetchUrl];

          for (const candidate of candidateUrls) {
              if (photosAccessToken) {
                  // Google Photos PPA URLs require auth tied to the Photos account.
                  const withAuth = await fetch(candidate, {
                      headers: { Authorization: `Bearer ${photosAccessToken}` },
                      referrerPolicy: "no-referrer",
                  }).catch(() => null);
                  if (withAuth?.ok) {
                      resp = withAuth;
                      break;
                  }
              }

              // Fallback without auth for public/special cases.
              const withoutAuth = await fetch(candidate, {
                  referrerPolicy: "no-referrer",
              }).catch(() => null);
              if (withoutAuth?.ok) {
                  resp = withoutAuth;
                  break;
              }
          }

          // Drive and API URLs require auth.
          if (!resp && !isGoogleusercontent) {
              const authResp = await fetch(fetchUrl, {
                  headers: { Authorization: `Bearer ${driveAccessToken}` },
                  referrerPolicy: "no-referrer",
              }).catch(() => null);
              if (authResp?.ok) {
                  resp = authResp;
              }
          }

          if (!resp) {
              throw new Error(`Fetch failed for ${item.id}`);
          }

          const blob = await resp.blob();
          console.info(
              `[UploadManager] Source fetch succeeded: id=${item.id} url=${candidateUrls[0]} bytes=${blob.size} type=${blob.type || "unknown"}`
          );
          
          // Use Google Photos ID for uniqueness as requested
          // Sanitize ID just in case (though usually base64-like)
          const safeId = item.id.replace(/[^a-zA-Z0-9-_]/g, '');
          const ext = item.filename.split('.').pop() || 'jpg';
          const driveFilename = `${safeId}.${ext}`;
          
          // Check if file already exists? 
          // Drive allows duplicates. To strictly avoid it, we'd need to search first.
          // But for now, we just ensure the name is deterministic.
          
          // Upload
          const driveFile = await uploadImageToDrive(blob, driveFilename, folderId, driveAccessToken);
          
          // Determine Permanent URL
          // Keep the canonical Drive API media URL so downstream flows always reference
          // the full-size original bytes rather than an expiring/resized thumbnail URL.
          const permanentUrl = driveFile.publicUrl || driveFile.apiUrl;
          if (!permanentUrl) {
              throw new Error("No Drive public URL returned from upload");
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
