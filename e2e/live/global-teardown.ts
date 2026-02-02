import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

async function globalTeardown() {
  console.log('🌍 [Live Teardown] Cleaning up...');

  const envFile = path.resolve(process.cwd(), 'e2e/live/.env.live.json');
  if (!fs.existsSync(envFile)) {
    console.warn('⚠️ No environment file found. Skipping cleanup.');
    return;
  }

  const sandboxData = JSON.parse(fs.readFileSync(envFile, 'utf-8'));
  const folderId = sandboxData.driveFolderId;

  if (folderId) {
     try {
        console.log(`Deleting Sandbox Folder: ${folderId}`);
        // Run cleanup script targeting this folder
        // We modified `cleanup-run-sandbox.ts` to accept an argument?
        // "cleanup-run-sandbox.ts" accepts args to `process.argv`.
        // `const targetId = args.find(a => !a.startsWith('-'));`
        execSync(`bun scripts/google-fixtures/cleanup-run-sandbox.ts ${folderId}`, {
            stdio: 'inherit',
            env: process.env
        });
     } catch (e) {
         console.error('❌ Failed to cleanup:', e);
     }
  }
  
  // Delete env file
  try {
    fs.unlinkSync(envFile);
  } catch {
    // ignore missing file race
  }
}

export default globalTeardown;
