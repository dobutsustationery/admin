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

  const runId = process.env.RUN_ID || randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sandboxName = `Sandbox_${timestamp}_${runId}`;

  const clientId = process.env.E2E_GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET!;
  const driveRefreshToken = process.env.E2E_GOOGLE_DRIVE_REFRESH_TOKEN!;
  const photosRefreshToken = process.env.E2E_GOOGLE_PHOTOS_REFRESH_TOKEN!;
  const driveRootId = process.env.E2E_GOOGLE_DRIVE_FOLDER_ID!;

  // 1. Create Drive Folder
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

  // 2. Create Photos Album
  const photosAuth = new OAuth2Client(clientId, clientSecret);
  photosAuth.setCredentials({ refresh_token: photosRefreshToken });
  const { token: photosAccessToken } = await photosAuth.getAccessToken();

  let photosAlbumId = '';
  try {
    const response = await fetch('https://photoslibrary.googleapis.com/v1/albums', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${photosAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        album: {
          title: sandboxName,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Photos API returned ${response.status}: ${text}`);
    }

    const album = await response.json();
    photosAlbumId = album.id;
  } catch (error: any) {
    console.error('❌ Failed to create Photos sandbox album:', error.message);
    // Attempt cleanup of Drive folder if photos fail? 
    // For now, just exit. Test runner handles cleanup or manual sweep.
    process.exit(1);
  }

  // Output JSON result
  console.log(JSON.stringify({
    runId,
    sandboxName,
    driveFolderId,
    photosAlbumId,
  }));
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
