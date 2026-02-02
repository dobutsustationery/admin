import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const REQUIRED_ENV_VARS = [
  "E2E_GOOGLE_CLIENT_ID",
  "E2E_GOOGLE_CLIENT_SECRET",
  "E2E_GOOGLE_DRIVE_REFRESH_TOKEN",
  "E2E_GOOGLE_DRIVE_FOLDER_ID",
  "E2E_GOOGLE_PHOTOS_REFRESH_TOKEN",
  "E2E_GOOGLE_PHOTOS_ALBUM_ID",
];

const MANIFEST_PATH = path.resolve(process.cwd(), "e2e/fixtures/google-media-manifest.json");
const DEFAULT_FIXTURE_DIR = path.resolve(process.cwd(), "e2e/fixtures/photo-data");
const DRIVE_SEED_FOLDER_NAME = "Seed";

type FixtureEntry = {
  id: string;
  filename: string;
  sha256?: string;
  localPath?: string;
  driveFileId?: string;
  photosMediaItemId?: string;
};

type Manifest = {
  fixtures: FixtureEntry[];
};

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function sha256ForFile(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const bytes = fs.readFileSync(filePath);
  hash.update(bytes);
  return hash.digest("hex");
}

function inferMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".heic" || ext === ".heif") return "image/heic";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function loadManifest(): Manifest {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found at ${MANIFEST_PATH}`);
  }
  const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")) as Partial<Manifest>;
  const fixtures = Array.isArray(parsed.fixtures) ? parsed.fixtures : [];
  return { fixtures };
}

function writeManifest(manifest: Manifest) {
  const sorted = [...manifest.fixtures].sort((a, b) => a.filename.localeCompare(b.filename));
  fs.writeFileSync(
    MANIFEST_PATH,
    `${JSON.stringify({ fixtures: sorted }, null, 2)}\n`,
    "utf8",
  );
}

async function ensureDriveSeedFolder(
  drive: ReturnType<typeof google.drive>,
  driveRootId: string,
): Promise<string> {
  const q = `'${driveRootId}' in parents and name = '${DRIVE_SEED_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const listRes = await drive.files.list({ q, fields: "files(id)", pageSize: 1 });
  if (listRes.data.files && listRes.data.files.length > 0) {
    const existing = listRes.data.files[0].id;
    if (!existing) throw new Error("Drive returned Seed folder without id.");
    console.log(`✅ Found Seed folder: ${existing}`);
    return existing;
  }

  console.log("🌱 Creating Seed folder...");
  const createRes = await drive.files.create({
    requestBody: {
      name: DRIVE_SEED_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
      parents: [driveRootId],
    },
    fields: "id",
  });
  if (!createRes.data.id) throw new Error("Drive did not return created Seed folder id.");
  console.log(`✅ Created Seed folder: ${createRes.data.id}`);
  return createRes.data.id;
}

async function listPhotosAlbumItems(
  accessToken: string,
  albumId: string,
): Promise<Map<string, string>> {
  const byFilename = new Map<string, string>();
  let nextPageToken = "";

  while (true) {
    const response = await fetch("https://photoslibrary.googleapis.com/v1/mediaItems:search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        albumId,
        pageSize: 100,
        ...(nextPageToken ? { pageToken: nextPageToken } : {}),
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Photos mediaItems:search failed: ${response.status} ${text}`);
    }

    const payload = (await response.json()) as {
      mediaItems?: Array<{ id?: string; filename?: string }>;
      nextPageToken?: string;
    };

    for (const item of payload.mediaItems || []) {
      if (item.filename && item.id) byFilename.set(item.filename, item.id);
    }

    if (!payload.nextPageToken) break;
    nextPageToken = payload.nextPageToken;
  }

  return byFilename;
}

async function uploadToPhotos(
  accessToken: string,
  albumId: string,
  fixtureFilePath: string,
  filename: string,
): Promise<string> {
  const uploadResponse = await fetch("https://photoslibrary.googleapis.com/v1/uploads", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "X-Goog-Upload-Content-Type": inferMimeType(filename),
      "X-Goog-Upload-File-Name": filename,
      "X-Goog-Upload-Protocol": "raw",
    },
    body: fs.readFileSync(fixtureFilePath),
  });

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text();
    throw new Error(`Photos upload failed: ${uploadResponse.status} ${text}`);
  }

  const uploadToken = (await uploadResponse.text()).trim();
  if (!uploadToken) throw new Error("Photos upload did not return an upload token.");

  const createResponse = await fetch("https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      albumId,
      newMediaItems: [
        {
          simpleMediaItem: {
            uploadToken,
            fileName: filename,
          },
        },
      ],
    }),
  });

  if (!createResponse.ok) {
    const text = await createResponse.text();
    throw new Error(`Photos batchCreate failed: ${createResponse.status} ${text}`);
  }

  const created = (await createResponse.json()) as {
    newMediaItemResults?: Array<{
      mediaItem?: { id?: string };
      status?: { code?: number; message?: string };
    }>;
  };
  const result = created.newMediaItemResults?.[0];
  if (result?.status?.code && result.status.code !== 0) {
    throw new Error(`Photos batchCreate status ${result.status.code}: ${result.status.message || "unknown error"}`);
  }
  const mediaItemId = result?.mediaItem?.id;
  if (!mediaItemId) throw new Error("Photos batchCreate did not return media item id.");
  return mediaItemId;
}

function getFixtureLocalPath(fixture: FixtureEntry): string {
  const fallback = path.join(DEFAULT_FIXTURE_DIR, fixture.filename);
  const requested = fixture.localPath
    ? path.resolve(process.cwd(), fixture.localPath)
    : fallback;
  return requested;
}

async function main() {
  const missingVars = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);
  if (missingVars.length > 0) {
    console.error("❌ Missing required environment variables:", missingVars.join(", "));
    process.exit(1);
  }

  const manifest = loadManifest();
  if (manifest.fixtures.length === 0) {
    console.log("ℹ️ No fixtures defined in manifest. Nothing to sync.");
    return;
  }

  console.log(`📦 Syncing ${manifest.fixtures.length} fixtures...`);

  const clientId = process.env.E2E_GOOGLE_CLIENT_ID as string;
  const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET as string;
  const driveRefreshToken = process.env.E2E_GOOGLE_DRIVE_REFRESH_TOKEN as string;
  const photosRefreshToken = process.env.E2E_GOOGLE_PHOTOS_REFRESH_TOKEN as string;
  const driveRootId = process.env.E2E_GOOGLE_DRIVE_FOLDER_ID as string;
  const photosAlbumId = process.env.E2E_GOOGLE_PHOTOS_ALBUM_ID as string;

  const driveAuth = new OAuth2Client(clientId, clientSecret);
  driveAuth.setCredentials({ refresh_token: driveRefreshToken });
  const drive = google.drive({ version: "v3", auth: driveAuth });

  const photosAuth = new OAuth2Client(clientId, clientSecret);
  photosAuth.setCredentials({ refresh_token: photosRefreshToken });
  const tokenRes = await photosAuth.getAccessToken();
  if (!tokenRes.token) throw new Error("Failed to obtain Photos access token.");
  const photosAccessToken = tokenRes.token;

  const seedFolderId = await ensureDriveSeedFolder(drive, driveRootId);
  const photosItemsByFilename = await listPhotosAlbumItems(photosAccessToken, photosAlbumId);

  let updated = false;
  let success = true;

  for (const fixture of manifest.fixtures) {
    const localPath = getFixtureLocalPath(fixture);
    if (!fs.existsSync(localPath)) {
      console.error(`❌ [${fixture.id}] Missing local file: ${localPath}`);
      success = false;
      continue;
    }

    const computedSha256 = sha256ForFile(localPath);
    if (fixture.sha256 && fixture.sha256 !== computedSha256) {
      console.error(
        `❌ [${fixture.id}] SHA mismatch for ${fixture.filename}; manifest=${fixture.sha256}, local=${computedSha256}`,
      );
      success = false;
      continue;
    }
    if (!fixture.sha256) {
      fixture.sha256 = computedSha256;
      updated = true;
    }

    const safeFilename = escapeDriveQueryValue(fixture.filename);
    const fileQ = `'${seedFolderId}' in parents and name = '${safeFilename}' and trashed = false`;

    try {
      const fileRes = await drive.files.list({
        q: fileQ,
        fields: "files(id, name)",
        pageSize: 1,
      });

      let driveFileId = fileRes.data.files?.[0]?.id || "";
      if (!driveFileId) {
        console.log(`⬆️ [${fixture.id}] Uploading to Drive: ${fixture.filename}`);
        const uploadRes = await drive.files.create({
          requestBody: {
            name: fixture.filename,
            parents: [seedFolderId],
          },
          media: {
            mimeType: inferMimeType(fixture.filename),
            body: fs.createReadStream(localPath),
          },
          fields: "id",
        });
        driveFileId = uploadRes.data.id || "";
        if (!driveFileId) throw new Error("Drive upload did not return file id.");
      }
      if (fixture.driveFileId !== driveFileId) {
        fixture.driveFileId = driveFileId;
        updated = true;
      }
      console.log(`✅ [${fixture.id}] Drive ready: ${fixture.filename}`);
    } catch (e: any) {
      console.error(`❌ [${fixture.id}] Drive sync failed for ${fixture.filename}:`, e.message);
      success = false;
      continue;
    }

    try {
      let photosMediaItemId = photosItemsByFilename.get(fixture.filename) || "";
      if (!photosMediaItemId) {
        console.log(`⬆️ [${fixture.id}] Uploading to Photos: ${fixture.filename}`);
        photosMediaItemId = await uploadToPhotos(
          photosAccessToken,
          photosAlbumId,
          localPath,
          fixture.filename,
        );
        photosItemsByFilename.set(fixture.filename, photosMediaItemId);
      }
      if (fixture.photosMediaItemId !== photosMediaItemId) {
        fixture.photosMediaItemId = photosMediaItemId;
        updated = true;
      }
      console.log(`✅ [${fixture.id}] Photos ready: ${fixture.filename}`);
    } catch (e: any) {
      console.error(`❌ [${fixture.id}] Photos sync failed for ${fixture.filename}:`, e.message);
      success = false;
    }
  }

  if (updated) {
    writeManifest(manifest);
    console.log(`📝 Updated manifest: ${MANIFEST_PATH}`);
  }

  if (!success) {
    console.error("⚠️ Some fixtures failed to sync.");
    process.exit(1);
  }

  console.log("🎉 All seed fixtures synced to Drive + Photos.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
