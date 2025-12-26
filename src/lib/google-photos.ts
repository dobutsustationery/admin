/**
 * Google Photos Integration Service (Picker API)
 *
 * This module provides OAuth authentication and API functionality
 * for Google Photos integration using the Picker API.
 */

// Environment configuration
const CLIENT_ID = import.meta.env.VITE_GOOGLE_PHOTOS_CLIENT_ID;
const SCOPES = (
  import.meta.env.VITE_GOOGLE_PHOTOS_SCOPES ||
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly,https://www.googleapis.com/auth/drive.file,https://www.googleapis.com/auth/userinfo.email"
)
  .split(",")
  .map((s: string) => s.trim());
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

    // Check if token has required scopes
    // We strictly require Photos access. Drive access is optional for "connection" status.
    const REQUIRED_SCOPES = [
        "https://www.googleapis.com/auth/photospicker.mediaitems.readonly"
    ];

    const missingScopes = REQUIRED_SCOPES.filter(
      (scope: string) => !token.scope.includes(scope),
    );
    
    if (missingScopes.length > 0) {
      console.warn(
        "Token missing CRITICAL scopes:",
        missingScopes,
        "Present scopes:", token.scope,
        "- Invalidating token."
      );
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      return null;
    }
    
    // Warn about optional scopes but don't invalidate
    const optionalScopes = SCOPES.filter((s: string) => !REQUIRED_SCOPES.includes(s));
    const missingOptional = optionalScopes.filter((s: string) => !token.scope.includes(s));
    if (missingOptional.length > 0) {
        console.warn("Token available but missing optional scopes:", missingOptional);
    }

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
export function isAuthenticated(): boolean {
  return getStoredToken() !== null;
}

/**
 * Initiate OAuth flow to authenticate with Google Photos
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
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: SCOPES.join(" "),
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
        const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
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
      user_email: userEmail
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
    return tA - tB; // Ascending: Oldest (Barcode) first
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
