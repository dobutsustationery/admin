<script lang="ts">
  import { page } from "$app/stores";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { store } from "$lib/store";
  import {
    initiate_upload,
    complete_upload,
    complete_edit,
  } from "$lib/photos-slice";
  import {
    ensureFolderStructure,
    uploadImageToDrive,
    getStoredToken as getDriveToken,
    initiateOAuthFlow as initiateDriveAuth,
    generateDerivationKey,
    calculateHash,
    findFileByDerivationKey,
    extractDriveFileId,
    getFileMetadata,
  } from "$lib/google-drive";
  import {
    getStoredToken as getPhotosToken,
    initiateOAuthFlow as initiatePhotosAuth,
  } from "$lib/google-photos";

  import SecureImage from "$lib/components/SecureImage.svelte";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import ManualCropModal from "$lib/components/ManualCropModal.svelte";
  import UploadProgressBanner from "$lib/components/UploadProgressBanner.svelte";
  import { activeBanners } from "$lib/banner-store";
  import { toGoogleDrivePublicImageUrl } from "$lib/drive-url";

  import { broadcast } from "$lib/redux-firestore";
  import { firestore } from "$lib/firebase";
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
  import {
    SYNC_COLLECTION,
    PHOTOS_IMAGE_TRANSFORM_REQUEST_EVENT,
  } from "$lib/sync-events";

  import type { ProcessingStep, ProcessingConfig } from "$lib/photos-slice";

  // --- State Selectors ---
  $: photoId = $page.url.searchParams.get("id") || "";
  $: urlHistory = $store.photos.urlHistory?.[photoId] || [];
  $: selectedItem = $store.photos.selected?.find((p: any) => p.id === photoId);
  $: categorizedItem = findCategorizedItem(
    photoId,
    $store.photos.janCodeToPhotos,
  );
  $: item = selectedItem || categorizedItem;
  $: effectiveHistory =
    urlHistory.length > 0 ? urlHistory : item?.baseUrl ? [item.baseUrl] : [];

  // --- Metadata Correlation Logic ---
  let fileMetadatas: Record<string, any> = {};
  let metadataLoading = false;

  async function loadAllMetadata() {
    if (metadataLoading) return;
    const token =
      getDriveToken()?.access_token || getPhotosToken()?.access_token;
    if (!token) {
      console.log("[History] No Drive/Photos token found yet, will retry...");
      return;
    }

    const uniqueIds = Array.from(
      new Set(
        effectiveHistory
          .map((url: string) => extractDriveFileId(url))
          .filter(Boolean),
      ),
    ) as string[];

    const idsToFetch = uniqueIds.filter((id) => !fileMetadatas[id]);

    if (idsToFetch.length === 0) {
      if (effectiveHistory.length > 0 && uniqueIds.length === 0) {
        console.log(
          "[History] No extractable Drive IDs in history yet (e.g. only ephemeral Photos URLs).",
        );
      }
      return;
    }

    console.log(
      `[History] Fetching metadata for ${idsToFetch.length} unique file IDs...`,
    );
    metadataLoading = true;

    try {
      const results = await Promise.all(
        idsToFetch.map((id) =>
          getFileMetadata(id, token).catch((err) => {
            console.warn(`[History] Failed metadata fetch for ${id}`, err);
            return null;
          }),
        ),
      );

      const newMetas = { ...fileMetadatas };
      results.forEach((meta, i) => {
        if (meta) {
          newMetas[idsToFetch[i]] = meta;
          console.log(
            `[History] Metadata success for ${idsToFetch[i]}: ${meta.name}`,
          );
        }
      });
      fileMetadatas = newMetas;
    } finally {
      metadataLoading = false;
    }
  }

  // --- Reactive UI Projection ---
  // This projection ensures Svelte tracks the dependency on fileMetadatas
  // and updates the table immediately when metadata arrives.
  $: historyItems = effectiveHistory.map((url: string, i: number) => {
    const fileId = extractDriveFileId(url);
    const meta = fileId ? fileMetadatas[fileId] : null;
    const key = meta?.properties?.derivation_key;
    const displayIdx = effectiveHistory.length - 1 - i;

    // Operation Label
    let label = "";
    if (key) {
      const transform = key.split(":")[2] || "identity";

      // Handle versioned transforms (e.g. crop_v3 -> Auto Crop (v3))
      const versionMatch = transform.match(/(.*)_v(\d+)$/);
      const baseTransform = versionMatch ? versionMatch[1] : transform;
      const version = versionMatch ? `v${versionMatch[2]}` : null;

      const labels: Record<string, string> = {
        identity:
          i === effectiveHistory.length - 1
            ? "Original Upload"
            : "Direct Replacement",
        upload: "Manual Upload",
        crop: "Auto Crop",
        manual_crop: "Manual Crop",
        color_correct: "Color Correction",
        remove_bg: "Background Removal",
        remove_background: "Background Removal",
      };

      const niceName = labels[baseTransform] || baseTransform;
      label = version ? `${niceName} (${version})` : niceName;
    } else {
      if (i === effectiveHistory.length - 1) label = "Original Upload";
      else
        label = url.includes("googleusercontent.com")
          ? "Source Image"
          : "Modified";
    }

    // Source Correlation
    let sourceIdx: number | null = null;
    if (key) {
      const parts = key.split(":");
      if (parts[0] === "drive") {
        const sourceId = parts[1];
        for (let j = effectiveHistory.length - 1; j >= 0; j--) {
          if (extractDriveFileId(effectiveHistory[j]) === sourceId) {
            sourceIdx = effectiveHistory.length - 1 - j;
            break;
          }
        }
      }
    }

    return {
      url,
      displayIdx,
      meta,
      label,
      sourceIdx,
    };
  });

  // Reactive trigger for metadata fetching
  $: if (effectiveHistory.length > 0 && !metadataLoading) {
    loadAllMetadata();
  }

  // Retry interval if we have a photoId but no metadata for its history yet
  onMount(() => {
    console.log(`[History] Photo history mounted for photoId: ${photoId}`);
    const t = setInterval(() => {
      if (effectiveHistory.length > 0 && !metadataLoading) {
        const uniqueIds = Array.from(
          new Set(
            effectiveHistory
              .map((url: string) => extractDriveFileId(url))
              .filter(Boolean),
          ),
        ) as string[];
        const missing = uniqueIds.filter((id) => !fileMetadatas[id]);
        if (missing.length > 0) {
          console.log(
            `[History] Retrying fetch for ${missing.length} missing metadata IDs...`,
          );
          loadAllMetadata();
        }
      }
    }, 1000);
    return () => clearInterval(t);
  });

  function getDriveOpenLink(url: string): string | null {
    const fileId = extractDriveFileId(url);
    return fileId ? `https://drive.google.com/file/d/${fileId}/view` : null;
  }

  function isDriveBackedUrl(url: string): boolean {
    return !!getDriveOpenLink(url);
  }

  function resolveHistoryCreatedTime(meta: any): string {
    const fixed = String(meta?.properties?.e2e_created_time || "").trim();
    if (fixed) return fixed;
    const createdTime = String(meta?.createdTime || "").trim();
    return createdTime;
  }

  // --- UI Handlers ---
  let fileInput: HTMLInputElement;
  let uploading = false;
  let uploadError = "";
  let uploadProgress = { loaded: 0, total: 0, percent: 0 };

  $: {
    if (uploading) {
      activeBanners.register({
        id: "upload-progress",
        component: UploadProgressBanner,
        props: { progress: uploadProgress },
        priority: 20,
      });
    } else {
      activeBanners.unregister("upload-progress");
    }
  }

  import { onDestroy } from "svelte";
  onDestroy(() => {
    activeBanners.unregister("upload-progress");
  });

  function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  async function handleFileUpload(event: Event) {
    const target = event.target as HTMLInputElement;
    if (!target.files || target.files.length === 0) return;
    const file = target.files[0];
    uploading = true;
    uploadError = "";
    uploadProgress = { loaded: 0, total: file.size, percent: 0 };

    try {
      const token = getDriveToken() || getPhotosToken();
      if (!token) {
        initiatePhotosAuth();
        return;
      }
      const folders = await ensureFolderStructure(token.access_token);
      if (!photoId) throw new Error("No Photo ID");
      store.dispatch(initiate_upload({ id: photoId, timestamp: Date.now() }));

      const filename = `manual_upload_${photoId}_${Date.now()}.jpg`;
      const currentId = extractDriveFileId(effectiveHistory[0]) || photoId;
      const derivationKey = generateDerivationKey("drive", currentId, "upload");

      const result = await uploadImageToDrive(
        file,
        filename,
        folders.processedId,
        token.access_token,
        derivationKey,
        (loaded, total) => {
          uploadProgress = {
            loaded,
            total,
            percent: Math.round((loaded / total) * 100),
          };
        },
      );
      const permanentUrl = toGoogleDrivePublicImageUrl(
        result.publicUrl || result.apiUrl || "",
      );
      if (!permanentUrl) throw new Error("Upload failed.");
      const action = complete_upload({
        id: photoId,
        permanentUrl: permanentUrl,
        webViewLink: result.webViewLink,
      });
      if ($user.uid) broadcast(firestore, $user.uid, action);
      else store.dispatch(action);
      if (fileInput) fileInput.value = "";
    } catch (e: any) {
      console.error("Upload failed", e);
      uploadError = e.message;
    } finally {
      uploading = false;
    }
  }

  async function handleMakeCurrent(url: string) {
    if (!photoId) return;
    const action = complete_upload({
      id: photoId,
      permanentUrl: toGoogleDrivePublicImageUrl(url),
      webViewLink: toGoogleDrivePublicImageUrl(url),
    });
    if ($user.uid) broadcast(firestore, $user.uid, action);
    else store.dispatch(action);
  }

  let processingOp = "";
  let showCropModal = false;
  let cropTargetUrl = "";

  async function fetchSafeDataUrl(url: string): Promise<string> {
    if (url.startsWith("data:")) return url;
    const token = getPhotosToken() || getDriveToken();
    const headers: any = {};
    let fetchUrl = toGoogleDrivePublicImageUrl(url);
    let candidateUrls: string[] = [];
    let driveId = null;
    const idMatch = fetchUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idMatch) driveId = idMatch[1];
    const pathMatch = fetchUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (pathMatch) driveId = pathMatch[1];
    const driveApiUrl = driveId
      ? `https://www.googleapis.com/drive/v3/files/${driveId}?alt=media`
      : "";
    if (fetchUrl.includes("googleusercontent.com")) {
      const base = fetchUrl.replace(/=[a-z0-9,-]+$/i, "");
      candidateUrls = [
        `${base}=w4096-h4096`,
        `${base}=w2048-h2048`,
        `${base}=d`,
        url,
      ];
      fetchUrl = candidateUrls[0];
    }
    const isDriveApi = fetchUrl.includes("googleapis.com/drive");
    const isPhotosUrl = fetchUrl.includes("googleusercontent.com");
    if (isDriveApi) {
      if (!token) throw new Error("Authentication missing.");
      headers.Authorization = `Bearer ${token.access_token}`;
    } else if (token && !isPhotosUrl) {
      headers.Authorization = `Bearer ${token.access_token}`;
    }
    const urlsToTry =
      candidateUrls.length > 0 ? candidateUrls : [fetchUrl, url];
    let res: Response | null = null;
    for (const candidate of urlsToTry) {
      try {
        const attempt = await fetch(candidate, {
          headers,
          referrerPolicy: "no-referrer",
        });
        if (attempt.ok) {
          res = attempt;
          break;
        }
      } catch {}
    }
    if ((!res || !res.ok) && driveApiUrl) {
      if (!token) throw new Error("Authentication missing.");
      const apiAttempt = await fetch(driveApiUrl, {
        headers: { Authorization: `Bearer ${token.access_token}` },
        referrerPolicy: "no-referrer",
      });
      if (apiAttempt.ok) res = apiAttempt;
    }
    if (!res || !res.ok) throw new Error("Failed to load image source");
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  let cropSourceUrl = "";
  async function openManualCrop(url: string) {
    try {
      cropSourceUrl = url;
      cropTargetUrl = await fetchSafeDataUrl(url);
      showCropModal = true;
    } catch (e: any) {
      alert("Could not load image: " + e.message);
    }
  }

  async function handleCropSave(e: CustomEvent<{ blob: Blob; cropData: any }>) {
    if (!photoId || !cropTargetUrl) return;
    const { blob, cropData } = e.detail;
    const driveId = extractDriveFileId(cropSourceUrl);
    const sourceType = driveId ? "drive" : "photos";
    const sourceId = driveId || photoId;
    const transform = `crop_${cropData.x}_${cropData.y}_${cropData.width}_${cropData.height}_r${cropData.rotate}`;
    const derivationKey = generateDerivationKey(
      sourceType,
      sourceId,
      transform,
    );
    await uploadBlob(blob, "manual_crop", derivationKey);
  }

  async function handleManualOp(
    url: string,
    op: "color" | "bg" | "smart_crop" | "pipeline",
  ) {
    if (processingOp) return;
    processingOp = url + "_" + op;
    const opToTransform = {
      color: "color_correct",
      bg: "remove_bg",
      smart_crop: "crop",
    };
    const steps =
      op === "pipeline"
        ? ($store.photos.processingConfig.steps || [])
            .filter((s: any) => s.enabled)
            .map((s: any) => s.type)
        : [op as any];
    try {
      const token = getDriveToken() || getPhotosToken();
      if (!token) throw new Error("Not authenticated");
      const forceFunctionsPath = Boolean(
        (window as any).__E2E_FORCE_FUNCTIONS_PATH__,
      );
      let currentUrl = url;
      for (const step of steps) {
        const transform =
          opToTransform[step as keyof typeof opToTransform] || step;
        const driveId = extractDriveFileId(currentUrl);
        const sourceType = driveId ? "drive" : "photos";
        const sourceId = driveId || photoId;
        const derivationKey = generateDerivationKey(
          sourceType,
          sourceId,
          transform,
        );
        const existing = forceFunctionsPath
          ? null
          : await findFileByDerivationKey(token.access_token, derivationKey);
        let finalUrl: string | null = null;
        if (existing) {
          finalUrl = existing.publicUrl || existing.apiUrl || "";
        } else {
          const pauseAtStart = (window as any).__E2E_PAUSE_OPERATION_AT_START__;
          if (typeof pauseAtStart === "function") {
            await pauseAtStart();
          }
          const requestId = `manual-op-${transform}-${sourceId}-${Date.now()}`;
          const folders = await ensureFolderStructure(token.access_token);
          const syncPayload: any = {
            photoId,
            sourceBaseUrl: currentUrl,
            filename: `manual_${step}_${sourceId}.png`,
            mimeType: "image/png",
            targetFolderId: folders.processedId,
            sourceType,
            transform,
            derivationKey,
            forceFunctionsPath,
            sourceRef: {
              mediaItemId: photoId,
              url: currentUrl,
              driveFileId: driveId,
            },
          };
          await addDoc(collection(firestore, SYNC_COLLECTION), {
            eventType: PHOTOS_IMAGE_TRANSFORM_REQUEST_EVENT,
            requestId,
            creator: $user.uid,
            requestedBy: $user.uid,
            requestedAt: Date.now(),
            source: "manual-op",
            photoId,
            filename: `manual_${step}_${sourceId}.png`,
            mimeType: "image/png",
            payloadVersion: 1,
            payload: syncPayload,
            createdAtMs: Date.now(),
            createdAt: serverTimestamp(),
            timestamp: serverTimestamp(),
          });
          finalUrl = await new Promise<string | null>((resolve) => {
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
                unsubscribe();
                if (data.eventType.endsWith("completed")) {
                  const payload = data.payload || {};
                  resolve(payload.permanentUrl || payload.apiUrl || null);
                } else resolve(null);
              },
              () => {
                unsubscribe();
                resolve(null);
              },
            );
            setTimeout(() => {
              unsubscribe();
              resolve(null);
            }, 60000);
          });
        }
        if (finalUrl) {
          if (existing && $user.uid) {
            const action = complete_edit({
              id: photoId,
              operation: transform as any,
              permanentUrl: finalUrl,
            });
            await broadcast(firestore, $user.uid, action);
          }
          currentUrl = finalUrl;
        } else throw new Error(`Step '${step}' failed.`);
      }
    } catch (e: any) {
      alert("Error: " + e.message);
    } finally {
      processingOp = "";
    }
  }

  async function uploadBlob(
    blob: Blob,
    suffix: string,
    derivationKey?: string | null,
  ) {
    if (!photoId) return;
    uploading = true;
    uploadProgress = { loaded: 0, total: blob.size, percent: 0 };
    try {
      const token = getDriveToken() || getPhotosToken();
      if (!token) {
        initiatePhotosAuth();
        return;
      }
      const folders = await ensureFolderStructure(token.access_token);
      const filename = `manual_${suffix}_${photoId}_${Date.now()}.png`;
      const file = new File([blob], filename, { type: "image/png" });
      const contentHash = await calculateHash(file);
      store.dispatch(initiate_upload({ id: photoId, timestamp: Date.now() }));
      const finalDerivationKey =
        derivationKey || generateDerivationKey("ext", contentHash, "identity");
      const result = await uploadImageToDrive(
        file,
        filename,
        folders.processedId,
        token.access_token,
        finalDerivationKey!,
        (loaded, total) => {
          uploadProgress = {
            loaded,
            total,
            percent: Math.round((loaded / total) * 100),
          };
        },
      );
      const safeUrl = toGoogleDrivePublicImageUrl(
        result.publicUrl || result.apiUrl || "",
      );
      const action = complete_upload({
        id: photoId,
        permanentUrl: safeUrl,
        webViewLink: result.webViewLink || "",
      });
      if ($user.uid) broadcast(firestore, $user.uid, action);
      else store.dispatch(action);
    } catch (e: any) {
      alert("Failed: " + e.message);
    } finally {
      uploading = false;
    }
  }

  function findCategorizedItem(id: string, map: Record<string, any[]>): any {
    if (!map) return null;
    for (const key in map) {
      const found = map[key].find((p) => p.id === id);
      if (found) return found;
    }
    return null;
  }
</script>

<ManualCropModal
  bind:open={showCropModal}
  imageUrl={cropTargetUrl}
  on:save={handleCropSave}
/>

<div class="page-content">
  <div class="header-row">
    <button class="back-button" on:click={() => goto("/photos")}
      >← Back to Photos</button
    >
    <h1 class="page-title">Photo History</h1>
  </div>

  <main>
    {#if !photoId}
      <div class="alert alert-warning">
        <p class="bold">No Photo ID provided.</p>
      </div>
    {:else if !item && urlHistory.length === 0}
      <div class="alert alert-error">
        <p class="bold">Photo not found: {photoId}.</p>
      </div>
    {:else}
      <div class="history-grid">
        <div class="card">
          <h2 class="card-title">Current Image</h2>
          {#if effectiveHistory.length > 0}
            <div class="current-image-layout">
              <div class="image-preview-container">
                <ImageThumbnail
                  src={effectiveHistory[0]}
                  alt="Current"
                  width="300px"
                  height="300px"
                  fit="contain"
                />
                <div class="external-links">
                  <a
                    href={isDriveBackedUrl(effectiveHistory[0])
                      ? getDriveOpenLink(effectiveHistory[0])
                      : effectiveHistory[0]}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="link"
                  >
                    Open {isDriveBackedUrl(effectiveHistory[0])
                      ? "in Google Drive"
                      : "source image"}
                  </a>
                </div>
              </div>
              <div class="replacement-actions">
                <h3 class="section-subtitle">Replace Image</h3>
                <p class="section-description">
                  Upload an alternate image to become the new active version.
                </p>
                <div class="upload-controls">
                  <input
                    type="file"
                    accept="image/*"
                    class="hidden-input"
                    bind:this={fileInput}
                    on:change={handleFileUpload}
                  />
                  <button
                    class="btn-primary"
                    on:click={() => fileInput.click()}
                    disabled={uploading}
                    >{uploading ? "Uploading..." : "Upload Alternate"}</button
                  >
                  {#if uploadError}<span class="error-text">{uploadError}</span
                    >{/if}
                </div>
              </div>
            </div>
          {:else}<div class="empty-state">No history available</div>{/if}
        </div>

        <div class="card">
          <div class="history-header">
            <h2 class="card-title history-title">History</h2>
            {#if metadataLoading}
              <div class="sync-status">
                <div class="spinner-small"></div>
                Syncing with Drive...
              </div>
            {/if}
          </div>

          {#if effectiveHistory.length === 0}
            <div class="empty-state">No history recorded</div>
          {:else}
            <div class="table-scroll-wrapper">
              <table class="history-table">
                <thead class="table-header">
                  <tr>
                    <th class="header-cell col-index">#</th>
                    <th class="header-cell col-preview">Preview</th>
                    <th class="header-cell">Operation</th>
                    <th class="header-cell">Date</th>
                    <th class="header-cell">Source</th>
                    <th class="header-cell">Actions</th>
                  </tr>
                </thead>
                <tbody class="table-body">
                  {#each historyItems as item, i}
                    <tr class="table-row" class:active-row={i === 0}>
                      <td class="data-cell font-mono">#{item.displayIdx}</td>
                      <td class="data-cell"
                        ><ImageThumbnail
                          src={item.url}
                          alt="History Item"
                          width="100px"
                          height="60px"
                          fit="contain"
                        /></td
                      >
                      <td class="data-cell"
                        ><span class="op-name">{item.label}</span></td
                      >
                      <td class="data-cell">
                        {#if resolveHistoryCreatedTime(item.meta)}<span
                            class="timestamp"
                            >{new Date(
                              resolveHistoryCreatedTime(item.meta),
                            ).toLocaleString()}</span
                          >
                        {:else}<span class="timestamp-na">N/A</span>{/if}
                      </td>
                      <td class="data-cell">
                        {#if item.sourceIdx !== null}
                          <div class="source-badge-container">
                            <span class="source-badge">#{item.sourceIdx}</span>
                            <span class="source-label"
                              >(Entry {item.sourceIdx})</span
                            >
                          </div>
                        {:else if i === historyItems.length - 1}
                          <span class="source-label italic">Root</span>
                        {:else}
                          <span class="source-label">None</span>
                        {/if}
                      </td>
                      <td class="data-cell">
                        <div class="action-buttons">
                          <button
                            class="use-this-btn"
                            class:active-btn={i === 0}
                            on:click={() => handleMakeCurrent(item.url)}
                            disabled={i === 0}
                            >{i === 0 ? "ACTIVE" : "Use This"}</button
                          >
                          <div class="manual-ops-bar">
                            <button
                              class="op-btn pipeline-btn"
                              on:click={() =>
                                handleManualOp(item.url, "pipeline")}
                              disabled={processingOp === item.url + "_pipeline"}
                              title="Run configured processing pipeline"
                              >Run Pipeline</button
                            >
                            <button
                              class="op-btn crop-btn"
                              on:click={() =>
                                handleManualOp(item.url, "smart_crop")}
                              disabled={processingOp ===
                                item.url + "_smart_crop"}>Crop</button
                            >
                            <button
                              class="op-btn manual-btn"
                              on:click={() => openManualCrop(item.url)}
                              >Manual</button
                            >
                            <button
                              class="op-btn color-btn"
                              on:click={() => handleManualOp(item.url, "color")}
                              disabled={processingOp === item.url + "_color"}
                              >Color</button
                            >
                            <button
                              class="op-btn bg-btn"
                              on:click={() => handleManualOp(item.url, "bg")}
                              disabled={processingOp === item.url + "_bg"}
                              >Remove BG</button
                            >
                          </div>
                        </div>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </main>
</div>

<style>
  .page-content {
    max-width: 72rem;
    margin-left: auto;
    margin-right: auto;
  }
  .header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 2rem;
  }
  .back-button {
    color: #6b7280;
    background: none;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
  }
  .back-button:hover {
    color: #374151;
  }
  .page-title {
    font-size: 1.5rem;
    font-weight: 700;
    color: #111827;
    margin: 0;
  }
  .alert {
    padding: 1rem;
    border-radius: 0.375rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    border: 1px solid transparent;
    margin-bottom: 2rem;
  }
  .alert-warning {
    background-color: #fffbeb;
    border-color: #fef3c7;
    color: #92400e;
  }
  .alert-error {
    background-color: #fef2f2;
    border-color: #fee2e2;
    color: #991b1b;
  }
  .bold {
    font-weight: 700;
  }
  .history-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 2rem;
  }
  .card {
    background-color: white;
    border-radius: 0.75rem;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    border: 1px solid #e5e7eb;
    padding: 1.5rem;
  }
  .card-title {
    font-size: 1.25rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: #1f2937;
  }
  .current-image-layout {
    display: flex;
    flex-direction: column;
    gap: 2rem;
    align-items: flex-start;
  }
  @media (min-width: 768px) {
    .current-image-layout {
      flex-direction: row;
    }
  }
  .image-preview-container {
    flex-shrink: 0;
    margin: 0 auto;
  }
  @media (min-width: 768px) {
    .image-preview-container {
      margin: 0;
    }
  }
  .external-links {
    margin-top: 1rem;
    font-size: 0.75rem;
    color: #6b7280;
    text-align: center;
  }
  .link {
    text-decoration: underline;
    color: inherit;
  }
  .link:hover {
    color: #374151;
  }
  .replacement-actions {
    flex-grow: 1;
    width: 100%;
    padding-top: 1.5rem;
    border-top: 1px solid #f3f4f6;
  }
  @media (min-width: 768px) {
    .replacement-actions {
      padding-top: 0;
      padding-left: 2rem;
      border-top: none;
      border-left: 1px solid #f3f4f6;
    }
  }
  .section-subtitle {
    font-size: 1rem;
    font-weight: 500;
    color: #111827;
    margin-bottom: 0.5rem;
    font-style: italic;
  }
  .section-description {
    font-size: 0.875rem;
    color: #6b7280;
    margin-bottom: 1rem;
  }
  .upload-controls {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .btn-primary {
    padding: 0.5rem 1rem;
    background-color: #4f46e5;
    color: white;
    border-radius: 0.5rem;
    border: none;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 700;
    transition: background-color 0.2s;
  }
  .btn-primary:hover:not(:disabled) {
    background-color: #4338ca;
  }
  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .error-text {
    color: #ef4444;
    font-size: 0.875rem;
  }
  .empty-state {
    padding: 3rem;
    text-align: center;
    color: #9ca3af;
  }
  .table-scroll-wrapper {
    overflow-x: auto;
  }
  .history-table {
    min-width: 100%;
    border-collapse: collapse;
  }
  .history-table thead {
    background-color: #f9fafb;
  }
  .header-cell {
    padding: 0.75rem 1rem;
    text-align: left;
    font-size: 0.75rem;
    font-weight: 500;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid #e5e7eb;
  }
  .data-cell {
    padding: 1rem;
    white-space: nowrap;
    border-bottom: 1px solid #f3f4f6;
  }
  .font-mono {
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.875rem;
    color: #6b7280;
  }
  .hidden-input {
    display: none;
  }
  .active-row {
    background-color: rgba(238, 242, 255, 0.3);
  }
  .op-name {
    font-size: 0.875rem;
    font-weight: 500;
    color: #111827;
  }
  .timestamp {
    font-size: 0.75rem;
    color: #6b7280;
  }
  .timestamp-na {
    font-size: 0.75rem;
    color: #9ca3af;
    font-style: italic;
  }
  .source-badge-container {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .source-badge {
    padding: 0.125rem 0.5rem;
    background-color: #f3f4f6;
    color: #4b5563;
    border-radius: 0.25rem;
    font-size: 0.75rem;
    font-family: monospace;
    border: 1px solid #e5e7eb;
  }
  .source-label {
    font-size: 0.75rem;
    color: #9ca3af;
    font-style: italic;
  }
  .action-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .use-this-btn {
    font-size: 0.75rem;
    font-weight: 700;
    padding: 0.25rem 0.5rem;
    background-color: #f3f4f6;
    color: #374151;
    border: 1px solid #d1d5db;
    border-radius: 0.25rem;
    cursor: pointer;
    transition: all 0.2s;
  }
  .use-this-btn:hover:not(:disabled) {
    background-color: #e5e7eb;
  }
  .use-this-btn.active-btn {
    background-color: #4f46e5;
    color: white;
    border-color: #4338ca;
    cursor: default;
  }
  .manual-ops-bar {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    background-color: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 0.25rem;
    padding: 0.25rem;
  }
  .op-btn {
    font-size: 0.75rem;
    font-weight: 700;
    padding: 0.25rem 0.5rem;
    background-color: white;
    border: 1px solid #e2e8f0;
    border-radius: 0.25rem;
    cursor: pointer;
    transition: all 0.2s;
  }
  .op-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .pipeline-btn {
    color: #4f46e5;
    border-color: #c7d2fe;
  }
  .pipeline-btn:hover:not(:disabled) {
    background-color: #eef2ff;
  }
  .crop-btn {
    color: #2563eb;
    border-color: #bfdbfe;
  }
  .crop-btn:hover:not(:disabled) {
    background-color: #eff6ff;
  }
  .manual-btn {
    color: #4f46e5;
    border-color: #c7d2fe;
  }
  .manual-btn:hover:not(:disabled) {
    background-color: #eef2ff;
  }
  .color-btn {
    color: #9333ea;
    border-color: #e9d5ff;
  }
  .color-btn:hover:not(:disabled) {
    background-color: #f5f3ff;
  }
  .bg-btn {
    color: #0d9488;
    border-color: #99f6e4;
  }
  .bg-btn:hover:not(:disabled) {
    background-color: #f0fdfa;
  }
  .col-index {
    width: 3rem;
  }
  .col-preview {
    width: 8rem;
  }
  .history-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem; /* mb-6 */
  }
  .history-title {
    margin: 0;
  }
  .sync-status {
    display: flex;
    align-items: center;
    gap: 0.5rem; /* gap-2 */
    font-size: 0.75rem; /* text-xs */
    color: #4f46e5; /* text-indigo-600 */
    font-weight: 500; /* font-medium */
    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }
  .spinner-small {
    width: 0.75rem; /* w-3 */
    height: 0.75rem; /* h-3 */
    border-width: 2px; /* border-2 */
    border-style: solid;
    border-color: #4f46e5; /* border-indigo-600 */
    border-top-color: transparent; /* border-t-transparent */
    border-radius: 9999px; /* rounded-full */
    animation: spin 1s linear infinite;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
