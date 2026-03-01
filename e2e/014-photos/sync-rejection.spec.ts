import { test, expect } from "../fixtures/auth";

test.describe("Sync Payload Validation", () => {
  test("should reject sync events with binary data or large payloads", async ({
    page,
  }) => {
    const firestoreUrl = process.env.FIRESTORE_EMULATOR_HOST
      ? `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/dobutsu-admin/databases/(default)/documents/sync`
      : "http://localhost:8080/v1/projects/dobutsu-admin/databases/(default)/documents/sync";

    const requestId = `test-rejection-${Date.now()}`;
    const largeString = "A".repeat(11 * 1024); // > 10 KB

    // 1. Add a document with a large payload via Firestore REST API
    const response = await page.request.post(firestoreUrl, {
      data: {
        fields: {
          eventType: { stringValue: "shopify/sync_requested" },
          requestId: { stringValue: requestId },
          creator: { stringValue: "e2e-test" },
          createdAtMs: { integerValue: Date.now() },
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

    expect(response.ok()).toBe(true);
    console.log(`✓ Added large payload sync event: ${requestId}`);

    // 2. Poll for the rejection event
    // The dispatcher should write a document with eventType "shopify/rejected" and the same requestId.
    console.log(
      `⏳ Waiting for rejection event for requestId: ${requestId}...`,
    );

    await expect
      .poll(
        async () => {
          const queryResponse = await page.request.get(
            `${firestoreUrl}?mask.fieldPaths=eventType&mask.fieldPaths=requestId&mask.fieldPaths=payload`,
          );
          if (!queryResponse.ok()) return false;

          const body = await queryResponse.json();
          const documents = body.documents || [];
          return documents.find((doc: any) => {
            const fields = doc.fields || {};
            return (
              fields.requestId?.stringValue === requestId &&
              fields.eventType?.stringValue === "shopify/rejected"
            );
          });
        },
        {
          message: "Wait for rejection event in Firestore",
          timeout: 15000,
          intervals: [1000],
        },
      )
      .toBeTruthy();

    // 3. Verify the rejection details
    const finalQueryResponse = await page.request.get(
      `${firestoreUrl}?mask.fieldPaths=eventType&mask.fieldPaths=requestId&mask.fieldPaths=payload`,
    );
    const body = await finalQueryResponse.json();
    const documents = body.documents || [];
    const rejection = documents.find((doc: any) => {
      const fields = doc.fields || {};
      return (
        fields.requestId?.stringValue === requestId &&
        fields.eventType?.stringValue === "shopify/rejected"
      );
    });

    expect(rejection).toBeDefined();
    console.log("✅ Rejection event found in E2E!");
    const payload = rejection.fields.payload?.mapValue?.fields || {};
    expect(payload.errorCode?.stringValue).toBe("binary_payload_rejected");
  });
});
