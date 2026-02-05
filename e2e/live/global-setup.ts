import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

function extractLastJsonObject(output: string): any {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep scanning
    }
  }
  throw new Error('No JSON payload found in sandbox creation output.');
}

async function globalSetup() {
  console.log('🌍 [Live Setup] Resetting emulator fixtures...');

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
        `⚠️ [Live Setup] Firestore clear failed for project ${projectId}: ${clearResponse.status} ${clearResponse.statusText}`,
      );
      continue;
    }
    clearedAnyProject = true;
    console.log(`✅ [Live Setup] Firestore emulator cleared for project ${projectId}`);
  }

  if (!clearedAnyProject) {
    throw new Error('Failed to clear Firestore emulator for any configured project ID.');
  }

  console.log('🌍 [Live Setup] Creating Sandbox...');
  
  // Run the sandbox creation script
  // We use the compiled JS or use ts-node/bun if available
  // Assuming 'bun' is available as per user environment
  try {
    const stdout = execSync('bun scripts/google-fixtures/create-run-sandbox.ts', {
      encoding: 'utf-8',
      env: process.env // Pass current env which has E2E secrets
    });
    
    const sandboxData = extractLastJsonObject(stdout);
    
    console.log(`✅ Sandbox Created: ${sandboxData.sandboxName} (${sandboxData.driveFolderId})`);
    
    // Write to a temporary file for tests to consume
    const envFile = path.resolve(process.cwd(), 'e2e/live/.env.live.json');
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, JSON.stringify(sandboxData, null, 2));

  } catch (error: any) {
    console.error('❌ Failed to create sandbox:', error.message);
    if (error.stdout) console.log(error.stdout.toString());
    if (error.stderr) console.error(error.stderr.toString());
    throw error;
  }
}

export default globalSetup;
