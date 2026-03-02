/**
 * Unified Google OAuth Service
 *
 * This module centralizes authentication for both Google Drive and Photos,
 * ensuring we maintain a single, valid token with all required scopes.
 */

const GOOGLE_DRIVE_CLIENT_ID = import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID;
const GOOGLE_PHOTOS_CLIENT_ID = import.meta.env.VITE_GOOGLE_PHOTOS_CLIENT_ID;

// Prefer Photos client ID as it's the primary one used for the combined flow
const CLIENT_ID = GOOGLE_PHOTOS_CLIENT_ID || GOOGLE_DRIVE_CLIENT_ID;

// Combine all required scopes
const DRIVE_SCOPES = (
  import.meta.env.VITE_GOOGLE_DRIVE_SCOPES ||
  "https://www.googleapis.com/auth/drive.file"
).split(",");
const PHOTOS_SCOPES = (
  import.meta.env.VITE_GOOGLE_PHOTOS_SCOPES ||
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly,https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/userinfo.email"
).split(",");

const ALL_SCOPES = Array.from(
  new Set([
    ...DRIVE_SCOPES,
    ...PHOTOS_SCOPES,
    "https://www.googleapis.com/auth/userinfo.email",
  ]),
);

// We use the photos storage key as the primary unified key for backward compatibility
const TOKEN_STORAGE_KEY = "google_photos_access_token";

export interface GoogleAuthToken {
  access_token: string;
  expires_in: number;
  expires_at: number;
  scope: string;
  token_type: string;
  user_email?: string;
}

export function getStoredToken(): GoogleAuthToken | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed.expires_at !== "number") return null;

    // Auto-clear if expired
    if (Date.now() > parsed.expires_at) {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      return null;
    }
    return parsed as GoogleAuthToken;
  } catch (e) {
    return null;
  }
}

export function getExpiryInfo() {
  const token = getStoredToken();
  if (!token) return null;
  const now = Date.now();
  const expiresInSeconds = Math.max(
    0,
    Math.floor((token.expires_at - now) / 1000),
  );
  return {
    expired: expiresInSeconds <= 0,
    expiresInSeconds,
    expiresAt: token.expires_at,
  };
}

export function isAuthenticated(): boolean {
  const expiry = getExpiryInfo();
  return !!expiry && !expiry.expired;
}

export function initiateOAuthFlow(
  allowSwitchAccount = false,
  returnUrl?: string,
): void {
  const redirectUri = `${window.location.origin}/photos`;
  const state = returnUrl
    ? `unified_auth|${encodeURIComponent(returnUrl)}`
    : "unified_auth";

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: ALL_SCOPES.join(" "),
    include_granted_scopes: "true",
    state: state,
  });

  if (allowSwitchAccount) {
    params.set("prompt", "select_account");
  }

  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function refreshTokensSilently(): Promise<boolean> {
  console.log("[Auth] Initiating unified token refresh...");
  // For now, since we're using the redirect flow, we just re-initiate
  initiateOAuthFlow(false);
  return true;
}

export function clearToken(): void {
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    // Also clear the old drive-only key if it exists
    localStorage.removeItem("google_drive_access_token");
  }
}
