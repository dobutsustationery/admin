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

export function storeToken(token: GoogleAuthToken): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(token));
}

export function handleOAuthCallback(): {
  token: GoogleAuthToken;
  returnUrl?: string;
} | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (!hash || !hash.includes("access_token=")) return null;

  try {
    const params = new URLSearchParams(hash.substring(1));
    const accessToken = params.get("access_token");
    const expiresIn = params.get("expires_in");
    const scope = params.get("scope");
    const tokenType = params.get("token_type");
    const state = params.get("state") || "";

    if (!accessToken || !expiresIn) return null;

    const token: GoogleAuthToken = {
      access_token: accessToken,
      expires_in: parseInt(expiresIn, 10),
      expires_at: Date.now() + parseInt(expiresIn, 10) * 1000,
      scope: scope || "",
      token_type: tokenType || "Bearer",
    };

    storeToken(token);

    // If we are inside an iframe, notify the parent and stop
    if (window.self !== window.top) {
      console.log("[Auth] Iframe detected, notifying parent...");
      window.parent.postMessage(
        { type: "GOOGLE_AUTH_REFRESH_SUCCESS", token },
        window.location.origin,
      );
      return { token };
    }

    // Clean up URL hash (only if not in iframe, to avoid jank in parent if they are looking)
    window.history.replaceState({}, document.title, window.location.pathname);

    // Parse return URL from state if present (format: "unified_auth|url")
    let returnUrl: string | undefined = undefined;
    if (state.includes("|")) {
      returnUrl = decodeURIComponent(state.split("|")[1]);
    }

    return { token, returnUrl };
  } catch (e) {
    console.error("[Auth] Error handling callback:", e);
    return null;
  }
}

export function initiateOAuthFlow(
  allowSwitchAccount = false,
  returnUrl?: string,
  silent = false,
): void {
  const currentPath = window.location.pathname + window.location.search;
  const effectiveReturnUrl = returnUrl || currentPath;

  const redirectUri = `${window.location.origin}/photos`;
  const state = `unified_auth|${encodeURIComponent(effectiveReturnUrl)}`;

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
  } else if (silent) {
    params.set("prompt", "none");
  }

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  if (silent) {
    // Create hidden iframe for silent refresh
    console.log("[Auth] Creating hidden iframe for silent refresh...");
    const iframe = document.createElement("iframe");
    iframe.id = "google-auth-silent-refresh-iframe";
    iframe.style.display = "none";
    iframe.src = authUrl;
    document.body.appendChild(iframe);

    // Cleanup iframe after timeout
    setTimeout(() => {
      const existing = document.getElementById(
        "google-auth-silent-refresh-iframe",
      );
      if (existing) document.body.removeChild(existing);
    }, 30000);
  } else {
    window.location.href = authUrl;
  }
}

export async function refreshTokensSilently(): Promise<boolean> {
  console.log("[Auth] Initiating unified token refresh via iframe...");

  return new Promise((resolve) => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "GOOGLE_AUTH_REFRESH_SUCCESS") {
        console.log("[Auth] Silent refresh succeeded via message.");
        window.removeEventListener("message", handleMessage);
        resolve(true);
      }
    };

    window.addEventListener("message", handleMessage);

    // Attempt silent refresh
    initiateOAuthFlow(false, undefined, true);

    // Timeout after 10s
    setTimeout(() => {
      window.removeEventListener("message", handleMessage);
      resolve(false);
    }, 10000);
  });
}

export function clearToken(): void {
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    // Also clear the old drive-only key if it exists
    localStorage.removeItem("google_drive_access_token");
  }
}
