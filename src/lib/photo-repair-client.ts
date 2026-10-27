import { generateDerivationKey } from "./idempotency-utils";
import {
  doc,
  writeBatch,
  serverTimestamp,
  getDoc,
  setDoc,
  getDocs,
  collection,
  query,
  where,
} from "firebase/firestore";
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
export async function seedRepairQueue(
  includeOther = false,
  progress?: (added: number) => void,
) {
  const response = await fetch("/photo-repair-audit.json");
  if (!response.ok) throw Error("Could not load photo import audit.");
  const audit = await response.json();
  // Include all recorded uses of the broken path, even beyond the audit snapshot.
  const completions = await getDocs(
    query(
      collection(firestore, "sync"),
      where("eventType", "==", "photos/image_transfer_completed"),
    ),
  );
  for (const doc of completions.docs) {
    const p = doc.data().payload || {};
    const url = String(p.sourceUrl || "");
    if (
      !url.includes("googleusercontent.com") ||
      url.includes("/d/") ||
      /(?:=d|=s0)$/.test(url) ||
      !p.photoId
    )
      continue;
    let source = audit.sources.find((s: any) => s.photoId === p.photoId);
    if (!source) {
      source = { photoId: p.photoId, transferEventIds: [], driveIds: [] };
      audit.sources.push(source);
    }
    if (!source.transferEventIds.includes(doc.id))
      source.transferEventIds.push(doc.id);
    if (p.driveFileId && !source.driveIds.includes(p.driveFileId))
      source.driveIds.push(p.driveFileId);
  }

  const root = store.getState() as any;
  const targets = allImageTargets(root);
  const repairedAssets = approvedRepairAssets(root.photoRepair);
  const aliases = new Map<string, any>();
  audit.images.forEach((r: any) => {
    aliases.set(imageKey(r.url), r);
    if (r.drive_id) aliases.set(r.drive_id, r);
  });
  const sources = new Map<string, any>(
    audit.sources.map((s: any) => [s.photoId, s]),
  );
  const driveToPhoto = new Map<string, string>();
  audit.sources.forEach((s: any) =>
    s.driveIds.forEach((d: string) => driveToPhoto.set(d, s.photoId)),
  );
  const grouped = new Map<string, any>();
  for (const target of targets) {
    if (repairedAssets.has(imageKey(target.beforeUrl))) continue;
    const ref = target.ref;
    const photoId = "photoId" in ref ? ref.photoId : undefined;
    const alias = aliases.get(imageKey(target.beforeUrl));
    const originalId =
      (photoId && sources.has(photoId) ? photoId : undefined) ||
      (alias?.photo_id && sources.has(alias.photo_id)
        ? alias.photo_id
        : undefined) ||
      driveToPhoto.get(imageKey(target.beforeUrl));
    if (!originalId && !(includeOther && alias)) continue;
    const sourceKey = originalId || `other:${imageKey(target.beforeUrl)}`;
    const assetKey = alias?.drive_id || imageKey(target.beforeUrl);
    const key = `${sourceKey}:${assetKey}`;
    const g = grouped.get(key) || {
      sourceKey,
      originalId,
      oldImageUrl: target.beforeUrl,
      targets: [],
      existingPhotoId: photoId,
    };
    if (photoId) g.existingPhotoId = photoId;
    g.targets.push(target);
    grouped.set(key, g);
  }
  let added = 0;
  const sourceIds = new Map<string, string>();
  for (const g of grouped.values()) {
    const current = (store.getState() as any).photoRepair;
    const exists = Object.values(current.entriesById).some((e: any) =>
      e.targets.some((t: any) =>
        g.targets.some(
          (n: any) =>
            JSON.stringify(n.ref) === JSON.stringify(t.ref) &&
            n.beforeUrl === t.beforeUrl,
        ),
      ),
    );
    if (exists) continue;
    let sourceId =
      sourceIds.get(g.sourceKey) ||
      (Object.values(current.sourcesById) as any[]).find(
        (s) => g.originalId && s.originalGoogleMediaId === g.originalId,
      )?.sourceId;
    if (!sourceId) {
      sourceId = id();
      await repairEvent("sourceAdded", {
        sourceId,
        ...(g.originalId ? { originalGoogleMediaId: g.originalId } : {}),
      });
    }
    sourceIds.set(g.sourceKey, sourceId);
    await repairEvent("entryAdded", {
      entryId: id(),
      sourceId,
      oldImageUrl: g.oldImageUrl,
      targets: g.targets,
      ...(g.existingPhotoId ? { existingPhotoId: g.existingPhotoId } : {}),
      evidence: {
        kind: g.originalId ? "bad_import" : "other_small_image",
        transferEventIds: sources.get(g.originalId)?.transferEventIds || [],
      },
    });
    added++;
    progress?.(added);
  }
  return added;
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
  const importId = id(),
    requestId = id();
  const root = store.getState() as any;
  const source = root.photoRepair.sourcesById[e.sourceId];
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
  let baseUrl = selection?.baseUrl || "";
  if (!baseUrl) {
    for (const eventId of e.evidence.transferEventIds.slice(-3).reverse()) {
      const event = await getDoc(doc(firestore, "sync", eventId));
      baseUrl = event.data()?.payload?.sourceBaseUrl || "";
      if (baseUrl) break;
    }
  }
  if (!baseUrl)
    throw Error(
      "Select the original in Google Photos or upload it from your computer.",
    );
  const mediaItemId = selection?.id || source.originalGoogleMediaId;
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
