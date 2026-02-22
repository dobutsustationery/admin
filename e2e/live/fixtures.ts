import { test as base } from '@playwright/test';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

type LiveFixtures = {
  sandboxId: string;
};

type StaticFixtureConfig = {
  driveFolderId: string;
  photosAlbumId: string;
};

let cachedStaticFixtureConfig: Promise<StaticFixtureConfig> | null = null;

function getConfiguredPhotosAlbumId(): string {
  return (process.env.E2E_GOOGLE_PHOTOS_ALBUM_ID || '').trim();
}

async function findDriveFolderIdByName(
  drive: ReturnType<typeof google.drive>,
  parentId: string,
  name: string,
): Promise<string | null> {
  const q =
    `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' ` +
    `and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const response = await drive.files.list({
    q,
    fields: 'files(id)',
    pageSize: 1,
  });
  const id = response.data.files?.[0]?.id;
  return id || null;
}

async function countDriveImagesInParent(
  drive: ReturnType<typeof google.drive>,
  parentId: string,
): Promise<number> {
  const q = `'${parentId}' in parents and mimeType contains 'image/' and trashed = false`;
  const response = await drive.files.list({
    q,
    fields: 'files(id)',
    pageSize: 10,
  });
  return response.data.files?.length || 0;
}

async function validatePermanentGoogleFixtures(): Promise<StaticFixtureConfig> {
  const clientId = process.env.E2E_GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET || '';
  const driveRefreshToken = process.env.E2E_GOOGLE_DRIVE_REFRESH_TOKEN || '';
  const photosRefreshToken = process.env.E2E_GOOGLE_PHOTOS_REFRESH_TOKEN || '';
  const driveFolderId = process.env.E2E_GOOGLE_DRIVE_FOLDER_ID || '';
  const photosAlbumId = getConfiguredPhotosAlbumId();

  const missing = [
    !clientId && 'E2E_GOOGLE_CLIENT_ID',
    !clientSecret && 'E2E_GOOGLE_CLIENT_SECRET',
    !driveRefreshToken && 'E2E_GOOGLE_DRIVE_REFRESH_TOKEN',
    !photosRefreshToken && 'E2E_GOOGLE_PHOTOS_REFRESH_TOKEN',
    !driveFolderId && 'E2E_GOOGLE_DRIVE_FOLDER_ID',
    !photosAlbumId && 'E2E_GOOGLE_PHOTOS_ALBUM_ID',
  ].filter(Boolean) as string[];
  if (missing.length > 0) {
    throw new Error(
      `Missing live fixture configuration: ${missing.join(', ')}. ` +
        `Live tests require permanent pre-seeded fixtures.`,
    );
  }

  const driveAuth = new OAuth2Client(clientId, clientSecret);
  driveAuth.setCredentials({ refresh_token: driveRefreshToken });
  const drive = google.drive({ version: 'v3', auth: driveAuth });

  const driveFolder = await drive.files.get({
    fileId: driveFolderId,
    fields: 'id,name,trashed',
  });
  if (driveFolder.data.trashed) {
    throw new Error(`Configured Drive fixture folder is trashed: ${driveFolderId}`);
  }

  const candidateParents = new Set<string>([driveFolderId]);
  const seedFolderId = await findDriveFolderIdByName(drive, driveFolderId, 'Seed');
  if (seedFolderId) candidateParents.add(seedFolderId);
  const imagesFolderId = await findDriveFolderIdByName(drive, driveFolderId, 'Images');
  if (imagesFolderId) {
    candidateParents.add(imagesFolderId);
    const originalsId = await findDriveFolderIdByName(drive, imagesFolderId, 'Originals');
    if (originalsId) candidateParents.add(originalsId);
    const processedId = await findDriveFolderIdByName(drive, imagesFolderId, 'Processed');
    if (processedId) candidateParents.add(processedId);
  }

  let driveImageCount = 0;
  for (const parentId of candidateParents) {
    driveImageCount += await countDriveImagesInParent(drive, parentId);
    if (driveImageCount > 0) break;
  }
  if (driveImageCount === 0) {
    throw new Error(
      `Configured Drive fixture folder has no images: ${driveFolderId}. ` +
        `Run npm run fixtures:google:sync before test:live:e2e.`,
    );
  }

  const photosAuth = new OAuth2Client(clientId, clientSecret);
  photosAuth.setCredentials({ refresh_token: photosRefreshToken });
  const photosAccessToken = (await photosAuth.getAccessToken()).token;
  if (!photosAccessToken) {
    throw new Error('Could not obtain access token for Google Photos fixture validation.');
  }

  const albumResponse = await fetch(`https://photoslibrary.googleapis.com/v1/albums/${photosAlbumId}`, {
    headers: { Authorization: `Bearer ${photosAccessToken}` },
  });
  if (!albumResponse.ok) {
    throw new Error(
      `Configured Photos fixture album is not accessible (${photosAlbumId}): ` +
        `${albumResponse.status} ${await albumResponse.text()}`,
    );
  }
  const album = (await albumResponse.json()) as { id?: string; mediaItemsCount?: string };

  const mediaResponse = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${photosAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      albumId: photosAlbumId,
      pageSize: 1,
    }),
  });
  if (!mediaResponse.ok) {
    throw new Error(
      `Failed to read media items from configured Photos fixture album (${photosAlbumId}): ` +
        `${mediaResponse.status} ${await mediaResponse.text()}`,
    );
  }
  const mediaPayload = (await mediaResponse.json()) as { mediaItems?: Array<{ id?: string }> };
  const visibleCount = mediaPayload.mediaItems?.length || 0;
  const metadataCount = Number.parseInt(String(album.mediaItemsCount || '0'), 10) || 0;
  if (visibleCount === 0) {
    throw new Error(
      `Configured Photos fixture album has 0 API-visible items via mediaItems:search ` +
        `(albumId=${photosAlbumId}, metadataCount=${metadataCount}). ` +
        `Delete this fixtures album, then run npm run fixtures:google:sync and verify doctor passes before test:live:e2e.`,
    );
  }

  return { driveFolderId, photosAlbumId };
}

async function getStaticFixtureConfig(): Promise<StaticFixtureConfig> {
  if (!cachedStaticFixtureConfig) {
    cachedStaticFixtureConfig = validatePermanentGoogleFixtures();
  }
  return cachedStaticFixtureConfig;
}

async function resetFirestoreEmulator() {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
  const projectCandidates = [
    process.env.VITE_FIREBASE_LOCAL_PROJECT_ID,
    process.env.VITE_FIREBASE_PROJECT_ID,
    'dobutsu-admin',
    'demo-test-project',
  ].filter(Boolean) as string[];
  const projects = Array.from(new Set(projectCandidates));

  let clearedAnyProject = false;
  for (const projectId of projects) {
    const clearUrl = `http://${emulatorHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`;
    const clearResponse = await fetch(clearUrl, { method: 'DELETE' });
    if (!clearResponse.ok) {
      console.warn(
        `⚠️ [Live Fixture] Firestore clear failed for project ${projectId}: ${clearResponse.status} ${clearResponse.statusText}`,
      );
      continue;
    }
    clearedAnyProject = true;
  }

  if (!clearedAnyProject) {
    throw new Error('Failed to clear Firestore emulator for any configured project ID.');
  }
}

export const test = base.extend<LiveFixtures>({
  sandboxId: async ({ page }, use) => {
    await resetFirestoreEmulator();

    // Start each run from a clean client cache so broadcast replay does not accumulate.
    await page.addInitScript(() => {
      try {
        window.indexedDB.deleteDatabase('dobutsu_actions_db');
      } catch {
        // Best effort only.
      }
    });

    const fixtureConfig = await getStaticFixtureConfig();
    const activeDriveFolderId = fixtureConfig.driveFolderId;
    
    // Inject into window
    await page.addInitScript((data) => {
      Date.now = () => data.fixedNow;

        (window as any).__GOOGLE_DRIVE_FOLDER_ID__ = data.driveFolderId;
        (window as any).__GOOGLE_DRIVE_CLIENT_ID__ = data.clientId;
        (window as any).__GOOGLE_PHOTOS_ALBUM_ID__ = data.photosAlbumId;
        // Scopes must match what we requested in auth.setup.ts
        (window as any).__GOOGLE_DRIVE_SCOPES__ = "https://www.googleapis.com/auth/drive.file,https://www.googleapis.com/auth/photoslibrary.readonly";
        console.log("💉 Injected Sandbox FOLDER_ID:", data.driveFolderId);
    }, {
        driveFolderId: activeDriveFolderId,
        clientId: process.env.E2E_GOOGLE_CLIENT_ID,
        photosAlbumId: fixtureConfig.photosAlbumId,
        fixedNow: Date.UTC(2026, 0, 15, 12, 0, 0),
    });

    try {
      await use(activeDriveFolderId);
    } finally {
      // no-op
    }
  }
});

export { expect } from '@playwright/test';
