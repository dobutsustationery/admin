import { test as setup } from "@playwright/test";
import { OAuth2Client } from "google-auth-library";
import * as fs from "fs";
import * as path from "path";
import { loadLiveEnvLocal } from "./load-live-env";

const authFile = "e2e/live/.auth/user.json";
const authDir = path.dirname(authFile);

loadLiveEnvLocal();

setup("authenticate", async ({ page, context }) => {
  const clientId = process.env.E2E_GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET || "";
  const driveRefreshToken = process.env.E2E_GOOGLE_DRIVE_REFRESH_TOKEN || "";
  const photosRefreshToken = process.env.E2E_GOOGLE_PHOTOS_REFRESH_TOKEN || "";

  if (!clientId || !clientSecret || !driveRefreshToken || !photosRefreshToken) {
    throw new Error("Missing live E2E Google credentials.");
  }

  const driveAuth = new OAuth2Client(clientId, clientSecret);
  driveAuth.setCredentials({ refresh_token: driveRefreshToken });
  const driveTokenRes = await driveAuth.getAccessToken();
  const driveToken = driveTokenRes.token;
  if (!driveToken) throw new Error("Failed to obtain Drive access token.");

  const photosAuth = new OAuth2Client(clientId, clientSecret);
  photosAuth.setCredentials({ refresh_token: photosRefreshToken });
  const photosTokenRes = await photosAuth.getAccessToken();
  const photosToken = photosTokenRes.token;
  if (!photosToken) throw new Error("Failed to obtain Photos access token.");

  const now = Date.now();
  const driveStorage = {
    access_token: driveToken,
    expires_in: 3500,
    expires_at: now + 3500 * 1000,
    scope: "https://www.googleapis.com/auth/drive.file",
    token_type: "Bearer",
  };

  const photosStorage = {
    access_token: photosToken,
    expires_in: 3500,
    expires_at: now + 3500 * 1000,
    scope:
      "https://www.googleapis.com/auth/photospicker.mediaitems.readonly https://www.googleapis.com/auth/photoslibrary.readonly https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata https://www.googleapis.com/auth/photoslibrary.appendonly https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email",
    token_type: "Bearer",
  };

  // Create a real Firebase emulator user and inject auth persistence.
  const authEmulatorUrl =
    process.env.E2E_AUTH_EMULATOR_URL || "http://127.0.0.1:9099";
  const testEmail = "live-e2e@example.com";
  const testPassword = "testpassword123";

  let authData: any;
  const signUpResponse = await page.request.post(
    `${authEmulatorUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
    {
      data: {
        email: testEmail,
        password: testPassword,
        displayName: "Live E2E User",
        returnSecureToken: true,
      },
    },
  );

  if (signUpResponse.ok()) {
    authData = await signUpResponse.json();
  } else {
    const signUpBody = await signUpResponse.json().catch(() => ({}) as any);
    const alreadyExists =
      signUpBody?.error?.message === "EMAIL_EXISTS" ||
      signUpBody?.error?.message ===
        "EMAIL_EXISTS : Password hash should be specified.";
    if (!alreadyExists) {
      throw new Error(
        `Auth emulator sign-up failed: ${signUpResponse.status()} ${JSON.stringify(signUpBody)}`,
      );
    }

    const signInResponse = await page.request.post(
      `${authEmulatorUrl}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`,
      {
        data: {
          email: testEmail,
          password: testPassword,
          returnSecureToken: true,
        },
      },
    );
    if (!signInResponse.ok()) {
      throw new Error(
        `Auth emulator sign-in failed: ${signInResponse.status()}`,
      );
    }
    authData = await signInResponse.json();
  }

  await context.addInitScript(
    ({ drive, photos, authInfo }) => {
      localStorage.setItem("google_drive_access_token", JSON.stringify(drive));
      localStorage.setItem(
        "google_photos_access_token",
        JSON.stringify(photos),
      );

      const authKey = "firebase:authUser:demo-api-key:[DEFAULT]";
      localStorage.setItem(
        authKey,
        JSON.stringify({
          uid: authInfo.localId,
          email: authInfo.email,
          emailVerified: false,
          displayName: "Live E2E User",
          isAnonymous: false,
          photoURL: null,
          providerData: [
            {
              providerId: "password",
              uid: authInfo.localId,
              displayName: "Live E2E User",
              email: authInfo.email,
              phoneNumber: null,
              photoURL: null,
            },
          ],
          stsTokenManager: {
            refreshToken: authInfo.refreshToken,
            accessToken: authInfo.idToken,
            expirationTime: Date.now() + 3600000,
          },
          createdAt: String(Date.now()),
          lastLoginAt: String(Date.now()),
          apiKey: "demo-api-key",
          appName: "[DEFAULT]",
        }),
      );
    },
    { drive: driveStorage, photos: photosStorage, authInfo: authData },
  );

  await page.goto("/");

  fs.mkdirSync(authDir, { recursive: true });
  await context.storageState({ path: authFile });
});
