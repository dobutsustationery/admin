import { test as base } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

type LiveFixtures = {
  sandboxId: string;
};

export const test = base.extend<LiveFixtures>({
  sandboxId: async ({ page }, use) => {
    // Read Sandbox ID from global setup file
    const envPath = path.resolve(process.cwd(), 'e2e/live/.env.live.json');
    let sandboxData: any = {};
    if (fs.existsSync(envPath)) {
        sandboxData = JSON.parse(fs.readFileSync(envPath, 'utf-8'));
    }
    
    // Inject into window
    console.log("DEBUG: sandboxData loaded:", JSON.stringify(sandboxData));
    await page.addInitScript((data) => {
        console.log("DEBUG: InitScript injection data:", data);
        (window as any).__GOOGLE_DRIVE_FOLDER_ID__ = data.driveFolderId;
        (window as any).__GOOGLE_DRIVE_CLIENT_ID__ = data.clientId;
        (window as any).__GOOGLE_PHOTOS_ALBUM_ID__ = data.photosAlbumId;
        // Scopes must match what we requested in auth.setup.ts
        (window as any).__GOOGLE_DRIVE_SCOPES__ = "https://www.googleapis.com/auth/drive.file,https://www.googleapis.com/auth/photoslibrary.readonly";
        console.log("💉 Injected Sandbox FOLDER_ID:", data.driveFolderId);
    }, {
        driveFolderId: sandboxData.driveFolderId,
        clientId: process.env.E2E_GOOGLE_CLIENT_ID,
        photosAlbumId: sandboxData.photosAlbumId || process.env.E2E_GOOGLE_PHOTOS_ALBUM_ID,
    });

    await use(sandboxData.driveFolderId);
  }
});

export { expect } from '@playwright/test';
