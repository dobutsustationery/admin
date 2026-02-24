import { test, expect } from "../fixtures/auth";

test.describe("Sync Payload Validation", () => {
  test("should reject sync events with binary data or large payloads", async ({ page }) => {
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
                largeData: { stringValue: largeString }
              }
            }
          }
        }
      }
    });

    expect(response.ok()).toBe(true);
    console.log(`✓ Added large payload sync event: ${requestId}`);

    // 2. Poll for the rejection event
    // The dispatcher should write a document with eventType "shopify/rejected" and the same requestId.
    let found = false;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1000);
      const queryResponse = await page.request.get(`${firestoreUrl}?mask.fieldPaths=eventType&mask.fieldPaths=requestId&mask.fieldPaths=payload`);
      if (queryResponse.ok()) {
        const body = await queryResponse.json();
        const documents = body.documents || [];
        const rejection = documents.find((doc: any) => {
          const fields = doc.fields || {};
          return fields.requestId?.stringValue === requestId && 
                 fields.eventType?.stringValue === "shopify/rejected";
        });
        
        if (rejection) {
          console.log("✅ Rejection event found in E2E!");
          const payload = rejection.fields.payload?.mapValue?.fields || {};
          expect(payload.errorCode?.stringValue).toBe("binary_payload_rejected");
          found = true;
          break;
        }
      }
    }

    expect(found).toBe(true);
  });
});
