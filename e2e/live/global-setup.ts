import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

async function globalSetup() {
  console.log('🌍 [Live Setup] Creating Sandbox...');
  
  // Run the sandbox creation script
  // We use the compiled JS or use ts-node/bun if available
  // Assuming 'bun' is available as per user environment
  try {
    const stdout = execSync('bun scripts/google-fixtures/create-run-sandbox.ts', {
      encoding: 'utf-8',
      env: process.env // Pass current env which has E2E secrets
    });
    
    // Parse the JSON output (script prints JSON at end)
    // The script might print logs before JSON. We look for the last line or parse all?
    // The script `create-run-sandbox.ts` uses console.log for logs.
    // I should modify it to output ONLY JSON or write to file?
    // Or I parse the last valid JSON line.
    
    const lines = stdout.trim().split('\n');
    const jsonLine = lines[lines.length - 1];
    const sandboxData = JSON.parse(jsonLine);
    
    console.log(`✅ Sandbox Created: ${sandboxData.sandboxName} (${sandboxData.driveFolderId})`);
    
    // Write to a temporary file for tests to consume
    const envFile = path.resolve(process.cwd(), 'e2e/live/.env.live.json');
    fs.writeFileSync(envFile, JSON.stringify(sandboxData, null, 2));

  } catch (error: any) {
    console.error('❌ Failed to create sandbox:', error.message);
    if (error.stdout) console.log(error.stdout.toString());
    if (error.stderr) console.error(error.stderr.toString());
    throw error;
  }
}

export default globalSetup;
