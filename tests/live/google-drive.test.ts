import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as GoogleDrive from "../../src/lib/google-drive";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";

// Only run if @live annotation is present (handled by runner filter)
// but we also check for env vars to skip if not configured.

const isLiveConfigured =
  process.env.E2E_GOOGLE_CLIENT_ID &&
  process.env.E2E_GOOGLE_DRIVE_REFRESH_TOKEN;

describe.skipIf(!isLiveConfigured)("Google Drive Integration (@live)", () => {
  let accessToken: string;
  let driveRootId: string;
  let sandboxFolderId: string;

  beforeAll(async () => {
    // Setup Tokens from E2E Envs
    const clientId = process.env.E2E_GOOGLE_CLIENT_ID!;
    const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET!;
    const refreshToken = process.env.E2E_GOOGLE_DRIVE_REFRESH_TOKEN!;
    driveRootId = process.env.E2E_GOOGLE_DRIVE_FOLDER_ID!;

    // Generate Access Token
    const auth = new OAuth2Client(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    const tokenRes = await auth.getAccessToken();
    accessToken = tokenRes.token!;

    // Inject configuration into Module if needed?
    // The module uses import.meta.env for CLIENT_ID and FOLDER_ID.
    // We can't easily patch import.meta.env in runtime ESM without mocks.
    // However, for pure function calls that accept tokens/IDs, we are good.
    // For `uploadCSVToDrive` etc that read FOLDER_ID globally, we might fail if VITE_ var isn't set.
    // We can try to rely on the passed-in args for some, but others access internal vars.

    // Hack: Vitest allows definingenv? Or we just assume the test runner provides them.
    // Ideally we should pass FOLDER_ID to functions, but they use module-level constants.
    // We can verify "isDriveConfigured" returns false if vars are missing,
    // effectively testing strict logic.
    // But we want to test "upload" actually working.

    // IMPORTANT: The `google-drive.ts` file reads env vars at module load time.
    // If we want to test it, our environment must have those VITE_ vars set.
    // Validation:
    // expect(GoogleDrive.isDriveConfigured()).toBe(true);
    // If this fails, we need to fix test setup.

    // Create a sandbox for this test file
    const drive = google.drive({ version: "v3", auth });
    const res = await drive.files.create({
      requestBody: {
        name: `Test_Sandbox_${Date.now()}`,
        mimeType: "application/vnd.google-apps.folder",
        parents: [driveRootId],
      },
      fields: "id",
    });
    sandboxFolderId = res.data.id!;

    // We might need to MOCK the module's FOLDER_ID constant effectively?
    // Or just rely on `uploadImageToDrive` which takes folderId as arg!
    // `uploadCSVToDrive` takes NO folderId arg, uses global. This is a design limitation for testing.
    // We will skip testing `uploadCSVToDrive` or fix the code to accept it.
    // `uploadImageToDrive` accepts folderId. Excellent.
  });

  afterAll(async () => {
    // Cleanup Sandbox
    if (sandboxFolderId) {
      const clientId = process.env.E2E_GOOGLE_CLIENT_ID!;
      const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET!;
      const refreshToken = process.env.E2E_GOOGLE_DRIVE_REFRESH_TOKEN!;
      const auth = new OAuth2Client(clientId, clientSecret);
      auth.setCredentials({ refresh_token: refreshToken });
      const drive = google.drive({ version: "v3", auth });
      await drive.files.delete({ fileId: sandboxFolderId });
    }
  });

  it("should list files in the sandbox", async () => {
    // We can't use `listFilesInFolder` because it uses global FOLDER_ID.
    // But we can test `findFolder` passing our sandbox as parent.
    const found = await GoogleDrive.findFolder(
      "NonExistent",
      sandboxFolderId,
      accessToken,
    );
    expect(found).toBeNull();
  });

  it("should create a subfolder", async () => {
    const subId = await GoogleDrive.createFolder(
      "SubTest",
      sandboxFolderId,
      accessToken,
    );
    expect(subId).toBeDefined();

    // Verify it exists
    const foundId = await GoogleDrive.findFolder(
      "SubTest",
      sandboxFolderId,
      accessToken,
    );
    expect(foundId).toBe(subId);
  });

  it("should upload and download a file", async () => {
    const filename = `test-image-${Date.now()}.txt`;
    const content = "Hello World Live Test";
    const blob = new Blob([content], { type: "text/plain" });

    const fileInfo = await GoogleDrive.uploadImageToDrive(
      blob,
      filename,
      sandboxFolderId,
      accessToken,
    );

    expect(fileInfo.id).toBeDefined();
    expect(fileInfo.name).toBe(filename);
    expect(fileInfo.webViewLink).toBeDefined();

    // Test Download
    const downloadedContent = await GoogleDrive.downloadFile(
      fileInfo.id,
      accessToken,
    );
    expect(downloadedContent).toBe(content);
  });

  it("should set file permissions", async () => {
    const filename = `perm-test-${Date.now()}.txt`;
    const blob = new Blob(["public"], { type: "text/plain" });
    // Upload helper sets permissions, but let's test explicit call if we can separated
    const fileInfo = await GoogleDrive.uploadImageToDrive(
      blob,
      filename,
      sandboxFolderId,
      accessToken,
    );

    // It's already set by upload, but let's call it again to ensure no error
    await expect(
      GoogleDrive.setFilePermissions(fileInfo.id, accessToken),
    ).resolves.not.toThrow();
  }, 15000);
});
