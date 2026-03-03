import { test, expect } from "../fixtures/auth";

test.describe("Sync Payload Validation", () => {
  test("should reject sync events with binary data or large payloads", async ({
    page,
  }) => {
    test.setTimeout(45000);

    const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "localhost:8080";
    const projectCandidates = Array.from(
      new Set(
        [
          process.env.VITE_FIREBASE_PROJECT_ID,
          process.env.E2E_FIREBASE_PROJECT_ID,
          process.env.GCLOUD_PROJECT,
          process.env.GOOGLE_CLOUD_PROJECT,
          "dobutsu-admin",
          "demo-test-project",
        ].filter(Boolean) as string[],
      ),
    );

    const firestoreProjects = projectCandidates.length
      ? projectCandidates
      : ["dobutsu-admin"];

    const requestId = `test-rejection-${Date.now()}`;
    const largeString = "A".repeat(11 * 1024); // > 10 KB

    // 1. Add documents with large payload via Firestore REST API.
    // We write to all candidate project IDs so the test works regardless of
    // which emulator project namespace is active.
    const createdDocs: Array<{ projectId: string; docId: string }> = [];
    for (const firestoreProjectId of firestoreProjects) {
      const firestoreUrl = `http://${firestoreHost}/v1/projects/${firestoreProjectId}/databases/(default)/documents/sync`;
      const response = await page.request.post(firestoreUrl, {
        headers: {
          Authorization: "Bearer owner",
        },
        data: {
          fields: {
            eventType: { stringValue: "shopify/sync_requested" },
            requestId: { stringValue: requestId },
            creator: { stringValue: "e2e-test" },
            createdAtMs: { integerValue: Date.now().toString() },
            payload: {
              mapValue: {
                fields: {
                  largeData: { stringValue: largeString },
                },
              },
            },
          },
        },
      });
      if (!response.ok()) {
        console.warn(
          `Skipping project ${firestoreProjectId}; failed to write sync doc (${response.status()})`,
        );
        continue;
      }
      const createBody = await response.json();
      const createdDocName = String(createBody?.name || "");
      const createdDocId = createdDocName.split("/").pop() || "";
      if (createdDocId) {
        createdDocs.push({ projectId: firestoreProjectId, docId: createdDocId });
      }
      console.log(
        `✓ Added large payload sync event: ${requestId} (project=${firestoreProjectId}, docId=${createdDocId})`,
      );
    }
    expect(createdDocs.length).toBeGreaterThan(0);

    // 2. Poll for the rejection event
    // The dispatcher should write a document with eventType "shopify/rejected" and the same requestId.
    console.log(
      `⏳ Waiting for rejection event for requestId: ${requestId}...`,
    );

    await expect
      .poll(
        async () => {
          for (const firestoreProjectId of firestoreProjects) {
            const firestoreUrl = `http://${firestoreHost}/v1/projects/${firestoreProjectId}/databases/(default)/documents/sync`;
            const queryResponse = await page.request.get(
              `${firestoreUrl}?mask.fieldPaths=eventType&mask.fieldPaths=requestId&mask.fieldPaths=requestEventId&mask.fieldPaths=payload`,
              {
                headers: {
                  Authorization: "Bearer owner",
                },
              }
            );
            if (!queryResponse.ok()) continue;

            const body = await queryResponse.json();
            const documents = body.documents || [];
            const expectedDocIds = createdDocs
              .filter((d) => d.projectId === firestoreProjectId)
              .map((d) => d.docId);
            const match = documents.find((doc: any) => {
              const fields = doc.fields || {};
              const requestEventId = fields.requestEventId?.stringValue;
              return (
                (fields.requestId?.stringValue === requestId ||
                  expectedDocIds.includes(requestEventId)) &&
                fields.eventType?.stringValue === "shopify/rejected"
              );
            });
            if (match) return { firestoreProjectId, match };
          }
          return null;
        },
        {
          message: "Wait for rejection event in Firestore",
          timeout: 30000,
          intervals: [1000],
        },
      )
      .toBeTruthy();

    // 3. Verify the rejection details
    let rejection: any = null;
    for (const firestoreProjectId of firestoreProjects) {
      const firestoreUrl = `http://${firestoreHost}/v1/projects/${firestoreProjectId}/databases/(default)/documents/sync`;
      const finalQueryResponse = await page.request.get(
        `${firestoreUrl}?mask.fieldPaths=eventType&mask.fieldPaths=requestId&mask.fieldPaths=requestEventId&mask.fieldPaths=payload`,
        {
          headers: {
            Authorization: "Bearer owner",
          },
        }
      );
      if (!finalQueryResponse.ok()) continue;
      const body = await finalQueryResponse.json();
      const documents = body.documents || [];
      const expectedDocIds = createdDocs
        .filter((d) => d.projectId === firestoreProjectId)
        .map((d) => d.docId);
      rejection = documents.find((doc: any) => {
        const fields = doc.fields || {};
        const requestEventId = fields.requestEventId?.stringValue;
        return (
          (fields.requestId?.stringValue === requestId ||
            expectedDocIds.includes(requestEventId)) &&
          fields.eventType?.stringValue === "shopify/rejected"
        );
      });
      if (rejection) break;
    }

    expect(rejection, "Expected a rejection event to be written").toBeDefined();
    console.log("✅ Rejection event found in E2E!");
    const payload = rejection.fields.payload?.mapValue?.fields || {};
    expect(payload.errorCode?.stringValue).toBe("binary_payload_rejected");
  });
});
