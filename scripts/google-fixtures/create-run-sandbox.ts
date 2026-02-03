import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { randomUUID } from 'crypto';

const REQUIRED_ENV_VARS = [
  'E2E_GOOGLE_CLIENT_ID',
  'E2E_GOOGLE_CLIENT_SECRET',
  'E2E_GOOGLE_DRIVE_REFRESH_TOKEN',
  'E2E_GOOGLE_PHOTOS_REFRESH_TOKEN',
  'E2E_GOOGLE_DRIVE_FOLDER_ID',
];

async function main() {
  const missingVars = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    console.error('❌ Missing required environment variables:', missingVars.join(', '));
    process.exit(1);
  }

  const REUSED_SANDBOX_NAME = "Sandbox_E2E_Reused";
  const useReuse = true; // Feature flag

  const clientId = process.env.E2E_GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET!;
  const driveRefreshToken = process.env.E2E_GOOGLE_DRIVE_REFRESH_TOKEN!;
  const photosRefreshToken = process.env.E2E_GOOGLE_PHOTOS_REFRESH_TOKEN!;
  const driveRootId = process.env.E2E_GOOGLE_DRIVE_FOLDER_ID!;

  // 1. Create Drive Folder (Still create new for Drive isolation as it supports deletion)
  const runId = process.env.RUN_ID || randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sandboxName = `Sandbox_${timestamp}_${runId}`; // For Drive

  const driveAuth = new OAuth2Client(clientId, clientSecret);
  driveAuth.setCredentials({ refresh_token: driveRefreshToken });
  const drive = google.drive({ version: 'v3', auth: driveAuth });

  let driveFolderId = '';
  try {
    const file = await drive.files.create({
      requestBody: {
        name: sandboxName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [driveRootId],
      },
      fields: 'id',
    });
    driveFolderId = file.data.id!;
  } catch (error: any) {
    console.error('❌ Failed to create Drive sandbox folder:', error.message);
    process.exit(1);
  }

  // 2. Create/Reuse Photos Album
  const photosAuth = new OAuth2Client(clientId, clientSecret);
  photosAuth.setCredentials({ refresh_token: photosRefreshToken });
  const { token: photosAccessToken } = await photosAuth.getAccessToken();
  if (!photosAccessToken) {
    console.error('❌ Failed to obtain Photos access token.');
    if (driveFolderId) await drive.files.delete({ fileId: driveFolderId });
    process.exit(1);
  }

  let photosAlbumId = '';
  
  async function emptyAlbum(albumId: string, token: string) {
      // List media items
      try {
          const searchRes = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:search', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ albumId, pageSize: 100 })
          });
          const searchData = await searchRes.json();
          const items = searchData.mediaItems || [];
          
          if (items.length > 0) {
              const ids = items.map((i: any) => i.id);
              // Batch remove
              const removeRes = await fetch(`https://photoslibrary.googleapis.com/v1/albums/${albumId}:batchRemoveMediaItems`, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ mediaItemIds: ids })
              });
              if (!removeRes.ok) console.warn("Failed to empty album items:", await removeRes.text());
              
              // Recurse if more? (Pagination)
              if (searchData.nextPageToken) {
                  // Simply run again? Or handle pagination. For E2E, 100 is likely enough.
                  // But recursive is safer.
                  await emptyAlbum(albumId, token);
              }
          }
      } catch (e) {
          console.warn("Error emptying album:", e);
      }
  }

  try {
      if (useReuse) {
          // List albums to find reuse target
          const listRes = await fetch('https://photoslibrary.googleapis.com/v1/albums?pageSize=50', {
              headers: { 'Authorization': `Bearer ${photosAccessToken}` }
          });
          const listData = await listRes.json();
          const existing = (listData.albums || []).find((a: any) => a.title === REUSED_SANDBOX_NAME);
          
          if (existing) {
              photosAlbumId = existing.id;
              await emptyAlbum(photosAlbumId, photosAccessToken);
          }
      }

      if (!photosAlbumId) {
          const response = await fetch('https://photoslibrary.googleapis.com/v1/albums', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${photosAccessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              album: {
                title: useReuse ? REUSED_SANDBOX_NAME : sandboxName,
              },
            }),
          });
      
          if (!response.ok) {
            const text = await response.text();
            throw new Error(`Photos API returned ${response.status}: ${text}`);
          }
      
          const album = await response.json();
          photosAlbumId = album.id;
      }
  } catch (error: any) {
    console.error('❌ Failed to create/reuse Photos sandbox album:', error.message);
    if (driveFolderId) {
      try { await drive.files.delete({ fileId: driveFolderId }); } catch {}
    }
    process.exit(1);
  }

  // Output JSON result
  console.log(JSON.stringify({
    runId,
    sandboxName: useReuse ? REUSED_SANDBOX_NAME : sandboxName, // Use actual name
    driveFolderId,
    photosAlbumId,
  }));
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
