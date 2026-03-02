/**
 * Google Photos Integration Service (Picker API)
 *
 * This module provides API functionality for Google Photos integration
 * using the Picker API. Authentication is handled by google-auth-unified.ts.
 */

import {
  getStoredToken as getUnifiedToken,
  isAuthenticated as isUnifiedAuthenticated,
  initiateOAuthFlow as initiateUnifiedOAuthFlow,
  clearToken as clearUnifiedToken,
  getExpiryInfo as getUnifiedExpiryInfo,
  refreshTokensSilently as refreshUnifiedTokensSilently,
  handleOAuthCallback as handleUnifiedOAuthCallback,
  storeToken as storeUnifiedToken,
  type GoogleAuthToken,
} from "./google-auth-unified";

// Preferred client ID from unified service
const CLIENT_ID = import.meta.env.VITE_GOOGLE_PHOTOS_CLIENT_ID;

/**
 * OAuth token information
 */
export type GooglePhotosToken = GoogleAuthToken;

/**
 * Get stored access token from unified service
 */
export const getStoredToken = getUnifiedToken;

/**
 * Check if Google Photos is configured
 */
export function isPhotosConfigured(): boolean {
  if (typeof window !== "undefined" && (window as any).__MOCK_PHOTOS_CONFIG__) {
    return true;
  }
  return !!(
    CLIENT_ID && CLIENT_ID !== "your-client-id.apps.googleusercontent.com"
  );
}

/**
 * Store access token (kept for backward compatibility)
 */
export const storeToken = storeUnifiedToken;

/**
 * Clear stored access token
 */
export const clearToken = clearUnifiedToken;

/**
 * Check if user is authenticated
 */
export const isAuthenticated = isUnifiedAuthenticated;

/**
 * Get information about token expiry
 */
export const getExpiryInfo = getUnifiedExpiryInfo;

/**
 * Attempt to refresh tokens silently
 */
export const refreshTokensSilently = refreshUnifiedTokensSilently;

/**
 * Initiate OAuth flow
 */
export function initiateOAuthFlow(allowSwitchAccount = false): void {
  initiateUnifiedOAuthFlow(allowSwitchAccount);
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
  mediaMetadata?: {
    creationTime?: string;
    width?: string;
    height?: string;
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

function normalizeMediaItem(raw: any): MediaItem {
  const mediaFile = raw?.mediaFile || {};
  const metadata = raw?.mediaMetadata || {};
  const mediaFileMetadata = mediaFile?.mediaFileMetadata || {};
  return {
    id: String(raw?.id || ""),
    description: raw?.description,
    productUrl: String(raw?.productUrl || mediaFile?.productUrl || ""),
    baseUrl: String(raw?.baseUrl || mediaFile?.baseUrl || ""),
    mimeType: String(raw?.mimeType || mediaFile?.mimeType || ""),
    filename: String(raw?.filename || mediaFile?.filename || ""),
    mediaMetadata: {
      // Picker responses can use creationTime or createTime.
      creationTime:
        metadata.creationTime ||
        mediaFileMetadata?.creationTime ||
        metadata.createTime ||
        raw?.createTime ||
        "",
      width: String(metadata.width || mediaFileMetadata?.width || ""),
      height: String(metadata.height || mediaFileMetadata?.height || ""),
      photo: metadata.photo || mediaFileMetadata?.photo,
      video: metadata.video || mediaFileMetadata?.video,
    },
  };
}

/**
 * Handle OAuth callback and extract token from URL hash
 * Note: Redirect normally goes to /photos, which should call this.
 */
export async function handleOAuthCallback(): Promise<{
  token: GooglePhotosToken;
  returnUrl?: string;
} | null> {
  const result = handleUnifiedOAuthCallback();
  if (!result) return null;

  // Optional: fetch user email if not already present
  if (result.token.access_token && !result.token.user_email) {
    try {
      const userInfoRes = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        { headers: { Authorization: `Bearer ${result.token.access_token}` } },
      );
      if (userInfoRes.ok) {
        const userInfo = await userInfoRes.json();
        result.token.user_email = userInfo.email;
        storeUnifiedToken(result.token);
      }
    } catch (e) {}
  }

  return result;
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
      body: JSON.stringify({}),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to create picker session: ${response.statusText} - ${errorText}`,
    );
  }

  return (await response.json()) as PickerSession;
}

/**
 * Poll a Picker session
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
      headers: { Authorization: `Bearer ${token.access_token}` },
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to poll picker session: ${response.statusText} - ${errorText}`,
    );
  }
  return (await response.json()) as PickerSession;
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

  const params = new URLSearchParams({
    sessionId,
    pageSize: String(pageSize),
  });

  const response = await fetch(
    `https://photospicker.googleapis.com/v1/mediaItems?${params.toString()}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token.access_token}` },
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to list media items: ${response.statusText} - ${errorText}`,
    );
  }

  const data = await response.json();
  return ((data.mediaItems || []) as any[]).map(normalizeMediaItem);
}

/**
 * List media items from a specific album
 */
export async function listAlbumMediaItems(
  albumId: string,
  pageSize = 100,
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
  return ((data.mediaItems || []) as any[]).map(normalizeMediaItem);
}

/**
 * Get all categorized photos currently in the store, sorted by time
 */
export function getSortedCategorizedPhotos(
  janCodeToPhotos: Record<string, MediaItem[]>,
): MediaItem[] {
  const allItems = Object.values(janCodeToPhotos).flat();
  return allItems.sort((a, b) => {
    const tA = new Date(a.mediaMetadata?.creationTime || 0).getTime();
    const tB = new Date(b.mediaMetadata?.creationTime || 0).getTime();
    if (tA !== tB) return tA - tB;
    return (a.id || "").localeCompare(b.id || "");
  });
}
