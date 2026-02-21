import { describe, it, expect, beforeAll } from "vitest";
import * as GooglePhotos from "../../src/lib/google-photos";
import { OAuth2Client } from "google-auth-library";

const isLiveConfigured =
  process.env.E2E_GOOGLE_CLIENT_ID &&
  process.env.E2E_GOOGLE_PHOTOS_REFRESH_TOKEN;

describe.skipIf(!isLiveConfigured)("Google Photos Integration (@live)", () => {
  let accessToken: string;

  beforeAll(async () => {
    // Provide a minimal localStorage shim for Node test environment.
    if (typeof globalThis.localStorage === "undefined") {
      const storage = new Map<string, string>();
      Object.defineProperty(globalThis, "localStorage", {
        value: {
          getItem: (key: string) =>
            storage.has(key) ? storage.get(key)! : null,
          setItem: (key: string, value: string) => {
            storage.set(key, String(value));
          },
          removeItem: (key: string) => {
            storage.delete(key);
          },
          clear: () => {
            storage.clear();
          },
        },
        configurable: true,
      });
    }

    // Setup Tokens from E2E Envs
    const clientId = process.env.E2E_GOOGLE_CLIENT_ID!;
    const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET!;
    const refreshToken = process.env.E2E_GOOGLE_PHOTOS_REFRESH_TOKEN!;

    // Generate Access Token
    const auth = new OAuth2Client(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    const tokenRes = await auth.getAccessToken();
    accessToken = tokenRes.token!;
  });

  it("should authenticate with a valid token", () => {
    // Mock localStorage
    const tokenData: GooglePhotos.GooglePhotosToken = {
      access_token: accessToken,
      expires_in: 3600,
      expires_at: Date.now() + 3600000,
      scope:
        "https://www.googleapis.com/auth/photospicker.mediaitems.readonly https://www.googleapis.com/auth/drive.readonly",
      token_type: "Bearer",
    };

    localStorage.setItem(
      "google_photos_access_token",
      JSON.stringify(tokenData),
    );

    const retrieved = GooglePhotos.getStoredToken();
    expect(retrieved).not.toBeNull();
    expect(retrieved?.access_token).toBe(accessToken);
  });

  it("should create a picker session", async () => {
    // This requires the token to be in localStorage
    const tokenData: GooglePhotos.GooglePhotosToken = {
      access_token: accessToken,
      expires_in: 3600,
      expires_at: Date.now() + 3600000,
      scope:
        "https://www.googleapis.com/auth/photospicker.mediaitems.readonly https://www.googleapis.com/auth/drive.readonly",
      token_type: "Bearer",
    };
    localStorage.setItem(
      "google_photos_access_token",
      JSON.stringify(tokenData),
    );

    const session = await GooglePhotos.createPickerSession();
    expect(session.id).toBeDefined();
    expect(session.pickerUri).toBeDefined();

    // We can't easily proceed further without user interaction
    console.log("Created Picker Session:", session.id);
  });
});
