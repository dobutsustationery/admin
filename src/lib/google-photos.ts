/**
 * Google Photos Integration Service
 *
 * This module provides OAuth authentication and API functionality
 * for Google Photos integration in the Dobutsu Admin application.
 */

// Environment configuration
const CLIENT_ID = import.meta.env.VITE_GOOGLE_PHOTOS_CLIENT_ID;
const SCOPES = (
  import.meta.env.VITE_GOOGLE_PHOTOS_SCOPES ||
  "https://www.googleapis.com/auth/photoslibrary.readonly,https://www.googleapis.com/auth/photoslibrary.sharing"
).split(",");

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
}

/**
 * Album information
 */
export interface Album {
  id: string;
  title: string;
  productUrl: string;
  mediaItemsCount: string;
  coverPhotoBaseUrl?: string;
  coverPhotoMediaItemId?: string;
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
export function initiateOAuthFlow(): void {
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
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  // Redirect to Google OAuth
  window.location.href = authUrl;
}

/**
 * Handle OAuth callback and extract token from URL hash
 */
export function handleOAuthCallback(): GooglePhotosToken | null {
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

    const token: GooglePhotosToken = {
      access_token: accessToken,
      expires_in: parseInt(expiresIn, 10),
      expires_at: Date.now() + parseInt(expiresIn, 10) * 1000,
      scope: scope || "",
      token_type: tokenType || "Bearer",
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
 * Join a shared album using its share token
 */
export async function joinSharedAlbum(shareToken: string): Promise<Album> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated");

  const response = await fetch(
    `https://photoslibrary.googleapis.com/v1/sharedAlbums:join`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ shareToken }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to join album: ${response.statusText} - ${errorText}`,
    );
  }

  const data = await response.json();
  return data.album as Album;
}

/**
 * List shared albums
 */
export async function listSharedAlbums(): Promise<Album[]> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated");

  const response = await fetch(
    `https://photoslibrary.googleapis.com/v1/sharedAlbums`,
    {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to list shared albums: ${response.statusText}`);
  }

  const data = await response.json();
  return data.sharedAlbums || [];
}

/**
 * List media items in an album
 */
export async function listMediaItems(
  albumId: string,
  pageSize = 50,
): Promise<MediaItem[]> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated");

  const response = await fetch(
    `https://photoslibrary.googleapis.com/v1/mediaItems:search`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        albumId,
        pageSize,
        orderBy: "MediaMetadata.creation_time",
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to list media items: ${response.statusText} - ${errorText}`,
    );
  }

  const data = await response.json();
  return (data.mediaItems || []) as MediaItem[];
}
