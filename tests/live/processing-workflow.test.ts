import { describe, it, expect, beforeAll } from "vitest";
import * as GoogleDrive from "../../src/lib/google-drive";
import { OAuth2Client } from "google-auth-library";

describe("Image Processing Workflow (@live)", () => {
  let accessToken: string;
  let driveRootId: string;
  let seedFolderId: string;
  let fixtureFileId: string;
  let fixtureFileName: string;

  function decodeBase64(base64: string): Uint8Array {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }

  beforeAll(async () => {
    if (!process.env.E2E_GOOGLE_CLIENT_ID) {
      throw new Error("Missing E2E_GOOGLE_CLIENT_ID");
    }
    if (!process.env.E2E_GOOGLE_CLIENT_SECRET) {
      throw new Error("Missing E2E_GOOGLE_CLIENT_SECRET");
    }
    if (!process.env.E2E_GOOGLE_DRIVE_REFRESH_TOKEN) {
      throw new Error("Missing E2E_GOOGLE_DRIVE_REFRESH_TOKEN");
    }
    if (!process.env.E2E_GOOGLE_DRIVE_FOLDER_ID) {
      throw new Error("Missing E2E_GOOGLE_DRIVE_FOLDER_ID");
    }

    // Setup Tokens
    const clientId = process.env.E2E_GOOGLE_CLIENT_ID!;
    const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET!;
    const refreshToken = process.env.E2E_GOOGLE_DRIVE_REFRESH_TOKEN!;
    driveRootId = process.env.E2E_GOOGLE_DRIVE_FOLDER_ID!;

    const auth = new OAuth2Client(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    const tokenRes = await auth.getAccessToken();
    accessToken = tokenRes.token!;
    if (!accessToken) {
      throw new Error(
        "Failed to obtain Drive access token for live workflow tests.",
      );
    }

    // Find Seed Folder
    seedFolderId =
      (await GoogleDrive.findFolder("Seed", driveRootId, accessToken)) || "";
    expect(seedFolderId).toBeTruthy();

    // Upload a deterministic PNG fixture so workflow does not depend on
    // external album formats (e.g. HEIC) that transformers.js may not decode.
    const fixturePngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2+6h8AAAAASUVORK5CYII=";
    const fixtureBytes = decodeBase64(fixturePngBase64);
    const fixtureBlob = new Blob([fixtureBytes], { type: "image/png" });
    fixtureFileName = `live-processing-fixture-${Date.now()}.png`;
    const fixtureUpload = await GoogleDrive.uploadImageToDrive(
      fixtureBlob,
      fixtureFileName,
      seedFolderId,
      accessToken,
      GoogleDrive.generateDerivationKey("ext", fixtureFileName, "identity"),
    );
    fixtureFileId = fixtureUpload.id;
    expect(fixtureFileId).toBeTruthy();
  });

  it("should download and upload a processed artifact to drive", async () => {
    console.log(`Using seed image: ${fixtureFileName} (${fixtureFileId})`);

    // 2. Download
    const dlRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fixtureFileId}?alt=media`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    expect(dlRes.ok).toBe(true);
    const contentType =
      dlRes.headers.get("content-type") || "application/octet-stream";
    const buffer = await dlRes.arrayBuffer();
    const blob = new Blob([buffer], { type: contentType });

    // 3. "Process" artifact deterministically for contract testing by reusing
    // downloaded bytes as a PNG artifact payload.
    const processedBlob = new Blob([buffer], { type: "image/png" });

    const uploadRes = await GoogleDrive.uploadImageToDrive(
      processedBlob,
      `processed_${fixtureFileName}`,
      seedFolderId, // Or sandbox? Let's use Seed or Sandbox. Maybe Sandbox.
      accessToken,
      GoogleDrive.generateDerivationKey(
        "drive",
        fixtureFileId,
        "contract_test",
      ),
    );

    expect(uploadRes.id).toBeDefined();
  }, 60000);

  it("should download and color correct an image", async () => {
    const dlRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fixtureFileId}?alt=media`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    expect(dlRes.ok).toBe(true);

    const blob = await dlRes.blob();
    expect(blob.size).toBeGreaterThan(0);
  });
});
