const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const syncDispatcher = require("./shared/sync-dispatcher.cjs");

initializeApp();
setGlobalOptions({ maxInstances: 10 });

const db = getFirestore();

exports.syncRequest = onDocumentCreated(
  {
    document: `${syncDispatcher.SYNC_COLLECTION}/{requestId}`,
    timeoutSeconds: 300,
    memory: "2GiB",
    concurrency: 2,
  },
  async (event) => {
    const requestData = event.data?.data();
    if (!requestData) return;

    const requestId = event.params?.requestId;
    const processor = `function:${process.env.K_SERVICE || "syncRequest"}`;
    try {
      const dispatched = await syncDispatcher.dispatchSyncCreate({
        db,
        requestEventId: requestId,
        requestData,
        processor,
        logger,
      });
      if (
        dispatched.handled &&
        dispatched.result &&
        !dispatched.result.processed
      ) {
        logger.info("Sync event not processed", {
          requestId,
          reason: dispatched.result.reason,
          domain: dispatched.domain,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed processing sync event", {
        requestId,
        eventType: String(requestData.eventType || ""),
        error: message,
      });
    }
  },
);
