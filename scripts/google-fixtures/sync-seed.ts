import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';

const REQUIRED_ENV_VARS = [
  'E2E_GOOGLE_CLIENT_ID',
  'E2E_GOOGLE_CLIENT_SECRET',
  'E2E_GOOGLE_DRIVE_REFRESH_TOKEN',
  'E2E_GOOGLE_DRIVE_FOLDER_ID',
];

const MANIFEST_PATH = path.resolve(process.cwd(), 'e2e/fixtures/google-media-manifest.json');

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function main() {
  const missingVars = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    console.error('❌ Missing required environment variables:', missingVars.join(', '));
    process.exit(1);
  }

  // Load Manifest
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('❌ Manifest not found at:', MANIFEST_PATH);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  const fixtures = manifest.fixtures || [];
  
  if (fixtures.length === 0) {
    console.log('ℹ️  No fixtures defined in manifest. Nothing to sync.');
    return;
  }

  console.log(`📦 Syncing ${fixtures.length} fixtures...`);

  const clientId = process.env.E2E_GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET!;
  const driveRefreshToken = process.env.E2E_GOOGLE_DRIVE_REFRESH_TOKEN!;
  const driveRootId = process.env.E2E_GOOGLE_DRIVE_FOLDER_ID!;

  const driveAuth = new OAuth2Client(clientId, clientSecret);
  driveAuth.setCredentials({ refresh_token: driveRefreshToken });
  const drive = google.drive({ version: 'v3', auth: driveAuth });

  // 1. Ensure "Seed" folder exists
  let seedFolderId = '';
  const q = `'${driveRootId}' in parents and name = 'Seed' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  
  try {
    const listRes = await drive.files.list({ q, fields: 'files(id)' });
    if (listRes.data.files && listRes.data.files.length > 0) {
      seedFolderId = listRes.data.files[0].id!;
      console.log(`✅ Found Seed folder: ${seedFolderId}`);
    } else {
      console.log('🌱 Creating Seed folder...');
      const createRes = await drive.files.create({
        requestBody: {
          name: 'Seed',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [driveRootId],
        },
        fields: 'id',
      });
      seedFolderId = createRes.data.id!;
      console.log(`✅ Created Seed folder: ${seedFolderId}`);
    }
  } catch (e: any) {
    console.error('❌ Failed to find/create Seed folder:', e.message);
    process.exit(1);
  }

  // 2. Check each fixture
  let success = true;
  for (const fixture of fixtures) {
    const { id, filename, sha256 } = fixture;
    // Check if exists in Seed folder
    const safeFilename = escapeDriveQueryValue(filename);
    const fileQ = `'${seedFolderId}' in parents and name = '${safeFilename}' and trashed = false`;
    
    try {
      const fileRes = await drive.files.list({
        q: fileQ,
        fields: 'files(id, name, md5Checksum, size)',
      });

      if (fileRes.data.files && fileRes.data.files.length > 0) {
        const file = fileRes.data.files[0];
        const checksumMsg = sha256 ? ` (manifest sha256: ${sha256.slice(0, 12)}...)` : '';
        console.log(`✅ [${id}] Found: ${filename}${checksumMsg}`);
      } else {
        console.error(`❌ [${id}] Missing: ${filename} in Seed folder.`);
        success = false;
        // In future: logic to upload from local fixtures path?
      }
    } catch (e: any) {
      console.error(`❌ Error checking ${filename}:`, e.message);
      success = false;
    }
  }

  if (!success) {
    console.error('⚠️  Some seed files are missing. Please investigate.');
    process.exit(1);
  } else {
    console.log('🎉 All seed fixtures verified.');
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
