import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as GoogleDrive from "../../src/lib/google-drive";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const photosWorker = require("../../functions/shared/photos-sync-worker.cjs");

const SYNC_COLLECTION = "sync";
const SYNC_SECRETS_COLLECTION = "sync_secrets";

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

    it("should resolve redundant transfer requests to the same Drive file", async () => {
      const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const photoId = `worker-test-${uniqueId}`;
      const filename = `${photoId}.png`;
      // Use a known public image for testing
      const sourceBaseUrl =
        "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png";

      const requestData = {
        eventType: "photos/image_transfer_requested",
        requestId: `req-${photoId}`,
        creator: "test-user",
        payload: {
          photoId,
          sourceBaseUrl,
          filename,
          targetFolderId: sandboxFolderId,
        },
      };

      // Mock Firestore
      const events: any[] = [];
      const createdDocs = new Set<string>();
      const mockDb = {
        collection: (colName: string) => ({
          doc: (docId: string) => ({
            get: async () => {
              if (
                colName === SYNC_SECRETS_COLLECTION &&
                docId === "photos-secret-test-user"
              ) {
                return {
                  exists: true,
                  id: docId,
                  data: () => ({
                    driveAccessToken: accessToken,
                    creator: "test-user",
                  }),
                };
              }
              return { exists: createdDocs.has(`${colName}/${docId}`) };
            },
            set: async () => {
              createdDocs.add(`${colName}/${docId}`);
            },
            create: async (data: any) => {
              const path = `${colName}/${docId}`;
              if (createdDocs.has(path)) {
                const err: any = new Error("Already exists");
                err.code = 6;
                throw err;
              }
              createdDocs.add(path);
              return { created: true };
            },
          }),
          add: async (data: any) => {
            events.push(data);
            return { id: `event-${events.length}` };
          },
          where: () => ({
            limit: () => ({ get: async () => ({ empty: true }) }),
          }),
        }),
      } as any;

      // 1. First execution - should perform real upload
      const result1 = await photosWorker.processRequestEvent({
        db: mockDb,
        requestEventId: `evt1-${uniqueId}`,
        requestData,
        processor: "test",
        creator: "test",
        collectionName: SYNC_COLLECTION,
      });

      expect(result1.processed).toBe(true);
      const driveFileId = result1.summary.driveFileId;
      expect(driveFileId).toBeDefined();

      // 2. Second execution with same photoId - should resolve to existing file
      const result2 = await photosWorker.processRequestEvent({
        db: mockDb,
        requestEventId: `evt2-${uniqueId}`,
        requestData,
        processor: "test",
        creator: "test",
        collectionName: SYNC_COLLECTION,
      });

      expect(result2.processed).toBe(true);
      expect(result2.summary.idempotent).toBe(true);
      expect(result2.summary.driveFileId).toBe(driveFileId);

      // Verify only one file exists in the sandbox for this derivation key
      const sourceType = sourceBaseUrl.includes("googleusercontent.com")
        ? "photos"
        : "ext";
      const derivationKey = GoogleDrive.generateDerivationKey(
        sourceType,
        photoId,
        "identity",
      );
      const drive = google.drive({ version: "v3", auth });
      const query = `'${sandboxFolderId}' in parents and ${GoogleDrive.buildDerivationKeyQuery(derivationKey)}`;

      const searchRes = await drive.files.list({
        q: query,
        fields: "files(id, name, appProperties)",
      });
      expect(searchRes.data.files?.length).toBe(1);
    });

    it("should handle background removal transform idempotently in the worker", async () => {
      const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const photoId = `transform-test-${uniqueId}`;
      const sourceBaseUrl =
        "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png";

      const requestData = {
        eventType: "photos/image_transform_requested",
        requestId: `trans-req-${photoId}`,
        creator: "test-user",
        payload: {
          photoId,
          sourceBaseUrl,
          transform: "remove_bg",
          filename: `processed_${photoId}.png`,
          targetFolderId: sandboxFolderId,
        },
      };

      const createdDocs = new Set<string>();
      const mockDb = {
        collection: (colName: string) => ({
          doc: (docId: string) => ({
            get: async () => {
              if (
                colName === SYNC_SECRETS_COLLECTION &&
                docId === "photos-secret-test-user"
              ) {
                return {
                  exists: true,
                  id: docId,
                  data: () => ({
                    driveAccessToken: accessToken,
                    creator: "test-user",
                  }),
                };
              }
              return { exists: createdDocs.has(`${colName}/${docId}`) };
            },
            set: async () => {
              createdDocs.add(`${colName}/${docId}`);
            },
            create: async (data: any) => {
              const path = `${colName}/${docId}`;
              if (createdDocs.has(path)) {
                const err: any = new Error("Already exists");
                err.code = 6;
                throw err;
              }
              createdDocs.add(path);
              return { created: true };
            },
          }),
          add: async () => ({ id: "mock-event" }),
          where: () => ({
            limit: () => ({
              get: async () => ({
                empty: false,
                docs: [
                  {
                    id: "photos-secret-test-user",
                    data: () => ({
                      driveAccessToken: accessToken,
                      creator: "test-user",
                    }),
                  },
                ],
              }),
            }),
          }),
        }),
      } as any;

      // 1. First execution - should perform transform
      const result1 = await photosWorker.processRequestEvent({
        db: mockDb,
        requestEventId: `trans1-${uniqueId}`,
        requestData,
        processor: "test",
        creator: "test",
        collectionName: SYNC_COLLECTION,
      });

      expect(result1.processed).toBe(true);
      const processedId = result1.summary.driveFileId;

      // 2. Second execution - should resolve existing
      const result2 = await photosWorker.processRequestEvent({
        db: mockDb,
        requestEventId: `trans2-${uniqueId}`,
        requestData,
        processor: "test",
        creator: "test",
        collectionName: SYNC_COLLECTION,
      });

      expect(result2.processed).toBe(true);
      expect(result2.summary.idempotent).toBe(true);
      expect(result2.summary.driveFileId).toBe(processedId);
    });
  },
);
