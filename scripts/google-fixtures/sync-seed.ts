import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

const REQUIRED_ENV_VARS = [
  "E2E_GOOGLE_CLIENT_ID",
  "E2E_GOOGLE_CLIENT_SECRET",
  "E2E_GOOGLE_DRIVE_REFRESH_TOKEN",
  "E2E_GOOGLE_DRIVE_FOLDER_ID",
  "E2E_GOOGLE_PHOTOS_REFRESH_TOKEN",
];

const MANIFEST_PATH = path.resolve(
  process.cwd(),
  "e2e/fixtures/google-media-manifest.json",
);
const DEFAULT_FIXTURE_DIR = path.resolve(process.cwd(), "e2e/fixtures/photo-data");
const LIVE_ENV_PATH = path.resolve(process.cwd(), ".env.live.local");
const DRIVE_SEED_FOLDER_NAME = "Seed";
const DEFAULT_FIXTURE_ALBUM_TITLE = "DobutsuE2EFixtures";
const FIXTURE_DESCRIPTION_PREFIX = "DOBUTSU_FIXTURE:";

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

type AlbumMediaItem = {
  id: string;
  filename: string;
};

function parseFixtureLimit(): number | null {
  const arg = process.argv.find((entry) => entry.startsWith("--limit="));
  const rawArg = arg ? arg.split("=")[1] : "";
  const rawEnv = process.env.E2E_FIXTURE_SYNC_LIMIT || "";
  const raw = (rawArg || rawEnv || "").trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "all") return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Invalid fixture sync limit '${raw}'. Use a positive integer or 'all'.`,
    );
  }
  return value;
}

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
  const parsed = JSON.parse(
    fs.readFileSync(MANIFEST_PATH, "utf-8"),
  ) as Partial<Manifest>;
  const fixtures = Array.isArray(parsed.fixtures) ? parsed.fixtures : [];
  return { fixtures };
}

function writeManifest(manifest: Manifest) {
  const sorted = [...manifest.fixtures].sort((a, b) =>
    a.filename.localeCompare(b.filename),
  );
  fs.writeFileSync(
    MANIFEST_PATH,
    `${JSON.stringify({ fixtures: sorted }, null, 2)}\n`,
    "utf8",
  );
}

function upsertEnvVarFile(filePath: string, key: string, value: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) nextLines.push(`${key}=${value}`);
  fs.writeFileSync(
    filePath,
    `${nextLines.filter((line) => line.length > 0).join("\n")}\n`,
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

async function createPhotosAlbum(
  accessToken: string,
  title: string,
): Promise<string> {
  const response = await fetch("https://photoslibrary.googleapis.com/v1/albums", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ album: { title } }),
  });
  if (!response.ok) {
    throw new Error(
      `Photos album creation failed: ${response.status} ${await response.text()}`,
    );
  }
  const payload = (await response.json()) as { id?: string };
  const id = String(payload.id || "");
  if (!id) throw new Error("Photos album creation did not return an album id.");
  return id;
}

async function resolveConfiguredAlbumId(accessToken: string): Promise<string> {
  const configured = (process.env.E2E_GOOGLE_PHOTOS_ALBUM_ID || "").trim();
  if (configured) {
    const validateResponse = await fetch(
      `https://photoslibrary.googleapis.com/v1/albums/${configured}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    if (validateResponse.ok) return configured;
    if (validateResponse.status !== 400 && validateResponse.status !== 404) {
      throw new Error(
        `Configured E2E_GOOGLE_PHOTOS_ALBUM_ID is invalid (${configured}): ` +
          `${validateResponse.status} ${await validateResponse.text()}`,
      );
    }
    console.warn(
      `⚠️ Configured E2E_GOOGLE_PHOTOS_ALBUM_ID is stale/invalid (${configured}). Creating a new fixtures album...`,
    );
  }

  const created = await createPhotosAlbum(accessToken, DEFAULT_FIXTURE_ALBUM_TITLE);
  process.env.E2E_GOOGLE_PHOTOS_ALBUM_ID = created;
  upsertEnvVarFile(LIVE_ENV_PATH, "E2E_GOOGLE_PHOTOS_ALBUM_ID", created);
  console.log(
    `🆕 Created fixtures album ${created} and wrote E2E_GOOGLE_PHOTOS_ALBUM_ID to .env.live.local`,
  );
  return created;
}

async function listAlbumMediaItems(
  accessToken: string,
  albumId: string,
): Promise<AlbumMediaItem[]> {
  const items: AlbumMediaItem[] = [];
  let nextPageToken = "";
  while (true) {
    const response = await fetch(
      "https://photoslibrary.googleapis.com/v1/mediaItems:search",
      {
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
      },
    );

    if (!response.ok) {
      throw new Error(
        `Photos mediaItems:search failed: ${response.status} ${await response.text()}`,
      );
    }

    const payload = (await response.json()) as {
      mediaItems?: Array<{ id?: string; filename?: string }>;
      nextPageToken?: string;
    };
    for (const item of payload.mediaItems || []) {
      if (item.id && item.filename) {
        items.push({ id: item.id, filename: item.filename });
      }
    }

    if (!payload.nextPageToken) break;
    nextPageToken = payload.nextPageToken;
  }
  return items;
}

async function uploadToPhotos(
  accessToken: string,
  albumId: string,
  filePath: string,
  fileName: string,
  description?: string,
): Promise<string> {
  const uploadResponse = await fetch("https://photoslibrary.googleapis.com/v1/uploads", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "X-Goog-Upload-Content-Type": inferMimeType(fileName),
      "X-Goog-Upload-File-Name": fileName,
      "X-Goog-Upload-Protocol": "raw",
    },
    body: fs.readFileSync(filePath),
  });
  if (!uploadResponse.ok) {
    throw new Error(
      `Photos upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`,
    );
  }
  const uploadToken = (await uploadResponse.text()).trim();
  if (!uploadToken) throw new Error("Photos upload did not return an upload token.");

  const createResponse = await fetch(
    "https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        albumId,
        newMediaItems: [
          {
            ...(description ? { description } : {}),
            simpleMediaItem: {
              uploadToken,
              fileName,
            },
          },
        ],
      }),
    },
  );
  if (!createResponse.ok) {
    throw new Error(
      `Photos batchCreate failed: ${createResponse.status} ${await createResponse.text()}`,
    );
  }
  const payload = (await createResponse.json()) as {
    newMediaItemResults?: Array<{
      mediaItem?: { id?: string };
      status?: { code?: number; message?: string };
    }>;
  };
  const result = payload.newMediaItemResults?.[0];
  const statusCode = result?.status?.code || 0;
  const statusMessage = result?.status?.message || "";
  if (statusCode !== 0 && statusMessage !== "Success" && statusMessage !== "OK") {
    throw new Error(
      `Photos batchCreate status ${statusCode}: ${statusMessage || "unknown error"}`,
    );
  }
  const mediaItemId = result?.mediaItem?.id || "";
  if (!mediaItemId) throw new Error("Photos batchCreate did not return media item id.");
  return mediaItemId;
}

function toPhotosUploadName(sourceFileName: string): string {
  if (sourceFileName.toLowerCase().endsWith(".heic")) {
    return sourceFileName.replace(/\.heic$/i, ".jpg");
  }
  if (sourceFileName.toLowerCase().endsWith(".heif")) {
    return sourceFileName.replace(/\.heif$/i, ".jpg");
  }
  return sourceFileName;
}

function writeExifAsciiTag(
  buffer: Buffer,
  ifdOffset: number,
  entryIndex: number,
  tag: number,
  valueOffsetFromTiffStart: number,
  count: number,
) {
  const entryOffset = ifdOffset + 2 + entryIndex * 12;
  buffer.writeUInt16LE(tag, entryOffset);
  buffer.writeUInt16LE(2, entryOffset + 2); // ASCII
  buffer.writeUInt32LE(count, entryOffset + 4);
  buffer.writeUInt32LE(valueOffsetFromTiffStart, entryOffset + 8);
}

function writeExifLongTag(
  buffer: Buffer,
  ifdOffset: number,
  entryIndex: number,
  tag: number,
  value: number,
) {
  const entryOffset = ifdOffset + 2 + entryIndex * 12;
  buffer.writeUInt16LE(tag, entryOffset);
  buffer.writeUInt16LE(4, entryOffset + 2); // LONG
  buffer.writeUInt32LE(1, entryOffset + 4);
  buffer.writeUInt32LE(value, entryOffset + 8);
}

function buildExifDateSegment(dateTime = "2000:01:01 00:00:00"): Buffer {
  const ascii = Buffer.from(`${dateTime}\0`, "ascii");

  const exifHeader = Buffer.from("Exif\0\0", "ascii");

  const tiff = Buffer.alloc(8);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(0x002a, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 starts immediately after TIFF header

  const ifd0Offset = 8;
  const ifd0Entries = 2;
  const ifd0Size = 2 + ifd0Entries * 12 + 4;
  const exifIfdOffset = ifd0Offset + ifd0Size;

  const exifIfdEntries = 2;
  const exifIfdSize = 2 + exifIfdEntries * 12 + 4;

  const stringsOffset = exifIfdOffset + exifIfdSize;
  const dateTimeOffset = stringsOffset;
  const dateTimeOriginalOffset = dateTimeOffset + ascii.length;
  const dateTimeDigitizedOffset = dateTimeOriginalOffset + ascii.length;

  const totalTiffBytes = dateTimeDigitizedOffset + ascii.length;
  const tiffPayload = Buffer.alloc(totalTiffBytes);
  tiff.copy(tiffPayload, 0);

  // IFD0 entries: DateTime + ExifIFDPointer
  tiffPayload.writeUInt16LE(ifd0Entries, ifd0Offset);
  writeExifAsciiTag(tiffPayload, ifd0Offset, 0, 0x0132, dateTimeOffset, ascii.length);
  writeExifLongTag(tiffPayload, ifd0Offset, 1, 0x8769, exifIfdOffset);
  tiffPayload.writeUInt32LE(0, ifd0Offset + 2 + ifd0Entries * 12); // no next IFD

  // Exif IFD entries: DateTimeOriginal + DateTimeDigitized
  tiffPayload.writeUInt16LE(exifIfdEntries, exifIfdOffset);
  writeExifAsciiTag(tiffPayload, exifIfdOffset, 0, 0x9003, dateTimeOriginalOffset, ascii.length);
  writeExifAsciiTag(tiffPayload, exifIfdOffset, 1, 0x9004, dateTimeDigitizedOffset, ascii.length);
  tiffPayload.writeUInt32LE(0, exifIfdOffset + 2 + exifIfdEntries * 12); // no next IFD

  ascii.copy(tiffPayload, dateTimeOffset);
  ascii.copy(tiffPayload, dateTimeOriginalOffset);
  ascii.copy(tiffPayload, dateTimeDigitizedOffset);

  const app1Payload = Buffer.concat([exifHeader, tiffPayload]);
  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffe1, 0); // APP1 marker
  segment.writeUInt16BE(app1Payload.length + 2, 2); // length includes these two bytes
  return Buffer.concat([segment, app1Payload]);
}

function stampJpegExifDate(filePath: string, dateTime = "2000:01:01 00:00:00") {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error(`Expected JPEG file when stamping EXIF date: ${filePath}`);
  }

  let offset = 2; // after SOI
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) {
      break;
    }
    if (offset + 4 > bytes.length) break;
    const segLen = bytes.readUInt16BE(offset + 2);
    if (segLen < 2) break;
    const next = offset + 2 + segLen;

    // Drop any existing EXIF APP1 segment so our timestamp is authoritative.
    if (
      marker === 0xe1 &&
      offset + 10 <= bytes.length &&
      bytes.subarray(offset + 4, offset + 10).toString("ascii") === "Exif\0\0"
    ) {
      const withoutExif = Buffer.concat([bytes.subarray(0, offset), bytes.subarray(next)]);
      fs.writeFileSync(filePath, withoutExif);
      return stampJpegExifDate(filePath, dateTime);
    }
    offset = next;
  }

  const exifSegment = buildExifDateSegment(dateTime);
  const stamped = Buffer.concat([bytes.subarray(0, 2), exifSegment, bytes.subarray(2)]);
  fs.writeFileSync(filePath, stamped);
  const jan1 = new Date("2000-01-01T00:00:00Z");
  fs.utimesSync(filePath, jan1, jan1);
}

function preparePhotosUploadAsset(
  sourcePath: string,
  sourceFileName: string,
  fixtureId: string,
): { filePath: string; fileName: string; cleanup: () => void } {
  const lower = sourceFileName.toLowerCase();
  if (!lower.endsWith(".heic") && !lower.endsWith(".heif")) {
    return { filePath: sourcePath, fileName: sourceFileName, cleanup: () => {} };
  }

  const outputName = toPhotosUploadName(sourceFileName);
  const outputPath = path.join(
    os.tmpdir(),
    `${path.parse(outputName).name}-${Date.now()}.jpg`,
  );
  const result = spawnSync("sips", ["-s", "format", "jpeg", sourcePath, "--out", outputPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `HEIC to JPEG conversion failed for ${sourceFileName}: ${result.stderr || result.stdout || "sips failed"}`,
    );
  }
  stampJpegExifDate(outputPath);
  // Avoid Photos content-dedupe collisions with older probe files by making bytes fixture-stable.
  fs.appendFileSync(outputPath, `\nDOBUTSU_FIXTURE_JPEG:${fixtureId}\n`, "utf8");

  return {
    filePath: outputPath,
    fileName: outputName,
    cleanup: () => {
      try {
        fs.unlinkSync(outputPath);
      } catch {
        // best effort
      }
    },
  };
}

function getFixtureLocalPath(fixture: FixtureEntry): string {
  const defaultPath = path.join(DEFAULT_FIXTURE_DIR, fixture.filename);
  return fixture.localPath
    ? path.resolve(process.cwd(), fixture.localPath)
    : defaultPath;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFilenamesInAlbum(
  accessToken: string,
  albumId: string,
  expectedFilenames: string[],
  timeoutMs = 60_000,
): Promise<{ visibleCount: number; missingFilenames: string[] }> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const items = await listAlbumMediaItems(accessToken, albumId);
    const visible = new Set(items.map((item) => item.filename));
    const missing = expectedFilenames.filter((name) => !visible.has(name));
    if (missing.length === 0) {
      return { visibleCount: items.length, missingFilenames: [] };
    }
    await sleep(2_000);
  }
  const items = await listAlbumMediaItems(accessToken, albumId);
  const visible = new Set(items.map((item) => item.filename));
  const missing = expectedFilenames.filter((name) => !visible.has(name));
  return { visibleCount: items.length, missingFilenames: missing };
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

  const limit = parseFixtureLimit();
  const fixturesToSync = limit
    ? manifest.fixtures.slice(0, Math.min(limit, manifest.fixtures.length))
    : manifest.fixtures;
  console.log(
    `📦 Syncing ${fixturesToSync.length} fixture(s)` +
      (limit ? ` (limit=${limit}, total=${manifest.fixtures.length})` : ` (total=${manifest.fixtures.length})`) +
      "...",
  );

  const clientId = process.env.E2E_GOOGLE_CLIENT_ID as string;
  const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET as string;
  const driveRefreshToken = process.env.E2E_GOOGLE_DRIVE_REFRESH_TOKEN as string;
  const photosRefreshToken = process.env.E2E_GOOGLE_PHOTOS_REFRESH_TOKEN as string;
  const driveRootId = process.env.E2E_GOOGLE_DRIVE_FOLDER_ID as string;

  const driveAuth = new OAuth2Client(clientId, clientSecret);
  driveAuth.setCredentials({ refresh_token: driveRefreshToken });
  const drive = google.drive({ version: "v3", auth: driveAuth });

  const photosAuth = new OAuth2Client(clientId, clientSecret);
  photosAuth.setCredentials({ refresh_token: photosRefreshToken });
  const photosToken = (await photosAuth.getAccessToken()).token;
  if (!photosToken) throw new Error("Failed to obtain Photos access token.");

  const photosAlbumId = await resolveConfiguredAlbumId(photosToken);
  console.log(`🎯 Using Photos fixture album: ${photosAlbumId}`);

  const seedFolderId = await ensureDriveSeedFolder(drive, driveRootId);
  const existingAlbumItems = await listAlbumMediaItems(photosToken, photosAlbumId);
  const albumIds = new Set(existingAlbumItems.map((item) => item.id));
  const albumFilenameById = new Map(existingAlbumItems.map((item) => [item.id, item.filename]));
  const albumByFilename = new Map(existingAlbumItems.map((item) => [item.filename, item.id]));

  let updated = false;
  let success = true;

  for (const fixture of fixturesToSync) {
    const localPath = getFixtureLocalPath(fixture);
    if (!fs.existsSync(localPath)) {
      console.error(`❌ [${fixture.id}] Missing local file: ${localPath}`);
      success = false;
      continue;
    }

    const computedSha = sha256ForFile(localPath);
    if (fixture.sha256 && fixture.sha256 !== computedSha) {
      console.error(
        `❌ [${fixture.id}] SHA mismatch for ${fixture.filename}; manifest=${fixture.sha256}, local=${computedSha}`,
      );
      success = false;
      continue;
    }
    if (!fixture.sha256) {
      fixture.sha256 = computedSha;
      updated = true;
    }

    const safeName = escapeDriveQueryValue(fixture.filename);
    const driveQuery = `'${seedFolderId}' in parents and name = '${safeName}' and trashed = false`;
    try {
      const driveRes = await drive.files.list({
        q: driveQuery,
        fields: "files(id)",
        pageSize: 1,
      });
      let driveFileId = driveRes.data.files?.[0]?.id || "";
      if (!driveFileId) {
        console.log(`⬆️ [${fixture.id}] Uploading to Drive: ${fixture.filename}`);
        const uploadRes = await drive.files.create({
          requestBody: { name: fixture.filename, parents: [seedFolderId] },
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
    } catch (err: any) {
      console.error(`❌ [${fixture.id}] Drive sync failed for ${fixture.filename}:`, err.message);
      success = false;
      continue;
    }

    try {
      let photosMediaItemId = "";
      const prepared = preparePhotosUploadAsset(localPath, fixture.filename, fixture.id);
      try {
        const expectedName = prepared.fileName;
        if (
          fixture.photosMediaItemId &&
          albumIds.has(fixture.photosMediaItemId) &&
          albumFilenameById.get(fixture.photosMediaItemId) === expectedName
        ) {
          photosMediaItemId = fixture.photosMediaItemId;
        }

        if (!photosMediaItemId) {
          photosMediaItemId = albumByFilename.get(expectedName) || "";
        }

        if (!photosMediaItemId) {
          console.log(`⬆️ [${fixture.id}] Uploading to Photos: ${expectedName}`);
          photosMediaItemId = await uploadToPhotos(
            photosToken,
            photosAlbumId,
            prepared.filePath,
            expectedName,
            `${FIXTURE_DESCRIPTION_PREFIX}${fixture.id}`,
          );
          albumByFilename.set(expectedName, photosMediaItemId);
          albumFilenameById.set(photosMediaItemId, expectedName);
        }
      } finally {
        prepared.cleanup();
      }

      if (!photosMediaItemId) {
        throw new Error("Could not resolve photos media item id.");
      }
      if (fixture.photosMediaItemId !== photosMediaItemId) {
        fixture.photosMediaItemId = photosMediaItemId;
        updated = true;
      }
      albumIds.add(photosMediaItemId);
      console.log(`✅ [${fixture.id}] Photos ready: ${fixture.filename}`);
    } catch (err: any) {
      console.error(`❌ [${fixture.id}] Photos sync failed for ${fixture.filename}:`, err.message);
      success = false;
    }
  }

  if (updated) {
    writeManifest(manifest);
    console.log(`📝 Updated manifest: ${MANIFEST_PATH}`);
  }

  const expectedFilenames = fixturesToSync.map((fixture) =>
    toPhotosUploadName(fixture.filename),
  );
  if (
    fixturesToSync.some((fixture) => !fixture.photosMediaItemId || fixture.photosMediaItemId.length === 0)
  ) {
    console.error("❌ Photos sync did not produce media item ids for all fixtures.");
    process.exit(1);
  }

  console.log("⏱️ Waiting for Photos indexing...");
  const visibility = await waitForFilenamesInAlbum(
    photosToken,
    photosAlbumId,
    expectedFilenames,
  );
  if (visibility.missingFilenames.length > 0) {
    console.error(
      "❌ Photos album visibility check failed. " +
        `Album ${photosAlbumId} is missing ${visibility.missingFilenames.length}/${expectedFilenames.length} expected fixture filename(s): ` +
        visibility.missingFilenames.join(", "),
    );
    process.exit(1);
  }
  console.log(
    `ℹ️ Photos album visibility confirmed via mediaItems:search: ` +
      `${expectedFilenames.length}/${expectedFilenames.length} fixture filenames visible (album item count snapshot=${visibility.visibleCount}).`,
  );

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
