import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

const REQUIRED_ENV_VARS = [
  'E2E_GOOGLE_CLIENT_ID',
  'E2E_GOOGLE_CLIENT_SECRET',
  'E2E_GOOGLE_DRIVE_REFRESH_TOKEN',
  'E2E_GOOGLE_DRIVE_FOLDER_ID',
];

async function main() {
  const missingVars = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    console.error('❌ Missing required environment variables:', missingVars.join(', '));
    process.exit(1);
  }

  const clientId = process.env.E2E_GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET!;
  const driveRefreshToken = process.env.E2E_GOOGLE_DRIVE_REFRESH_TOKEN!;
  const driveRootId = process.env.E2E_GOOGLE_DRIVE_FOLDER_ID!;

  // Optional: Pass specific folder ID to delete, or --all-older-than=X
  // For now, default behavior: delete all folders starting with "Sandbox_" older than 24h
  // unless specific ID provided.
  
  const args = process.argv.slice(2);
  const targetId = args.find(a => !a.startsWith('-'));

  const driveAuth = new OAuth2Client(clientId, clientSecret);
  driveAuth.setCredentials({ refresh_token: driveRefreshToken });
  const drive = google.drive({ version: 'v3', auth: driveAuth });

  if (targetId) {
    console.log(`🗑️ Deleting specific folder: ${targetId}`);
    try {
      await drive.files.delete({ fileId: targetId });
      console.log('✅ Deleted.');
    } catch (e: any) {
      console.error(`Failed to delete ${targetId}:`, e.message);
    }
    return;
  }

  console.log('🧹 Scanning for stale sandboxes (older than 24h)...');
  
  // Find folders in root with name "Sandbox_*"
  const query = `'${driveRootId}' in parents and name contains 'Sandbox_' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  
  const res = await drive.files.list({
    q: query,
    fields: 'files(id, name, createdTime)',
    pageSize: 100,
  });

  const files = res.data.files || [];
  const now = new Date();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  let deletedCount = 0;
  for (const file of files) {
    const created = new Date(file.createdTime!);
    const age = now.getTime() - created.getTime();

    if (age > ONE_DAY_MS) {
      console.log(`Deleting stale sandbox "${file.name}" (${file.id})...`);
      try {
        await drive.files.delete({ fileId: file.id! });
        deletedCount++;
      } catch (e: any) {
        console.error(`Failed to delete ${file.id}:`, e.message);
      }
    }
  }

  console.log(`✅ Cleanup complete. Deleted ${deletedCount} stale sandboxes.`);

  // Note: Photos API doesn't easily support "delete album" via API in the same way (it might only hide it or require different scope).
  // The official Library API 'albums.batchRemoveMediaItems' exists, but deleting the album itself isn't always straightforward or supported for app-created albums via REST easily without specific scopes.
  // Actually, 'albums.delete' is NOT a standard method in Photos Library API. 
  // We can unshare or leave, but deletion is manual or tricky.
  // Ideally, we'd at least empty them? 
  // For this v1, we focus on Drive cleanup which checks quota. Photos quota is less critical or handled differently.
  // We'll log a warning about Photos albums.
  console.warn('⚠️ Note: Google Photos albums are not automatically deleted by this script (API limitation). Please manually clean up "Sandbox_*" albums periodically.');
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
