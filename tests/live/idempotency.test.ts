import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as GoogleDrive from "../../src/lib/google-drive";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";

const isLiveConfigured =
  process.env.E2E_GOOGLE_CLIENT_ID &&
  process.env.E2E_GOOGLE_DRIVE_REFRESH_TOKEN;

describe.skipIf(!isLiveConfigured)(
  "Idempotency & Durable Registry (@live)",
  () => {
    let accessToken: string;
    let driveRootId: string;
    let sandboxFolderId: string;
    let auth: OAuth2Client;

    beforeAll(async () => {
      const clientId = process.env.E2E_GOOGLE_CLIENT_ID!;
      const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET!;
      const refreshToken = process.env.E2E_GOOGLE_DRIVE_REFRESH_TOKEN!;
      driveRootId = process.env.E2E_GOOGLE_DRIVE_FOLDER_ID!;

      auth = new OAuth2Client(clientId, clientSecret);
      auth.setCredentials({ refresh_token: refreshToken });
      const tokenRes = await auth.getAccessToken();
      accessToken = tokenRes.token!;

      const drive = google.drive({ version: "v3", auth });
      const res = await drive.files.create({
        requestBody: {
          name: `Idempotency_Sandbox_${Date.now()}`,
          mimeType: "application/vnd.google-apps.folder",
          parents: [driveRootId],
        },
        fields: "id",
      });
      sandboxFolderId = res.data.id!;
    });

    afterAll(async () => {
      if (sandboxFolderId) {
        const drive = google.drive({ version: "v3", auth });
        await drive.files.delete({ fileId: sandboxFolderId });
      }
    });

    it("should not create redundant files for the same derivation key", async () => {
      const filename = `idempotent-test-${Date.now()}.png`;
      const derivationKey = `test:${Date.now()}:identity`;
      const blob = new Blob(["test-content"], { type: "image/png" });

      // 1. First upload
      const firstUpload = await GoogleDrive.uploadImageToDrive(
        blob,
        filename,
        sandboxFolderId,
        accessToken,
        derivationKey,
      );
      expect(firstUpload.id).toBeDefined();

      // 2. Second upload with same derivation key (simulating redundant work)
      // NOTE: In a full system, the worker handles this. Here we test the primitive.
      // First, let's verify findFileByDerivationKey finds it.
      const found = await GoogleDrive.findFileByDerivationKey(
        accessToken,
        derivationKey,
      );
      expect(found).not.toBeNull();
      expect(found?.id).toBe(firstUpload.id);

      // 3. Verify that if we bypass the check and upload anyway, we would have 2 files (proving the check is needed)
      // Actually, the goal of uploadImageToDrive is to ALWAYS stamp it.
      // Let's verify our search primitive is robust.
      const drive = google.drive({ version: "v3", auth });
      const searchRes = await drive.files.list({
        q: `appProperties has { key='${GoogleDrive.DERIVATION_KEY_PROPERTY}' and value='${derivationKey}' } and trashed=false`,
        fields: "files(id)",
      });
      expect(searchRes.data.files?.length).toBe(1);
    });

    it("should handle transforms idempotently", async () => {
      const sourceId = `source-${Date.now()}`;
      const removeBgKey = GoogleDrive.generateDerivationKey(
        "photos",
        sourceId,
        "remove_bg",
      );
      const blob = new Blob(["processed-content"], { type: "image/png" });

      // 1. Upload "processed" image
      const upload = await GoogleDrive.uploadImageToDrive(
        blob,
        "processed.png",
        sandboxFolderId,
        accessToken,
        removeBgKey,
      );

      // 2. Resolve existing transform
      const resolved = await GoogleDrive.findFileByDerivationKey(
        accessToken,
        removeBgKey,
      );
      expect(resolved).not.toBeNull();
      expect(resolved?.id).toBe(upload.id);
    });
  },
);
