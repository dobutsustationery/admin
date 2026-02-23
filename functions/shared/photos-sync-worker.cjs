const { FieldValue } = require("firebase-admin/firestore");

function baseEvent({
  eventType,
  requestId,
  requestEventId,
  creator,
  processor,
  payload,
}) {
  return {
    eventType,
    requestId,
    requestEventId,
    creator: creator || "photos-sync-worker",
    processor,
    payload: payload || {},
    createdAtMs: Date.now(),
    timestamp: FieldValue.serverTimestamp(),
  };
}

function eventDoc(db, collectionName, id) {
  return db.collection(collectionName || "sync").doc(id);
}

async function createEvent(db, collectionName, event) {
  await db.collection(collectionName || "sync").add(event);
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

async function processRequestEvent({
  db,
  requestEventId,
  requestData,
  processor,
  creator,
  collectionName,
}) {
  const requestId = String(requestData?.requestId || requestEventId || "").trim();
  if (!requestId) {
    return { processed: false, reason: "invalid_request" };
  }

  const startedEvent = baseEvent({
    eventType: "photos/image_transfer_started",
    requestId,
    requestEventId,
    creator,
    processor,
    payload: {
      status: "accepted",
    },
  });

  const startedId = `start_${requestEventId}`;
  const started = await createIdempotentEvent(
    db,
    collectionName,
    startedId,
    startedEvent,
  );
  if (!started.created) {
    return { processed: false, reason: "already_started" };
  }

  const failedEvent = baseEvent({
    eventType: "photos/image_transfer_failed",
    requestId,
    requestEventId,
    creator,
    processor,
    payload: {
      errorCode: "not_implemented",
      errorMessage: "Photos image transfer worker is not implemented yet.",
      retryable: false,
    },
  });

  await createIdempotentEvent(
    db,
    collectionName,
    `result_${requestEventId}`,
    failedEvent,
  );

  // Optional append-only diagnostic event for visibility during rollout.
  await createEvent(
    db,
    collectionName,
    baseEvent({
      eventType: "photos/image_transfer_log",
      requestId,
      requestEventId,
      creator,
      processor,
      payload: {
        message: "Photos transfer request accepted by dispatcher stub.",
      },
    }),
  );

  return {
    processed: true,
    summary: {
      requestId,
      status: "failed:not_implemented",
    },
  };
}

module.exports = {
  processRequestEvent,
};
