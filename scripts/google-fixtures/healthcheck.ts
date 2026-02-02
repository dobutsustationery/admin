import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

// Define required environment variables
const REQUIRED_ENV_VARS = [
  'E2E_GOOGLE_CLIENT_ID',
  'E2E_GOOGLE_CLIENT_SECRET',
  'E2E_GOOGLE_DRIVE_REFRESH_TOKEN',
  'E2E_GOOGLE_PHOTOS_REFRESH_TOKEN',
  'E2E_GOOGLE_DRIVE_FOLDER_ID',
  'E2E_GOOGLE_PHOTOS_ALBUM_ID',
];

async function main() {
  console.log('🏥 Starting E2E Environment Health Check...');
  
  // 1. Check Environment Variables
  const missingVars = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    console.error('❌ Missing required environment variables:', missingVars.join(', '));
    process.exit(1);
  }
  console.log('✅ All environment variables present.');

  const clientId = process.env.E2E_GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET!;
  const driveRefreshToken = process.env.E2E_GOOGLE_DRIVE_REFRESH_TOKEN!;
  const photosRefreshToken = process.env.E2E_GOOGLE_PHOTOS_REFRESH_TOKEN!;
  const driveRootId = process.env.E2E_GOOGLE_DRIVE_FOLDER_ID!;
  const photosAlbumId = process.env.E2E_GOOGLE_PHOTOS_ALBUM_ID!;

  // 2. Check Drive Access
  console.log('Testing Drive Access...');
  try {
    const driveAuth = new OAuth2Client(clientId, clientSecret);
    driveAuth.setCredentials({ refresh_token: driveRefreshToken });
    
    // Refresh token check
    await driveAuth.getAccessToken(); // Will throw if invalid
    
    const drive = google.drive({ version: 'v3', auth: driveAuth });
    const file = await drive.files.get({ 
      fileId: driveRootId, 
      fields: 'id, name, mimeType, trashed' 
    });
    
    if (file.data.trashed) {
      throw new Error('Drive root folder is in trash');
    }
    
    console.log(`✅ Drive access confirmed. Root folder: "${file.data.name}" (${file.data.id})`);
  } catch (error: any) {
    console.error('❌ Drive access failed:', error.message);
    process.exit(1);
  }

  // 3. Check Photos Access
  console.log('Testing Photos Access...');
  try {
    const photosAuth = new OAuth2Client(clientId, clientSecret);
    photosAuth.setCredentials({ refresh_token: photosRefreshToken });

    // Refresh token check
    await photosAuth.getAccessToken();

    // Note: The Google Photos Library API via googleapis might need verify scopes or use raw fetch if the library excludes it.
    // The design doc mentions "real Drive and Google Photos integration".
    // For now we assume standard REST checks or available library support.
    // googleapis does NOT have a full 'photoslibrary' equivalent usually, we might need to use fetch or a wrapper.
    // Let's use simple fetch with the token for Photos to be sure.
    
    const tokenRes = await photosAuth.getAccessToken();
    const accessToken = tokenRes.token;

    if (!accessToken) throw new Error('Could not generate Photos access token');

    const response = await fetch(`https://photoslibrary.googleapis.com/v1/albums/${photosAlbumId}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Photos API returned ${response.status}: ${text}`);
    }

    const album = await response.json();
    console.log(`✅ Photos access confirmed. Album: "${album.title}" (${album.id})`);

  } catch (error: any) {
    console.error('❌ Photos access failed:', error.message);
    process.exit(1);
  }

  console.log('🎉 Health check passed! E2E environment is ready.');
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
