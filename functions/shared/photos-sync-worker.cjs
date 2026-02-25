const { FieldValue } = require("firebase-admin/firestore");
const {
  DERIVATION_KEY_PROPERTY,
  generateDerivationKey,
  escapeDriveQueryValue,
  buildDerivationKeyQuery,
  toDriveApiMediaUrl,
  toDrivePublicUrl,
  findFileByDerivationKey: sharedFindFileByDerivationKey,
} = require("./idempotency-utils.cjs");
const { removeBackground, autoColorCorrect, smartCrop } = require("./image-processor.cjs");

const SYNC_COLLECTION = "sync";
const SYNC_SECRETS_COLLECTION = "sync_secrets";
const PHOTOS_NS = "photos";

function nowMs() {
  return Date.now();
}

function normalizeString(v) {
  return typeof v === "string" ? v.trim() : "";
}

function baseEvent({
  eventType,
  requestId,
  requestEventId,
  creator,
  processor,
  requestedBy,
  payload,
}) {
  return {
    eventType,
    requestId,
    requestEventId,
    creator: creator || "photos-sync-worker",
    processor,
    requestedBy: requestedBy || null,
    payload: payload || {},
    createdAtMs: nowMs(),
    timestamp: FieldValue.serverTimestamp(),
  };
}

function requestingUid(requestData) {
  return (
    normalizeString(requestData?.requestedBy) ||
    normalizeString(requestData?.creator) ||
    normalizeString(requestData?.payload?.requestedBy)
  );
}

function syncCollection(db, collectionName) {
  return db.collection(collectionName || SYNC_COLLECTION);
}

function eventDoc(db, collectionName, id) {
  return syncCollection(db, collectionName).doc(id);
}

function isSecretUsable(secretData) {
  const driveAccessToken = normalizeString(secretData?.driveAccessToken);
  if (!driveAccessToken) return false;
  const expiresAtMs = Number(secretData?.expiresAtMs || 0);
  return !expiresAtMs || expiresAtMs > nowMs();
}

async function createEvent(db, collectionName, event) {
  await syncCollection(db, collectionName).add(event);
}

async function createIdempotentEvent(db, collectionName, deterministicId, event) {
  try {
    await eventDoc(db, collectionName, deterministicId).create(event);
    return { created: true };
  } catch (error) {
    const code = error?.code || error?.status;
    const msg = String(error?.message || "");
    if (code === 6 || msg.toLowerCase().includes("already exists")) {
      return { created: false };
    }
    throw error;
  }
}

async function createIdempotentBroadcastAction(db, deterministicId, action) {
  try {
    await db.collection("broadcast").doc(deterministicId).create({
      ...action,
      timestamp: FieldValue.serverTimestamp(),
    });
    return { created: true };
  } catch (error) {
    const code = error?.code || error?.status;
    const msg = String(error?.message || "");
    if (code === 6 || msg.toLowerCase().includes("already exists")) {
      return { created: false };
    }
    throw error;
  }
}

async function emitPhotoApiCallEvent({
  db,
  collectionName,
  requestEventId,
  requestId,
  processor,
  creator,
  requestedBy,
  requestType,
  endpoint,
  success,
  status,
  context,
  response,
}) {
  await createEvent(
    db,
    collectionName,
    baseEvent({
      eventType: `${PHOTOS_NS}/image_transfer_api_call`,
      requestId,
      requestEventId,
      creator,
      processor,
      requestedBy,
      payload: {
        requestType,
        endpoint,
        success: !!success,
        status: Number(status || 0) || null,
        context: context || {},
        response: response || {},
      },
    }),
  );
}

async function getSyncEventById(db, collectionName, id) {
  const snap = await eventDoc(db, collectionName, id).get();
  if (!snap.exists) return null;
  return { id: snap.id, data: snap.data() || {} };
}

async function syncEventExistsById(db, collectionName, id) {
  if (!normalizeString(id)) return false;
  const snap = await eventDoc(db, collectionName, id).get();
  return snap.exists;
}

async function findRequestEventByRequestId(db, collectionName, requestId) {
  const q = await syncCollection(db, collectionName)
    .where("requestId", "==", requestId)
    .where("eventType", "==", `${PHOTOS_NS}/image_transfer_requested`)
    .limit(1)
    .get();
  if (q.empty) return null;
  const doc = q.docs[0];
  return { id: doc.id, data: doc.data() || {} };
}

function stripGoogleusercontentSuffix(url) {
  return String(url || "").replace(/=[a-z0-9,-]+$/i, "");
}

/**
 * Search for a file by its derivation key in appProperties.
 */
async function findFileByDerivationKey(accessToken, derivationKey, onApiCall) {
  return sharedFindFileByDerivationKey(derivationKey, (url) =>
    driveRequestJson(url, {
      accessToken,
      onApiCall,
      apiMeta: {
        requestType: "drive.files.list",
        endpoint: "drive.files.list",
        context: { derivationKey },
      },
    }),
  );
}

async function emitSuccess({
  db,
  collectionName,
  requestEventId,
  requestId,
  processor,
  creator,
  requestedBy,
  eventType,
  payload,
}) {
  const completionEventType = eventType.includes("transform")
    ? `${PHOTOS_NS}/image_transform_completed`
    : `${PHOTOS_NS}/image_transfer_completed`;

  await createIdempotentEvent(
    db,
    collectionName,
    `result_${requestEventId}`,
    baseEvent({
      eventType: completionEventType,
      requestId,
      requestEventId,
      creator,
      processor,
      requestedBy,
      payload,
    }),
  );

  await createIdempotentBroadcastAction(db, `photos_complete_${requestEventId}`, {
    type: "photos/complete_upload",
    creator,
    payload: {
      id: payload.photoId,
      requestId,
      permanentUrl: payload.permanentUrl,
      webViewLink: payload.webViewLink || "",
    },
  });
}

async function fetchSourceBytes({
  sourceBaseUrl,
  photosAccessToken,
  driveAccessToken,
  onApiCall,
}) {
  const baseUrl = normalizeString(sourceBaseUrl);
  if (!baseUrl) {
    throw new Error("missing_source_base_url");
  }

  const isGoogleusercontent = baseUrl.includes("googleusercontent.com");
  const candidates = isGoogleusercontent ? [`${stripGoogleusercontentSuffix(baseUrl)}=d`] : [baseUrl];

  let resp = null;
  let usedUrl = "";
  for (const candidate of candidates) {
    usedUrl = candidate;
    if (photosAccessToken) {
      const withAuth = await fetch(candidate, {
        headers: { Authorization: `Bearer ${photosAccessToken}` },
      }).catch(() => null);
      await onApiCall?.({
        requestType: "photos.fetch_source",
        endpoint: "googleusercontent",
        success: !!withAuth?.ok,
        status: withAuth?.status || 0,
        context: { candidate, auth: "photos" },
        response: { ok: !!withAuth?.ok },
      });
      if (withAuth?.ok) {
        resp = withAuth;
        break;
      }
    }

    const unauth = await fetch(candidate).catch(() => null);
    await onApiCall?.({
      requestType: "http.fetch_source",
      endpoint: "source",
      success: !!unauth?.ok,
      status: unauth?.status || 0,
      context: { candidate, auth: "none" },
      response: { ok: !!unauth?.ok },
    });
    if (unauth?.ok) {
      resp = unauth;
      break;
    }
  }

  if (!resp && !isGoogleusercontent && driveAccessToken) {
    const driveAuth = await fetch(baseUrl, {
      headers: { Authorization: `Bearer ${driveAccessToken}` },
    }).catch(() => null);
    await onApiCall?.({
      requestType: "drive.fetch_source",
      endpoint: "source",
      success: !!driveAuth?.ok,
      status: driveAuth?.status || 0,
      context: { candidate: baseUrl, auth: "drive" },
      response: { ok: !!driveAuth?.ok },
    });
    if (driveAuth?.ok) {
      resp = driveAuth;
      usedUrl = baseUrl;
    }
  }

  if (!resp) {
    throw new Error(`source_fetch_failed:${baseUrl}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  const mimeType = normalizeString(resp.headers.get("content-type")) || "application/octet-stream";
  return {
    bytes: Buffer.from(arrayBuffer),
    mimeType,
    usedUrl,
  };
}

function buildMultipartBody({ metadata, bytes, mimeType }) {
  const boundary = `sync_boundary_${nowMs()}_${Math.random().toString(16).slice(2)}`;
  const head =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = Buffer.concat([Buffer.from(head, "utf8"), bytes, Buffer.from(tail, "utf8")]);
  return { body, boundary };
}

async function driveRequestJson(url, { method = "GET", accessToken, headers = {}, body, onApiCall, apiMeta } = {}) {
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...headers,
    },
    body,
  });
  await onApiCall?.({
    requestType: apiMeta?.requestType || "drive.api",
    endpoint: apiMeta?.endpoint || url.split("?")[0],
    success: resp.ok,
    status: resp.status,
    context: apiMeta?.context || {},
    response: { ok: resp.ok },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`drive_request_failed:${method}:${resp.status}:${text.slice(0, 300)}`);
  }
  if (resp.status === 204) return {};
  return await resp.json();
}

async function uploadToDrive({
  bytes,
  mimeType,
  filename,
  folderId,
  driveAccessToken,
  onApiCall,
  derivationKey,
}) {
  const metadata = {
    name: filename,
    parents: folderId ? [folderId] : undefined,
    appProperties: { [DERIVATION_KEY_PROPERTY]: derivationKey },
  };
  const { body, boundary } = buildMultipartBody({ metadata, bytes, mimeType });
  const file = await driveRequestJson(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink",
    {
      method: "POST",
      accessToken: driveAccessToken,
      onApiCall,
      apiMeta: {
        requestType: "drive.files.create",
        endpoint: "drive.files.create",
        context: { filename, folderId: folderId || null },
      },
      headers: {
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );

  await driveRequestJson(
    `https://www.googleapis.com/drive/v3/files/${file.id}/permissions`,
    {
      method: "POST",
      accessToken: driveAccessToken,
      onApiCall,
      apiMeta: {
        requestType: "drive.permissions.create",
        endpoint: "drive.permissions.create",
        context: { fileId: file.id },
      },
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    },
  );

  const details = await driveRequestJson(
    `https://www.googleapis.com/drive/v3/files/${file.id}?fields=id,name,webViewLink,webContentLink,thumbnailLink,mimeType`,
    {
      accessToken: driveAccessToken,
      onApiCall,
      apiMeta: {
        requestType: "drive.files.get",
        endpoint: "drive.files.get",
        context: { fileId: file.id },
      },
    },
  );

  return {
    id: details.id || file.id,
    name: details.name || file.name,
    mimeType: details.mimeType || mimeType,
    webViewLink: details.webViewLink || file.webViewLink || "",
    webContentLink: details.webContentLink || file.webContentLink || "",
    thumbnailLink: details.thumbnailLink || "",
    apiUrl: toDriveApiMediaUrl(details.id || file.id),
    publicUrl: toDrivePublicUrl(details.id || file.id),
  };
}

async function getSecretDoc(db, secretRef) {
  const docId =
    normalizeString(secretRef?.docId) ||
    normalizeString(secretRef?.id);
  const collection = normalizeString(secretRef?.collection) || SYNC_SECRETS_COLLECTION;
  if (!docId) return null;
  const snap = await db.collection(collection).doc(docId).get();
  if (!snap.exists) return null;
  return { id: snap.id, data: snap.data() || {}, collection };
}

async function findReusableSecretDocForUser(db, uid) {
  const requestedBy = normalizeString(uid);
  if (!requestedBy) return null;
  const preferredDocId = `photos-secret-${requestedBy}`;
  const preferred = await db.collection(SYNC_SECRETS_COLLECTION).doc(preferredDocId).get();
  if (preferred.exists) {
    const data = preferred.data() || {};
    if (
      isSecretUsable(data) &&
      normalizeString(data.creator) === requestedBy
    ) {
      return { id: preferred.id, data, collection: SYNC_SECRETS_COLLECTION };
    }
  }

  const snap = await db
    .collection(SYNC_SECRETS_COLLECTION)
    .where("creator", "==", requestedBy)
    .limit(20)
    .get();
  if (snap.empty) return null;
  const docs = snap.docs
    .map((d) => ({ id: d.id, data: d.data() || {}, collection: SYNC_SECRETS_COLLECTION }))
    .filter((d) => isSecretUsable(d.data))
    .sort((a, b) => {
      const aMs = Number(a.data.updatedAtMs || a.data.createdAtMs || 0);
      const bMs = Number(b.data.updatedAtMs || b.data.createdAtMs || 0);
      return bMs - aMs;
    });
  return docs[0] || null;
}

async function emitSecretRequired({
  db,
  collectionName,
  requestEventId,
  requestId,
  requestData,
  processor,
  creator,
}) {
  const requestedBy = requestingUid(requestData);
  const secretDocId = `photos-secret-${requestedBy || "shared"}`;
  const payload = requestData?.payload || {};

  await createIdempotentEvent(
    db,
    collectionName,
    `secret_required_${requestEventId}`,
    baseEvent({
      eventType: `${PHOTOS_NS}/image_transfer_secret_required`,
      requestId,
      requestEventId,
      creator,
      processor,
      requestedBy,
      payload: {
        requestedBy,
        secretRef: {
          collection: SYNC_SECRETS_COLLECTION,
          docId: secretDocId,
        },
        targetRequestEventId: requestEventId,
        photoId: normalizeString(payload?.photoId || requestData?.photoId),
        sourceRef: payload?.sourceRef || null,
        reason: "missing_or_invalid_secret",
      },
    }),
  );
}

function extractTransferParams(requestData) {
  const payload = requestData?.payload || {};
  const sourceBaseUrl = normalizeString(payload?.sourceBaseUrl || requestData?.sourceBaseUrl);
  const filename = normalizeString(payload?.filename || requestData?.filename) || "photo.jpg";
  const mimeType = normalizeString(payload?.mimeType || requestData?.mimeType) || "image/jpeg";
  const targetFolderId = normalizeString(payload?.targetFolderId);
  const photoId = normalizeString(payload?.photoId || requestData?.photoId);
  return { sourceBaseUrl, filename, mimeType, targetFolderId, photoId, payload };
}

async function executeTransfer({
  db,
  collectionName,
  requestEventId,
  requestData,
  requestId,
  processor,
  creator,
  secretDoc,
}) {
  const { sourceBaseUrl, filename, mimeType, targetFolderId, photoId, payload } = extractTransferParams(requestData);
  const secret = secretDoc?.data || {};
  const photosAccessToken = normalizeString(secret.photosAccessToken);
  const driveAccessToken = normalizeString(secret.driveAccessToken);

  if (!driveAccessToken) {
    await emitSecretRequired({
      db,
      collectionName,
      requestEventId,
      requestId,
      requestData,
      processor,
      creator,
    });
    return { processed: false, reason: "missing_drive_token" };
  }

  // Determine Derivation Key
  const eventType = normalizeString(requestData?.eventType);
  const transformName = eventType.includes("transform")
    ? normalizeString(payload?.transform || "unknown")
    : "identity";
  const driveFileId = normalizeString(payload?.sourceRef?.driveFileId);
  const sourceType = driveFileId
    ? "drive"
    : normalizeString(payload?.sourceType) ||
      (sourceBaseUrl.includes("googleusercontent.com") ? "photos" : "ext");
  const sourceId = driveFileId || photoId;
  const derivationKey = generateDerivationKey(
    sourceType,
    sourceId,
    transformName,
  );

  const requestedBy = requestingUid(requestData);
  const logApiCall = (params) =>
    emitPhotoApiCallEvent({
      db,
      collectionName,
      requestEventId,
      requestId,
      processor,
      creator,
      requestedBy,
      ...params,
    });

  // 1. Search Before Work
  try {
    const existingFile = await findFileByDerivationKey(driveAccessToken, derivationKey, logApiCall);
    if (existingFile) {
      console.log(`[PhotosWorker] Idempotent match found for ${derivationKey}: ${existingFile.id}`);
      
      await emitSuccess({
        db,
        collectionName,
        requestEventId,
        requestId,
        processor,
        creator,
        requestedBy,
        eventType,
        payload: {
          photoId,
          filename: existingFile.name,
          driveFileId: existingFile.id,
          permanentUrl: existingFile.publicUrl || existingFile.apiUrl,
          apiUrl: existingFile.apiUrl,
          webViewLink: existingFile.webViewLink,
          webContentLink: existingFile.webContentLink,
          mimeType: existingFile.mimeType,
          idempotent: true,
          derivationKey,
        },
      });

      return { processed: true, summary: { requestId, status: "completed", driveFileId: existingFile.id, idempotent: true } };
    }
  } catch (e) {
    console.warn(`[PhotosWorker] Pre-work search failed for ${derivationKey}, continuing with work`, e);
  }

  // 2. Perform Work
  const started = await createIdempotentEvent(
    db,
    collectionName,
    `start_${requestEventId}`,
    baseEvent({
      eventType: eventType.includes("transform") ? `${PHOTOS_NS}/image_transform_started` : `${PHOTOS_NS}/image_transfer_started`,
      requestId,
      requestEventId,
      creator,
      processor,
      payload: {
        photoId,
        filename,
        targetFolderId,
        derivationKey,
      },
      requestedBy,
    }),
  );

  if (!started.created) {
    return { processed: false, reason: "already_started" };
  }

  try {
    let bytes, finalMimeType, usedUrl;

    if (eventType.includes("transform")) {
      if (transformName === "remove_bg") {
        // 1. Fetch Source
        const source = await fetchSourceBytes({
          sourceBaseUrl,
          photosAccessToken,
          driveAccessToken,
          onApiCall: logApiCall,
        });
        
        // 2. Process
        console.log(`[PhotosWorker] Removing background for ${photoId}...`);
        bytes = await removeBackground(source.usedUrl, source.bytes);
        finalMimeType = "image/png"; // Result is always PNG from Sharp
        usedUrl = source.usedUrl;
      } else if (transformName === "color_correct") {
        // 1. Fetch Source
        const source = await fetchSourceBytes({
          sourceBaseUrl,
          photosAccessToken,
          driveAccessToken,
          onApiCall: logApiCall,
        });
        
        // 2. Process
        console.log(`[PhotosWorker] Color correcting for ${photoId}...`);
        bytes = await autoColorCorrect(source.bytes);
        finalMimeType = "image/png"; // Result is always PNG from Sharp
        usedUrl = source.usedUrl;
      } else if (transformName === "crop") {
        // 1. Fetch Source
        const source = await fetchSourceBytes({
          sourceBaseUrl,
          photosAccessToken,
          driveAccessToken,
          onApiCall: logApiCall,
        });
        
        // 2. Process
        console.log(`[PhotosWorker] Smart cropping for ${photoId}...`);
        bytes = await smartCrop(source.bytes);
        finalMimeType = "image/png"; // Result is always PNG from Sharp
        usedUrl = source.usedUrl;
      } else {
        throw new Error(`transform_not_implemented:${transformName}`);
      }
    } else {
      const source = await fetchSourceBytes({
        sourceBaseUrl,
        photosAccessToken,
        driveAccessToken,
        onApiCall: logApiCall,
      });
      bytes = source.bytes;
      finalMimeType = source.mimeType;
      usedUrl = source.usedUrl;
    }

    const uploaded = await uploadToDrive({
      bytes,
      mimeType: mimeType || finalMimeType,
      filename,
      folderId: targetFolderId,
      driveAccessToken,
      onApiCall: logApiCall,
      derivationKey,
    });

    await emitSuccess({
      db,
      collectionName,
      requestEventId,
      requestId,
      processor,
      creator,
      requestedBy,
      eventType,
      payload: {
        photoId,
        filename,
        sourceUrl: usedUrl,
        driveFileId: uploaded.id,
        permanentUrl: uploaded.publicUrl || uploaded.apiUrl,
        apiUrl: uploaded.apiUrl,
        webViewLink: uploaded.webViewLink,
        webContentLink: uploaded.webContentLink,
        mimeType: uploaded.mimeType || mimeType || finalMimeType,
        derivationKey,
      },
    });

    return { processed: true, summary: { requestId, status: "completed", driveFileId: uploaded.id } };
  } catch (error) {
    const message = String(error?.message || error || "unknown_error");
    const retryable =
      message.includes("401") ||
      message.includes("403") ||
      message.includes("missing_drive_token") ||
      message.includes("source_fetch_failed");

    const failureEventType = eventType.includes("transform")
      ? `${PHOTOS_NS}/image_transform_failed`
      : `${PHOTOS_NS}/image_transfer_failed`;

    await createIdempotentEvent(
      db,
      collectionName,
      `result_${requestEventId}`,
      baseEvent({
        eventType: failureEventType,
        requestId,
        requestEventId,
        creator,
        processor,
        requestedBy: requestingUid(requestData),
        payload: {
          photoId,
          errorCode: "transfer_failed",
          errorMessage: message,
          retryable,
        },
      }),
    );

    await createIdempotentBroadcastAction(db, `photos_fail_${requestEventId}`, {
      type: "photos/fail_upload",
      creator,
      payload: {
        id: photoId,
        requestId,
        error: message,
      },
    });

    if (message.includes("401") || message.includes("403")) {
      await emitSecretRequired({
        db,
        collectionName,
        requestEventId,
        requestId,
        requestData,
        processor,
        creator,
      });
    }

    return { processed: false, reason: "transfer_failed", error: message };
  }
}

async function handleTransferRequested(args) {
  const { db, collectionName, requestEventId, requestData, requestId, processor, creator } = args;
  const payload = requestData?.payload || {};
  const secretRef = payload?.secretRef || null;
  const requestedBy = requestingUid(requestData);
  const secretDoc =
    (await getSecretDoc(db, secretRef)) ||
    (await findReusableSecretDocForUser(db, requestedBy));
  if (!secretDoc || !normalizeString(secretDoc?.data?.driveAccessToken)) {
    await emitSecretRequired({
      db,
      collectionName,
      requestEventId,
      requestId,
      requestData,
      processor,
      creator,
    });
    return { processed: false, reason: "secret_required" };
  }
  return executeTransfer({ ...args, secretDoc });
}

async function handleSecretProvided(args) {
  const { db, collectionName, requestData, processor, creator } = args;
  const payload = requestData?.payload || {};
  const targetRequestEventId = normalizeString(
    payload?.targetRequestEventId || requestData?.targetRequestEventId,
  );
  const requestId = normalizeString(requestData?.requestId);

  let original = null;
  if (targetRequestEventId) {
    original = await getSyncEventById(db, collectionName, targetRequestEventId);
  }
  if (!original && requestId) {
    original = await findRequestEventByRequestId(db, collectionName, requestId);
  }
  if (!original) {
    return { processed: false, reason: "original_request_not_found" };
  }

  if (await syncEventExistsById(db, collectionName, `result_${original.id}`)) {
    return { processed: false, reason: "already_completed" };
  }

  const secretRef = payload?.secretRef || requestData?.secretRef || null;
  const secretDoc = await getSecretDoc(db, secretRef);
  if (!secretDoc) {
    return { processed: false, reason: "secret_missing_after_provided" };
  }

  return executeTransfer({
    ...args,
    requestEventId: original.id,
    requestData: original.data,
    requestId: normalizeString(original.data?.requestId) || requestId,
    processor,
    creator,
    secretDoc,
  });
}

async function processRequestEvent({
  db,
  requestEventId,
  requestData,
  processor,
  creator,
  collectionName,
}) {
  const eventType = normalizeString(requestData?.eventType);
  const requestId = normalizeString(requestData?.requestId || requestEventId);
  if (!requestId || !eventType) {
    return { processed: false, reason: "invalid_request" };
  }

  if (
    eventType === `${PHOTOS_NS}/image_transfer_requested` ||
    eventType === `${PHOTOS_NS}/image_transform_requested`
  ) {
    return handleTransferRequested({
      db,
      collectionName,
      requestEventId,
      requestData,
      requestId,
      processor,
      creator,
    });
  }

  if (eventType === `${PHOTOS_NS}/image_transfer_secret_provided`) {
    return handleSecretProvided({
      db,
      collectionName,
      requestEventId,
      requestData,
      requestId,
      processor,
      creator,
    });
  }

  return { processed: false, reason: "unsupported_event_type", eventType };
}

module.exports = {
  processRequestEvent,
};
