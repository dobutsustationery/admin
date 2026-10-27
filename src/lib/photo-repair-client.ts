import {
  stockedPhotoTasks,
  taskAssessment,
  photoNeedsWork,
  taskForEntry,
  preferredStockEntry,
  type PhotoAudit,
  type StockPhotoTask,
  type PhotoMeasurement,
} from "./photo-repair-scope";
import { generateDerivationKey } from "./idempotency-utils";
import { doc, writeBatch, serverTimestamp, setDoc } from "firebase/firestore";
import { firestore } from "./firebase";
import { store } from "./store";
import { user } from "./user-store";
import { get } from "svelte/store";
import {
  getStoredToken,
  ensureFolderStructure,
  uploadImageToDrive,
} from "./google-drive";
import {
  getStoredToken as getPhotosToken,
  type MediaItem,
} from "./google-photos";
import {
  allImageTargets,
  approvedRepairAssets,
  imageKey,
  photoCheckKey,
  entryDetails,
  originalFor,
  attemptInput,
  stepOutput,
  type EntryRecord,
  type Step,
  type Artifact,
} from "./photo-repair";
import {
  buildAdminShopifyListingProjection,
  buildShopifySyncRequestEvent,
} from "./shopify-listing-projection";
const id = () => crypto.randomUUID();
function uid() {
  const uid = get(user)?.uid;
  if (!uid) throw Error("Sign in first.");
  return uid;
}
export async function repairEvent(type: string, payload: any, eventId = id()) {
  await setDoc(doc(firestore, "broadcast", eventId), {
    type: `photoRepair/${type}`,
    payload,
    creator: uid(),
    timestamp: serverTimestamp(),
  });
  return eventId;
}
export async function loadPhotoAudit(): Promise<PhotoAudit> {
  const response = await fetch("/photo-repair-audit.json");
  if (!response.ok) throw Error("Could not load the source-photo lookup.");
  return response.json();
}
async function measureCurrentPhoto(url: string): Promise<PhotoMeasurement> {
  const driveId = imageKey(url);
  if (!driveId.includes(":") && !driveId.includes("/")) {
    const token = getStoredToken();
    if (token) {
      try {
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveId)}?fields=imageMediaMetadata(width,height)`,
          { headers: { Authorization: `Bearer ${token.access_token}` } },
        );
        if (response.ok) {
          const metadata = (await response.json()).imageMediaMetadata;
          if (metadata?.width && metadata?.height)
            return {
              url,
              width: Number(metadata.width),
              height: Number(metadata.height),
            };
        }
      } catch {
        /* The public image remains usable when metadata is unavailable. */
      }
    }
  }
  return new Promise((resolve) => {
    const image = new Image();
    const finish = (result: PhotoMeasurement) => {
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish({
          url,
          message:
            "Could not load this photo. Take a look or select a replacement.",
        }),
      10000,
    );
    image.onload = () =>
      finish({ url, width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () =>
      finish({
        url,
        message:
          "Could not load this photo. Take a look or select a replacement.",
      });
    image.src = url;
  });
}
export async function ensureStockPhotoEntry(
  task: StockPhotoTask,
  audit: PhotoAudit,
): Promise<string> {
  const root = store.getState() as any;
  const existing = preferredStockEntry(root, task, audit);
  if (existing) {
    if (JSON.stringify(existing.targets) !== JSON.stringify(task.targets))
      await repairEvent("targetsChanged", {
        entryId: existing.entryId,
        targets: task.targets,
      });
    return existing.entryId;
  }
  const alias = audit.images.find(
    (i) =>
      imageKey(i.url) === imageKey(task.url) ||
      i.drive_id === imageKey(task.url),
  );
  const photoTarget = task.targets.find((t) => "photoId" in t.ref);
  const photoId =
    photoTarget && "photoId" in photoTarget.ref
      ? photoTarget.ref.photoId
      : undefined;
  const sourcePhoto = audit.sources.find(
    (s) =>
      s.photoId === photoId ||
      s.photoId === alias?.photo_id ||
      s.driveIds.includes(imageKey(task.url)),
  );
  let sourceId = (Object.values(root.photoRepair.sourcesById) as any[]).find(
    (s) => sourcePhoto && s.originalGoogleMediaId === sourcePhoto.photoId,
  )?.sourceId;
  if (!sourceId) {
    sourceId = id();
    await repairEvent("sourceAdded", {
      sourceId,
      ...(sourcePhoto ? { originalGoogleMediaId: sourcePhoto.photoId } : {}),
    });
  }
  const entryId = id();
  await repairEvent("entryAdded", {
    entryId,
    sourceId,
    oldImageUrl: task.url,
    targets: task.targets,
    ...(photoId ? { existingPhotoId: photoId } : {}),
    evidence: {
      kind: sourcePhoto ? "bad_import" : "other_small_image",
      transferEventIds: sourcePhoto?.transferEventIds || [],
    },
  });
  return entryId;
}
export async function reviewStockPhoto(
  task: StockPhotoTask,
  good: boolean,
  audit: PhotoAudit,
) {
  if (!task.url && good) return;
  if (task.url)
    await repairEvent("photoReviewChanged", {
      url: task.url,
      relatedUrls: [
        ...new Set(task.targets.map((t) => t.beforeUrl).filter(Boolean)),
      ],
      good,
    });
  if (!good) return ensureStockPhotoEntry(task, audit);
}
export async function seedRepairQueue(progress?: (message: string) => void) {
  const audit = await loadPhotoAudit();
  const tasks = stockedPhotoTasks(store.getState(), audit);
  let checked = 0,
    added = 0;
  let index = 0;
  const measured: Record<string, PhotoMeasurement> = {};
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (index < tasks.length) {
        const task = tasks[index++];
        const assessment = taskAssessment(store.getState(), task);
        const cached = (store.getState() as any).photoRepair
          .measurementsByKey?.[photoCheckKey(task.url)];
        if (
          task.url &&
          (!cached || cached.message || cached.url !== task.url) &&
          !["Repaired", "Photo is good", "Needs a better photo"].includes(
            assessment,
          )
        ) {
          const result = await measureCurrentPhoto(task.url);
          measured[photoCheckKey(task.url)] = result;
          await repairEvent("imageMeasured", result);
        }
        checked++;
        progress?.(
          `Checked ${checked} of ${tasks.length} current photos for stocked items…`,
        );
      }
    }),
  );
  // Use this scan's returned facts while the broadcast listener catches up.
  for (const task of stockedPhotoTasks(store.getState(), audit)) {
    const root = store.getState() as any;
    const assessment = taskAssessment(
      {
        ...root,
        photoRepair: {
          ...root.photoRepair,
          measurementsByKey: {
            ...root.photoRepair.measurementsByKey,
            ...measured,
          },
        },
      },
      task,
    );
    if (photoNeedsWork(assessment)) {
      await ensureStockPhotoEntry(task, audit);
      added++;
    }
  }
  return { checked, attention: added };
}
async function tokensAndFolder() {
  const drive = getStoredToken();
  const photos = getPhotosToken();
  if (!drive)
    throw Error("Connect Google before importing or processing photos.");
  const secretId = `photos-secret-${uid()}`;
  await setDoc(doc(firestore, "sync_secrets", secretId), {
    creator: uid(),
    source: "photo-repair",
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    expiresAtMs: Math.min(
      drive.expires_at || Date.now() + 3600000,
      Date.now() + 3600000,
    ),
    driveAccessToken: drive.access_token,
    photosAccessToken: photos?.access_token || null,
  });
  const folders = await ensureFolderStructure(drive.access_token);
  return {
    drive,
    folders,
    secretRef: { collection: "sync_secrets", docId: secretId },
  };
}
async function queuePhoto(
  collectionName: string,
  eventType: string,
  photoId: string,
  payload: any,
  eventTypeName: string,
  eventPayload: any,
) {
  const requestId = eventPayload.requestId;
  const batch = writeBatch(firestore);
  batch.set(doc(firestore, collectionName, requestId), {
    eventType,
    requestId,
    creator: uid(),
    requestedBy: uid(),
    source: "photo-repair",
    photoId,
    filename: payload.filename,
    mimeType: payload.mimeType,
    payloadVersion: 2,
    payload,
    createdAtMs: Date.now(),
    timestamp: serverTimestamp(),
  });
  batch.set(doc(firestore, "broadcast", `${requestId}-requested`), {
    type: `photoRepair/${eventTypeName}`,
    payload: eventPayload,
    creator: uid(),
    timestamp: serverTimestamp(),
  });
  await batch.commit();
}
export async function importRepairOriginal(
  e: EntryRecord,
  selection?: MediaItem,
  file?: File,
) {
  if (!file && !selection?.baseUrl)
    throw Error("Select the original in Google Photos again before importing.");
  const importId = id(),
    requestId = id();
  const root = store.getState() as any;
  const { drive, folders, secretRef } = await tokensAndFolder();
  if (file) {
    await repairEvent("originalRequested", {
      sourceId: e.sourceId,
      importId,
      requestId,
      choice: {
        kind: "upload",
        filename: file.name,
        mimeType: file.type || "image/jpeg",
      },
    });
    try {
      const result = await uploadImageToDrive(
        file,
        file.name,
        folders.originalsId,
        drive.access_token,
        generateDerivationKey("repair_original", importId, "identity")!,
      );
      await repairEvent("originalImported", {
        sourceId: e.sourceId,
        importId,
        requestId,
        artifact: {
          driveFileId: result.id,
          url: result.publicUrl || result.apiUrl || "",
          webViewLink: result.webViewLink || "",
          filename: file.name,
          mimeType: file.type || "image/jpeg",
        },
      });
    } catch (error: any) {
      await repairEvent("originalFailed", {
        sourceId: e.sourceId,
        importId,
        requestId,
        message: error.message,
      });
      throw error;
    }
    return;
  }
  const baseUrl = selection?.baseUrl;
  if (!selection || !baseUrl)
    throw Error("Select the original in Google Photos again before importing.");
  const mediaItemId = selection.id;
  const filename =
    selection?.filename || entryDetails(root, e).filename || "original.jpg";
  await queuePhoto(
    "request_photos_transfer",
    "photos/image_transfer_requested",
    `repair-source:${e.sourceId}:${importId}`,
    {
      repair: { kind: "original", sourceId: e.sourceId, importId },
      photoId: `repair-source:${e.sourceId}:${importId}`,
      sourceBaseUrl: baseUrl,
      sourceType: "photos",
      sourceRef: { mediaItemId },
      filename,
      mimeType: selection?.mimeType || "image/jpeg",
      targetFolderId: folders.originalsId,
      secretRef,
    },
    "originalRequested",
    {
      sourceId: e.sourceId,
      importId,
      requestId,
      choice: { kind: "google_photos", mediaItemId, filename },
    },
  );
}
export async function useExistingRepairSource(
  e: EntryRecord,
  photo: MediaItem,
) {
  const importId = id(),
    requestId = id();
  await repairEvent("originalRequested", {
    sourceId: e.sourceId,
    importId,
    requestId,
    choice: {
      kind: "existing_photo",
      photoId: photo.id,
      url: photo.baseUrl,
      filename: photo.filename,
    },
  });
  const key = imageKey(photo.baseUrl);
  await repairEvent("originalImported", {
    sourceId: e.sourceId,
    importId,
    requestId,
    artifact: {
      driveFileId: key.includes(":") ? "" : key,
      url: photo.baseUrl,
      webViewLink: photo.productUrl || photo.baseUrl,
      filename: photo.filename,
      mimeType: photo.mimeType,
    },
  });
}
export async function startRepairAttempt(
  e: EntryRecord,
  steps: Step[],
  parentAttemptId?: string,
  startStepIndex?: number,
) {
  const imp = originalFor((store.getState() as any).photoRepair, e);
  if (!imp?.result?.artifact) throw Error("Import an original first.");
  await repairEvent("attemptStarted", {
    entryId: e.entryId,
    attemptId: id(),
    importId: imp.importId,
    steps,
    ...(parentAttemptId ? { parentAttemptId, startStepIndex } : {}),
  });
}
export async function queueNextStep(attemptId: string, retry = false) {
  const s = (store.getState() as any).photoRepair;
  const a = s.attemptsById[attemptId];
  let index = 0;
  while (index < a.steps.length && stepOutput(a, index)) index++;
  if (index === a.steps.length) return;
  const run = a.runsByStep[index];
  if (run && !retry) return;
  const input: Artifact | undefined = index
    ? stepOutput(a, index - 1)
    : attemptInput(s, a);
  if (!input) return;
  const step = a.steps[index];
  const requestId = id();
  const { folders, secretRef } = await tokensAndFolder();
  const photoId = `repair:${a.entryId}:${attemptId}`;
  await queuePhoto(
    "request_photos_transform",
    "photos/image_transform_requested",
    photoId,
    {
      repair: { kind: "step", entryId: a.entryId, attemptId, stepIndex: index },
      photoId,
      sourceBaseUrl: input.url,
      sourceType: "drive",
      sourceRef: { driveFileId: input.driveFileId },
      filename: `repair-${attemptId}-${index}.png`,
      mimeType: input.mimeType,
      targetFolderId: folders.processedId,
      transform: step.kind === "smart_crop" ? "crop" : step.kind,
      ...(step.kind === "manual_crop" ? { crop: step } : {}),
      secretRef,
    },
    "stepRequested",
    { attemptId, stepIndex: index, requestId },
  );
}
export async function approveRepair(e: EntryRecord) {
  await repairEvent("approved", {
    approvalId: id(),
    entryId: e.entryId,
    attemptId: e.selectedAttemptId,
    targets: e.targets,
  });
}
export async function publishRepair(approvalId: string, retry = false) {
  const root = store.getState() as any;
  const approval = root.photoRepair.approvalsById[approvalId];
  if (approval?.result !== "applied") return;
  for (const handle of approval.affectedHandles) {
    const pubs = Object.values(root.photoRepair.publicationsById).filter(
      (p: any) => p.approvalIds.includes(approvalId) && p.handle === handle,
    ) as any[];
    if (pubs.length && !retry) continue;
    if (pubs.some((p) => !p.result || p.result.outcome === "completed"))
      continue;
    const listing = root.listings.handleToListing[handle];
    const items = Object.entries(root.inventory.idToItem)
      .filter(
        ([key, item]: any) =>
          (root.listings.idToHandle[key] || item.handle) === handle,
      )
      .map(([key, item]: any) => ({ ...item, id: key }));
    const projection = buildAdminShopifyListingProjection({
      handle,
      listing,
      items,
    });
    if (!projection)
      throw Error(`Could not prepare Shopify images for ${handle}.`);
    const publicationId = id(),
      requestId = `photo-repair-${publicationId}`;
    const request = {
      ...buildShopifySyncRequestEvent({
        projection,
        requestId,
        uid: uid(),
        source: "photo-repair",
        nowMs: Date.now(),
        serverTimestamp: serverTimestamp(),
      }),
      repairPublicationId: publicationId,
    };
    const batch = writeBatch(firestore);
    batch.set(doc(firestore, "request_shopify_sync", requestId), request);
    batch.set(doc(firestore, "broadcast", `${requestId}-requested`), {
      type: "photoRepair/publicationRequested",
      payload: { publicationId, handle, approvalIds: [approvalId], requestId },
      creator: uid(),
      timestamp: serverTimestamp(),
    });
    await batch.commit();
  }
}
export async function saveManualRepair(
  e: EntryRecord,
  blob: Blob,
  crop: any,
  parentAttemptId?: string,
  startStepIndex?: number,
) {
  const s = (store.getState() as any).photoRepair;
  const imp = originalFor(s, e);
  if (!imp?.result?.artifact) throw Error("Import an original first.");
  const attemptId = id(),
    requestId = id();
  const steps = [{ kind: "manual_crop", ...crop }];
  const batch = writeBatch(firestore);
  for (const [type, payload] of [
    [
      "attemptStarted",
      {
        entryId: e.entryId,
        attemptId,
        importId: imp.importId,
        steps,
        ...(parentAttemptId ? { parentAttemptId, startStepIndex } : {}),
      },
    ],
    ["stepRequested", { attemptId, stepIndex: 0, requestId }],
  ] as const) {
    batch.set(doc(firestore, "broadcast", id()), {
      type: `photoRepair/${type}`,
      payload,
      creator: uid(),
      timestamp: serverTimestamp(),
    });
  }
  await batch.commit();
  try {
    const { drive, folders } = await tokensAndFolder();
    const filename = `repair-${attemptId}-crop.png`;
    const result = await uploadImageToDrive(
      blob,
      filename,
      folders.processedId,
      drive.access_token,
      generateDerivationKey("repair_step", `${attemptId}-0`, "manual_crop")!,
    );
    await repairEvent("stepCompleted", {
      attemptId,
      stepIndex: 0,
      requestId,
      artifact: {
        driveFileId: result.id,
        url: result.publicUrl || result.apiUrl || "",
        webViewLink: result.webViewLink || "",
        filename,
        mimeType: "image/png",
      },
    });
  } catch (error: any) {
    await repairEvent("stepFailed", {
      attemptId,
      stepIndex: 0,
      requestId,
      message: error.message,
    });
    throw error;
  }
}
