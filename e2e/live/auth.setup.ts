import { test as setup, expect } from '@playwright/test';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';

const authFile = 'e2e/live/.auth/user.json';
const envFile = 'e2e/live/.env.live.json'; // Relative to root? No, absolute or relative to testDir?
// fs read relative to CWD (root).

setup('authenticate', async ({ page }) => {
  console.log('🔐 [Auth Setup] Generating Tokens...');

  const clientId = process.env.E2E_GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET!;
  const driveRefreshToken = process.env.E2E_GOOGLE_DRIVE_REFRESH_TOKEN!;
  const photosRefreshToken = process.env.E2E_GOOGLE_PHOTOS_REFRESH_TOKEN!;

  if (!clientId || !driveRefreshToken) {
      throw new Error("Missing E2E credentials.");
  }

  // 1. Generate Drive Token
  const driveAuth = new OAuth2Client(clientId, clientSecret);
  driveAuth.setCredentials({ refresh_token: driveRefreshToken });
  const driveTokenRes = await driveAuth.getAccessToken();
  const driveToken = driveTokenRes.token!;
  const driveExpiry = Date.now() + 3500 * 1000; // Approx 1 hour

  // 2. Generate Photos Token
  const photosAuth = new OAuth2Client(clientId, clientSecret);
  photosAuth.setCredentials({ refresh_token: photosRefreshToken });
  const photosTokenRes = await photosAuth.getAccessToken();
  const photosToken = photosTokenRes.token!;
  const photosExpiry = Date.now() + 3500 * 1000;

  // 3. Prepare LocalStorage Data
  const driveStorage = {
      access_token: driveToken,
      expires_in: 3500,
      expires_at: driveExpiry,
      scope: 'https://www.googleapis.com/auth/drive.file', // Match scope
      token_type: 'Bearer'
  };

  const photosStorage = {
      access_token: photosToken,
      expires_in: 3500,
      expires_at: photosExpiry,
      scope: 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly https://www.googleapis.com/auth/drive.readonly',
      token_type: 'Bearer'
  };

  // 4. Inject into Browser Context
  await page.goto('/'); // load app to set localStorage
  
  await page.evaluate(({ drive, photos }) => {
      localStorage.setItem('google_drive_access_token', JSON.stringify(drive));
      localStorage.setItem('google_photos_access_token', JSON.stringify(photos));
      
      // Inject Firebase Auth if needed?
      // "Interactive Google login is brittle... Inject app-local token state"
      // If the app requires Firebase Auth to verify users even for Drive ops, we need that too.
      // Do we need Firebase Auth?
      // `PhotoUploadManager.svelte`: `if (!$user || !$user.uid) return;`
      // YES. We need Firebase Auth.
      // Can we use Local Emulator Auth?
      // We can use `signInWithCredential` in a setup step with emulator?
      // Or manually inject IndexedDB? Firebase uses IndexedDB.
      // Creating a clean firebase session in setup is hard without UI.
      // BUT we are running against Emulators.
      // We can use the Emulator UI or just sign in anonymously/custom token?
      // Easier: Use a helper validation bypass for E2E?
      // OR: Use `page.evaluate` to call `firebase.auth().signInAnonymously()`?
      // `PhotoUploadManager` waits for `$user`.
      
  }, { drive: driveStorage, photos: photosStorage });

  // Perform Firebase Signin (Anonymous or predefined test user)
  // Since we are in emulator, we can sign in comfortably.
  await page.evaluate(async () => {
      // Assuming firebase is initialized in window? SvelteKit modules aren't on window.
      // We can't access `auth` easily unless exposed.
      // BUT we can click the "Sign In" button if it exists?
      // Or assume the app has a debug backdoor?
  });
  
  // Just rely on UI sign-in if available?
  // "Interactive Google login is brittle".
  // But Firebase Emulator login is stable.
  // Let's assume we need to automate the Sign In page.
  
  await page.goto('/signin');
  // Click "Sign in with Google" won't work headlessly easily even with emulator, pops up.
  // Unless we use `signInWithCredential` and a mock provider?
  // For now, let's inject tokens and see if we can bypass auth or if we need to mock it.
  // If `PhotoUploadManager` logic requires `user`, we MUST be signed in.
  
  // WORKAROUND: Expose a hidden "Debug Sign In" button in DEV mode?
  // Or use `addInitScript` to override `user-store`? 
  // Stores are reactive.
  // If we can't sign in, the test fails.
  
  // Let's assume for now we successfully injected Google Tokens.
  // Firebase Auth: We might need to add a "Sign In As Test User" button in the app if env=emulator?
  // Or expose `window.firebaseAuth` to call `signInAnonymously`.
  // The app currently uses `Signin.svelte`.
  
  await page.context().storageState({ path: authFile });
});
