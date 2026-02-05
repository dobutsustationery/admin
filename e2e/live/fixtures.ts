import { test as base } from '@playwright/test';
import { execSync } from 'child_process';
import { OAuth2Client } from 'google-auth-library';

type LiveFixtures = {
  sandboxId: string;
};

function extractLastJsonObject(output: string): any {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue scanning
    }
  }

  throw new Error('No JSON payload found in sandbox creation output.');
}

function createSandboxWithRetries(maxAttempts = 4): any {
  let lastError: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const stdout = execSync('bun scripts/google-fixtures/create-run-sandbox.ts', {
        encoding: 'utf-8',
        env: process.env,
      });
      return extractLastJsonObject(stdout);
    } catch (error: any) {
      lastError = error;
      const delayMs = attempt * 1000;
      console.warn(`⚠️ [Live Fixture] Sandbox create failed (attempt ${attempt}/${maxAttempts}). Retrying in ${delayMs}ms...`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  throw lastError;
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

    // Create a fresh Drive/Photos sandbox for each test execution
    const sandboxData = createSandboxWithRetries(4);
    const activeDriveFolderId = sandboxData.driveFolderId || '';
    
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
        photosAlbumId: process.env.E2E_GOOGLE_PHOTOS_ALBUM_ID || sandboxData.photosAlbumId,
        fixedNow: Date.UTC(2026, 0, 15, 12, 0, 0),
    });

    // Proxy Googleusercontent image requests through Playwright's API context.
    // This preserves real upstream bytes while avoiding browser CORS restrictions in headless runs.
    const clientId = process.env.E2E_GOOGLE_CLIENT_ID || '';
    const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET || '';
    const photosRefreshToken = process.env.E2E_GOOGLE_PHOTOS_REFRESH_TOKEN || '';
    let photosAccessToken: string | null = null;
    if (clientId && clientSecret && photosRefreshToken) {
      const oauth = new OAuth2Client(clientId, clientSecret);
      oauth.setCredentials({ refresh_token: photosRefreshToken });
      photosAccessToken = (await oauth.getAccessToken()).token || null;
    }

    await page.route('https://lh3.googleusercontent.com/**', async (route) => {
      const request = route.request();
      if (!['GET', 'HEAD'].includes(request.method())) {
        await route.continue();
        return;
      }

      const headers = { ...request.headers() };
      delete (headers as any).host;
      if (photosAccessToken) {
        headers.authorization = `Bearer ${photosAccessToken}`;
      }

      let upstream: any = null;
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          upstream = await page.request.fetch(request.url(), {
            method: request.method(),
            headers,
          });
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 3) {
            await page.waitForTimeout(150 * attempt);
          }
        }
      }

      if (!upstream) {
        console.warn(`⚠️ [Live Fixture] lh3 proxy failed after retries for ${request.url()}:`, lastError);
        await route.continue();
        return;
      }

      const upstreamHeaders = upstream.headers();
      await route.fulfill({
        status: upstream.status(),
        headers: {
          ...upstreamHeaders,
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'GET,HEAD,OPTIONS',
        },
        body: await upstream.body(),
      });
    });

    try {
      await use(activeDriveFolderId);
    } finally {
      if (activeDriveFolderId) {
        try {
          execSync(`bun scripts/google-fixtures/cleanup-run-sandbox.ts ${activeDriveFolderId}`, {
            stdio: 'inherit',
            env: process.env,
          });
        } catch (cleanupError) {
          console.error('❌ [Live Fixture] Failed to cleanup sandbox folder:', cleanupError);
        }
      }
    }
  }
});

export { expect } from '@playwright/test';
