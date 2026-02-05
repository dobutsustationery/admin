import fs from 'fs';
import path from 'path';

async function globalTeardown() {
  console.log('🌍 [Live Teardown] Cleaning up...');

  const envFile = path.resolve(process.cwd(), 'e2e/live/.env.live.json');
  if (!fs.existsSync(envFile)) {
    console.warn('⚠️ No environment file found. Skipping cleanup.');
    return;
  }

  // Sandbox cleanup is done per-test in e2e/live/fixtures.ts.
  // Keep teardown best-effort and non-destructive.
  try {
    fs.unlinkSync(envFile);
  } catch {
    // ignore missing file race
  }
}

export default globalTeardown;
