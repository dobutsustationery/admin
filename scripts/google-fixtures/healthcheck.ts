import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import fs from "fs";
import path from "path";

const REQUIRED_ENV_VARS = [
  "E2E_GOOGLE_CLIENT_ID",
  "E2E_GOOGLE_CLIENT_SECRET",
  "E2E_GOOGLE_DRIVE_REFRESH_TOKEN",
  "E2E_GOOGLE_PHOTOS_REFRESH_TOKEN",
  "E2E_GOOGLE_DRIVE_FOLDER_ID",
  "E2E_GOOGLE_PHOTOS_ALBUM_ID",
];

const REQUIRED_UNIFIED_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];
const REQUIRED_PHOTOS_API_SCOPES = [
  "https://www.googleapis.com/auth/photoslibrary.readonly",
];

const MANIFEST_PATH = path.resolve(
  process.cwd(),
  "e2e/fixtures/google-media-manifest.json",
);
const LIVE_ENV_PATH = path.resolve(process.cwd(), ".env.live.local");

type Manifest = {
  fixtures?: Array<{ filename?: string }>;
};

function loadLiveLocalEnvOverrides() {
  if (!fs.existsSync(LIVE_ENV_PATH)) return;
  const lines = fs.readFileSync(LIVE_ENV_PATH, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    // .env.live.local should be the source of truth for live fixture tooling.
    process.env[key] = value;
  }
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

function loadExpectedFixtureFilenames(): Set<string> {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Fixture manifest not found at ${MANIFEST_PATH}`);
  }
  const manifest = JSON.parse(
    fs.readFileSync(MANIFEST_PATH, "utf8"),
  ) as Manifest;
  const filenames = new Set(
    (manifest.fixtures || [])
      .map((f) => toPhotosUploadName((f.filename || "").trim()))
      .filter((f) => f.length > 0),
  );
  if (filenames.size === 0) {
    throw new Error(`Fixture manifest has no filenames at ${MANIFEST_PATH}`);
  }
  return filenames;
}

async function listAlbumItemsViaSearch(
  accessToken: string,
  albumId: string,
): Promise<Array<{ id: string; filename: string }>> {
  const items: Array<{ id: string; filename: string }> = [];
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
      if (item.id && item.filename)
        items.push({ id: item.id, filename: item.filename });
    }
    if (!payload.nextPageToken) break;
    nextPageToken = payload.nextPageToken;
  }
  return items;
}

async function getTokenScopes(accessToken: string): Promise<Set<string>> {
  const tokenInfoResponse = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
  );
  if (!tokenInfoResponse.ok) {
    throw new Error(
      `tokeninfo failed: ${tokenInfoResponse.status} ${await tokenInfoResponse.text()}`,
    );
  }
  const tokenInfo = (await tokenInfoResponse.json()) as { scope?: string };
  return new Set((tokenInfo.scope || "").split(/\s+/).filter(Boolean));
}

function missingScopes(scopeSet: Set<string>, required: string[]): string[] {
  return required.filter((scope) => !scopeSet.has(scope));
}

async function main() {
  console.log("🏥 Starting E2E Environment Health Check...");
  loadLiveLocalEnvOverrides();

  const missingVars = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);
  if (missingVars.length > 0) {
    const suffix = missingVars.includes("E2E_GOOGLE_PHOTOS_ALBUM_ID")
      ? " Run npm run fixtures:google:sync once to auto-create and persist a fixtures album ID."
      : "";
    console.error(
      "❌ Missing required environment variables:",
      `${missingVars.join(", ")}.${suffix}`,
    );
    process.exit(1);
  }
  console.log("✅ All environment variables present.");

  const clientId = process.env.E2E_GOOGLE_CLIENT_ID as string;
  const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET as string;
  const driveRefreshToken = process.env
    .E2E_GOOGLE_DRIVE_REFRESH_TOKEN as string;
  const photosRefreshToken = process.env
    .E2E_GOOGLE_PHOTOS_REFRESH_TOKEN as string;
  const driveRootId = process.env.E2E_GOOGLE_DRIVE_FOLDER_ID as string;
  const photosAlbumId = (
    process.env.E2E_GOOGLE_PHOTOS_ALBUM_ID as string
  ).trim();
  const expectedFilenames = loadExpectedFixtureFilenames();

  console.log("Testing Drive Access...");
  let driveScopeSet = new Set<string>();
  try {
    const driveAuth = new OAuth2Client(clientId, clientSecret);
    driveAuth.setCredentials({ refresh_token: driveRefreshToken });
    const driveAccessToken = (await driveAuth.getAccessToken()).token;
    if (!driveAccessToken) {
      throw new Error(
        "Could not generate Drive access token from configured refresh token.",
      );
    }
    driveScopeSet = await getTokenScopes(driveAccessToken);
    const missingDriveFile = missingScopes(driveScopeSet, [
      "https://www.googleapis.com/auth/drive.file",
    ]);
    if (missingDriveFile.length > 0) {
      throw new Error(
        `Drive token is missing required scope(s): ${missingDriveFile.join(", ")}. ` +
          "Run: npm run setup:live:e2e",
      );
    }

    const drive = google.drive({ version: "v3", auth: driveAuth });
    const folder = await drive.files.get({
      fileId: driveRootId,
      fields: "id,name,trashed",
    });
    if (folder.data.trashed) {
      throw new Error("Drive root folder is in trash");
    }

    const rootImages = await drive.files.list({
      q: `'${driveRootId}' in parents and mimeType contains 'image/' and trashed = false`,
      fields: "files(id)",
      pageSize: 1,
    });
    const rootImageCount = rootImages.data.files?.length || 0;

    const seedFolder = await drive.files.list({
      q: `'${driveRootId}' in parents and name = 'Seed' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id)",
      pageSize: 1,
    });
    const seedFolderId = seedFolder.data.files?.[0]?.id;
    let seedImageCount = 0;
    if (seedFolderId) {
      const seedImages = await drive.files.list({
        q: `'${seedFolderId}' in parents and mimeType contains 'image/' and trashed = false`,
        fields: "files(id)",
        pageSize: 1,
      });
      seedImageCount = seedImages.data.files?.length || 0;
    }

    if (rootImageCount + seedImageCount === 0) {
      throw new Error(
        "Drive fixture folder has no images. Run: npm run fixtures:google:sync",
      );
    }

    console.log(
      `✅ Drive access confirmed. Root folder: "${folder.data.name}" (${folder.data.id}), fixture images present.`,
    );
  } catch (error: any) {
    console.error("❌ Drive access failed:", error.message);
    process.exit(1);
  }

  console.log("Testing Photos Access...");
  let photosScopeSet = new Set<string>();
  try {
    const photosAuth = new OAuth2Client(clientId, clientSecret);
    photosAuth.setCredentials({ refresh_token: photosRefreshToken });
    const tokenRes = await photosAuth.getAccessToken();
    const accessToken = tokenRes.token;
    if (!accessToken) throw new Error("Could not generate Photos access token");
    photosScopeSet = await getTokenScopes(accessToken);
    const missingPhotosApi = missingScopes(
      photosScopeSet,
      REQUIRED_PHOTOS_API_SCOPES,
    );
    if (missingPhotosApi.length > 0) {
      throw new Error(
        `Photos token is missing required scope(s): ${missingPhotosApi.join(", ")}. ` +
          "Run: npm run setup:live:e2e",
      );
    }

    const albumResponse = await fetch(
      `https://photoslibrary.googleapis.com/v1/albums/${photosAlbumId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!albumResponse.ok) {
      const text = await albumResponse.text();
      if (
        albumResponse.status === 403 &&
        text.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")
      ) {
        throw new Error(
          "Photos token is missing required scopes. Re-run: npm run setup:live:e2e",
        );
      }
      throw new Error(`Photos API returned ${albumResponse.status}: ${text}`);
    }
    const album = (await albumResponse.json()) as {
      id?: string;
      title?: string;
      mediaItemsCount?: string;
    };
    const metadataCount =
      Number.parseInt(String(album.mediaItemsCount || "0"), 10) || 0;
    const visibleItems = await listAlbumItemsViaSearch(
      accessToken,
      photosAlbumId,
    );
    const visibleCount = visibleItems.length;
    const unexpectedFilenames = Array.from(
      new Set(
        visibleItems
          .map((item) => item.filename)
          .filter((filename) => !expectedFilenames.has(filename)),
      ),
    );
    if (visibleCount === 0) {
      throw new Error(
        `Photos fixture album has 0 API-visible items via mediaItems:search ` +
          `(albumId=${photosAlbumId}, metadata=${metadataCount}). ` +
          `Delete this fixtures album and rerun npm run fixtures:google:sync.`,
      );
    }
    if (unexpectedFilenames.length > 0) {
      throw new Error(
        `Photos fixture album contains unexpected filename(s): ${unexpectedFilenames.join(", ")}. ` +
          `Delete this fixtures album and rerun npm run fixtures:google:sync.`,
      );
    }

    console.log(
      `✅ Photos access confirmed. Album: "${album.title}" (${album.id}), fixture media present (visible=${visibleCount}, metadata=${metadataCount}).`,
    );
  } catch (error: any) {
    console.error("❌ Photos access failed:", error.message);
    process.exit(1);
  }

  console.log("Validating unified auth scope coverage...");
  const splitMode = driveRefreshToken !== photosRefreshToken;
  const effectiveUnifiedScopes = splitMode
    ? new Set([...driveScopeSet, ...photosScopeSet])
    : photosScopeSet;
  const missingUnified = missingScopes(
    effectiveUnifiedScopes,
    REQUIRED_UNIFIED_SCOPES,
  );
  if (missingUnified.length > 0) {
    const modeHint = splitMode
      ? "split Drive+Photos tokens"
      : "single unified token";
    console.error(
      `❌ ${modeHint} is missing required unified scope(s): ${missingUnified.join(", ")}.`,
    );
    console.error("   Re-run: npm run setup:live:e2e");
    process.exit(1);
  }
  console.log(
    `✅ Unified scope coverage confirmed (${splitMode ? "split tokens" : "single token"}).`,
  );

  console.log("🎉 Health check passed! E2E environment is ready.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
