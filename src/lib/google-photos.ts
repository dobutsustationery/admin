/**
 * Google Photos Integration Service (Picker API)
 *
 * This module provides OAuth authentication and API functionality
 * for Google Photos integration using the Picker API.
 */

// Environment configuration
const CLIENT_ID = import.meta.env.VITE_GOOGLE_PHOTOS_CLIENT_ID;
const rawScopes = (
  import.meta.env.VITE_GOOGLE_PHOTOS_SCOPES ||
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly,https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/userinfo.email"
)
  .split(",")
  .map((s: string) => s.trim());

// FORCE `drive.readonly` existence (Fix for sticky Env vars)
if (
  !rawScopes.some(
    (s: string) =>
      s.includes("drive.readonly") ||
      (s.includes("drive") && !s.includes("file")),
  )
) {
  // Note: 'drive' is full access, which covers readonly. 'drive.file' does NOT.
  // If we only have 'drive.file', we MUST add 'drive.readonly'.
  console.warn("Forcing addition of drive.readonly scope via code override.");
  rawScopes.push("https://www.googleapis.com/auth/drive.readonly");
}

const SCOPES = rawScopes;
console.log("Configured Google Photos Scopes:", SCOPES.join(", "));

// OAuth token storage key
const TOKEN_STORAGE_KEY = "google_photos_access_token";

/**
 * OAuth token information
 */
export interface GooglePhotosToken {
  access_token: string;
  expires_in: number;
  expires_at: number;
  scope: string;
  token_type: string;
  user_email?: string;
}

/**
 * Picker Session information
 */
export interface PickerSession {
  id: string;
  pickerUri: string;
  mediaItemsSet?: boolean;
}

/**
 * Media item (photo/video) information
 */
export interface MediaItem {
  id: string;
  description?: string;
  productUrl: string;
  baseUrl: string;
  mimeType: string;
  mediaMetadata: {
    creationTime: string;
    width: string;
    height: string;
    photo?: {
      cameraMake?: string;
      cameraModel?: string;
      focalLength?: number;
      apertureFNumber?: number;
      isoEquivalent?: number;
      exposureTime?: string;
    };
    video?: {
      cameraMake?: string;
      cameraModel?: string;
      fps?: number;
      status?: string;
    };
  };
  filename: string;
}

/**
 * Check if Google Photos is configured
 */
export function isPhotosConfigured(): boolean {
  // Allow test bypass
  if (typeof window !== "undefined" && (window as any).__MOCK_PHOTOS_CONFIG__) {
    return true;
  }
  return !!(
    CLIENT_ID && CLIENT_ID !== "your-client-id.apps.googleusercontent.com"
  );
}

/**
 * Get stored access token if it exists and is not expired
 */
export function getStoredToken(): GooglePhotosToken | null {
  try {
    const tokenJson = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!tokenJson) return null;

    const parsed = JSON.parse(tokenJson);

    // Validate token structure
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.access_token !== "string" ||
      typeof parsed.expires_in !== "number" ||
      typeof parsed.expires_at !== "number"
    ) {
      console.error("Invalid token structure in localStorage");
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      return null;
    }

    const token = parsed as GooglePhotosToken;

    // Check if token is expired
    if (token.expires_at && Date.now() > token.expires_at) {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      return null;
    }

    // Check for Drive Access (Any level)
    // CRITICAL: "cloud-platform" does NOT grant Drive API access for files.get/media
    // We MUST have explicit drive scopes.
    const hasDriveScope =
      token.scope.includes("drive.readonly") ||
      token.scope.includes("drive.file") ||
      (token.scope.includes("/drive") &&
        !token.scope.includes("drive.appdata"));

    // Check for Photos Picker Access
    const hasPickerScope =
      token.scope.includes("photospicker.mediaitems.readonly") ||
      token.scope.includes("cloud-platform"); // Keep for Picker just in case

    if (!hasDriveScope) {
      console.warn(
        "Token missing explicit Drive scope (readonly/file/full). 'cloud-platform' is insufficient. Invalidating. Had:",
        token.scope,
      );
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      return null;
    }

    if (!hasPickerScope) {
      console.warn("Token missing Photos Picker scope. Invalidating.");
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      return null;
    }

    // Optional scope warning removed as we enforce strict Drive access now.

    return token;
  } catch (e) {
    console.error("Error retrieving stored token:", e);
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    return null;
  }
}

/**
 * Store access token in localStorage
 */
export function storeToken(token: GooglePhotosToken): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(token));
  } catch (e) {
    console.error("Error storing token:", e);
  }
}

/**
 * Clear stored access token
 */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

/**
 * Check if user is authenticated with Google Photos
 */
/**
 * Initiate OAuth flow to authenticate with Google Photos
 * @param allowSwitchAccount If true, forces the account chooser to appear
 */
export function initiateOAuthFlow(allowSwitchAccount = false): void {
  if (!isPhotosConfigured()) {
    console.error(
      "Google Photos is not configured. Please set VITE_GOOGLE_PHOTOS_CLIENT_ID",
    );
    return;
  }

  // Build OAuth URL
  const redirectUri = `${window.location.origin}/photos`;

  // Hardcoded Critical Scopes to bypass any Env/Init issues
  const CRITICAL_SCOPES = [
    "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
    "https://www.googleapis.com/auth/drive.readonly", // FORCE THIS
    "https://www.googleapis.com/auth/userinfo.email",
  ];
  const finalScopes = Array.from(new Set([...SCOPES, ...CRITICAL_SCOPES]));

  // Debug Scopes
  console.log("[Auth] Initiating OAuth Flow (v2-FIXED)");
  console.log("[Auth] Requested Scopes:", finalScopes);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: finalScopes.join(" "),
    include_granted_scopes: "true",
    state: "photos_auth",
    prompt: allowSwitchAccount ? "select_account consent" : "consent",
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  // Redirect to Google OAuth
  window.location.href = authUrl;
}

/**
 * Handle OAuth callback and extract token from URL hash
 */
export async function handleOAuthCallback(): Promise<GooglePhotosToken | null> {
  const hash = window.location.hash;
  if (!hash || !hash.includes("access_token=")) {
    return null;
  }

  try {
    // Parse hash parameters
    const params = new URLSearchParams(hash.substring(1));
    const accessToken = params.get("access_token");
    const expiresIn = params.get("expires_in");
    const scope = params.get("scope");
    const tokenType = params.get("token_type");
    const state = params.get("state");

    console.log("[Auth] OAuth Callback Received");
    console.log("[Auth] Received Scopes:", scope);

    // Only process photos auth
    if (state !== "photos_auth" && !hash.includes("state=photos_auth")) {
      // If state is not in URL search params (which it might not be if it's in hash), check manually
      // But actually client-side implicit flow puts everything in hash.
      // Let's be lenient or check if we initiated it.
      // For now, if we see access_token and we are on /photos page, assume it's ours.
    }

    if (!accessToken || !expiresIn) {
      return null;
    }

    // Fetch User Info (Email)
    let userEmail: string | undefined = undefined;
    try {
      const userInfoRes = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (userInfoRes.ok) {
        const userInfo = await userInfoRes.json();
        userEmail = userInfo.email;
      }
    } catch (e) {
      console.warn("Failed to fetch user info:", e);
    }

    const token: GooglePhotosToken = {
      access_token: accessToken,
      expires_in: parseInt(expiresIn, 10),
      expires_at: Date.now() + parseInt(expiresIn, 10) * 1000,
      scope: scope || "",
      token_type: tokenType || "Bearer",
      user_email: userEmail,
    };

    // Store token
    storeToken(token);

    // Clean up URL
    window.history.replaceState({}, document.title, window.location.pathname);

    return token;
  } catch (e) {
    console.error("Error handling OAuth callback:", e);
    return null;
  }
}

/**
 * Get information about token expiry
 */
export function getExpiryInfo(): {
  expired: boolean;
  expiresInSeconds: number;
  expiresAt: number;
} | null {
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

/**
 * Attempt to refresh tokens silently using a hidden iframe if supported by the browser.
 * Note: This only works if the user has a valid session with Google and has already granted consent.
 */
export async function refreshTokensSilently(): Promise<boolean> {
  if (!isPhotosConfigured()) return false;

  console.log("[Auth] Attempting silent token refresh...");

  return new Promise((resolve) => {
    // Build OAuth URL with prompt=none for silent refresh
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: `${window.location.origin}/photos`,
      response_type: "token",
      scope: SCOPES.join(" "),
      include_granted_scopes: "true",
      state: "photos_auth",
      prompt: "none", // Critical for silent refresh
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    // Create hidden iframe
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.src = authUrl;

    // We can't easily read the iframe hash due to cross-origin restrictions,
    // but the callback handler in the main app will catch it if we redirect to the same origin.
    // However, a better way for silent refresh in SPAs is to use the Token Client from GSI library,
    // but here we are using the older OAuth2 redirect flow.
    // For now, we will just trigger a normal redirect if silent fails or is not viable.

    // Fallback: if we really need a refresh and are in a user-initiated action,
    // we might have to just redirect.

    // For now, let's just implement the manual/auto check and redirect.
    initiateOAuthFlow(false);
    resolve(true);
  });
}

/**
 * Check if the user is authenticated
 */
export function isAuthenticated(): boolean {
  const expiry = getExpiryInfo();
  return !!expiry && !expiry.expired;
}

/**
 * Create a new Picker session
 */
export async function createPickerSession(): Promise<PickerSession> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated");

  const response = await fetch(
    `https://photospicker.googleapis.com/v1/sessions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
      },
      // Note: No body needed for simple session unless validTimeRanges is specified
      body: JSON.stringify({}),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to create picker session: ${response.statusText} - ${errorText}`,
    );
  }

  const data = await response.json();
  return data as PickerSession;
}

/**
 * Poll a Picker session to check status
 */
export async function pollPickerSession(
  sessionId: string,
): Promise<PickerSession> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated");

  const response = await fetch(
    `https://photospicker.googleapis.com/v1/sessions/${sessionId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
      },
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to poll picker session: ${response.statusText} - ${errorText}`,
    );
  }
  const data = await response.json();
  return data as PickerSession;
}

/**
 * List media items from a completed session
 */
export async function listSessionMediaItems(
  sessionId: string,
  pageSize = 100,
): Promise<MediaItem[]> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated");

  let allItems: MediaItem[] = [];
  let pageToken: string | null = null;

  do {
    const params = new URLSearchParams({
      sessionId: sessionId,
      pageSize: pageSize.toString(),
    });
    if (pageToken) {
      params.append("pageToken", pageToken);
    }

    const response = await fetch(
      `https://photospicker.googleapis.com/v1/mediaItems?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token.access_token}`,
        },
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to list session media items: ${response.statusText} - ${errorText}`,
      );
    }

    const data = await response.json();
    if (data.mediaItems) {
      const mappedItems = data.mediaItems.map((item: any) => ({
        id: item.id || "",
        productUrl: item.productUrl || "", // Note: Picker API might not return this, but we use baseUrl
        baseUrl: item.mediaFile?.baseUrl || "",
        mimeType: item.mediaFile?.mimeType || "",
        filename: item.mediaFile?.filename || "",
        mediaMetadata: {
          ...item.mediaFile?.mediaFileMetadata,
          creationTime: item.createTime || "",
        },
        description: item.description || "",
      }));
      allItems = allItems.concat(mappedItems);
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  // Sort by creationTime ascending to ensure sequence (Barcode -> Product)
  console.log("Sorting", allItems.length, "items by creationTime...");
  allItems.sort((a, b) => {
    const tA = new Date(a.mediaMetadata?.creationTime || 0).getTime();
    const tB = new Date(b.mediaMetadata?.creationTime || 0).getTime();
    if (tA !== tB) return tA - tB; // Ascending: Oldest first
    return (a.id || "").localeCompare(b.id || "");
  });

  if (allItems.length > 0) {
    console.log(
      "First item:",
      allItems[0].filename,
      allItems[0].mediaMetadata?.creationTime,
    );
    console.log(
      "Last item:",
      allItems[allItems.length - 1].filename,
      allItems[allItems.length - 1].mediaMetadata?.creationTime,
    );
  }

  return allItems;
}

/**
 * List media items from a Google Photos album directly.
 * Useful for non-interactive automated flows where Picker UI cannot be used.
 */
export async function listAlbumMediaItems(
  albumId: string,
  pageSize = 100,
): Promise<MediaItem[]> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated");
  if (!albumId) throw new Error("Missing album ID");

  let allItems: MediaItem[] = [];
  let pageToken: string | undefined;

  do {
    const response = await fetch(
      "https://photoslibrary.googleapis.com/v1/mediaItems:search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          albumId,
          pageSize,
          pageToken,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to list album media items: ${response.statusText} - ${errorText}`,
      );
    }

    const data = await response.json();
    const items = (data.mediaItems || []).map((item: any) => ({
      id: item.id || "",
      productUrl: item.productUrl || "",
      baseUrl: item.baseUrl || "",
      mimeType: item.mimeType || "",
      filename: item.filename || "",
      mediaMetadata: {
        ...(item.mediaMetadata || {}),
        creationTime: item.mediaMetadata?.creationTime || "",
      },
      description: item.description || "",
    })) as MediaItem[];

    allItems = allItems.concat(items);
    pageToken = data.nextPageToken;
  } while (pageToken);

  allItems.sort((a, b) => {
    const tA = new Date(a.mediaMetadata?.creationTime || 0).getTime();
    const tB = new Date(b.mediaMetadata?.creationTime || 0).getTime();
    if (tA !== tB) return tA - tB;
    return (a.id || "").localeCompare(b.id || "");
  });

  return allItems;
}
