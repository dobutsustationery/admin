/**
 * Google Drive Integration Service
 *
 * This module provides OAuth authentication and file upload functionality
 * for Google Drive integration in the Dobutsu Admin application.
 */

import type { drive_v3 } from "googleapis";

// Environment configuration
const CLIENT_ID = import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID;
const FOLDER_ID = import.meta.env.VITE_GOOGLE_DRIVE_FOLDER_ID;
const SCOPES = (
  import.meta.env.VITE_GOOGLE_DRIVE_SCOPES ||
  "https://www.googleapis.com/auth/drive.file"
).split(",");

// OAuth token storage key
const TOKEN_STORAGE_KEY = "google_drive_access_token";

/**
 * OAuth token information
 */
export interface GoogleDriveToken {
  access_token: string;
  expires_in: number;
  expires_at: number;
  scope: string;
  token_type: string;
}

/**
 * File upload response
 */
export interface DriveFileInfo {
  id: string;
  name: string;
  webViewLink: string;
  webContentLink?: string;
}

/**
 * Drive file metadata
 */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  webViewLink?: string;
}

/**
 * Check if Google Drive is configured
 */
export function isDriveConfigured(): boolean {
  return !!(
    CLIENT_ID &&
    FOLDER_ID &&
    CLIENT_ID !== "your-client-id.apps.googleusercontent.com"
  );
}

/**
 * Get stored access token if it exists and is not expired
 */
export function getStoredToken(): GoogleDriveToken | null {
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

    const token = parsed as GoogleDriveToken;

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
export function storeToken(token: GoogleDriveToken): void {
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
 * Check if user is authenticated with Google Drive
 */
export function isAuthenticated(): boolean {
  return getStoredToken() !== null;
}

/**
 * Initiate OAuth flow to authenticate with Google Drive
 * Uses Google's OAuth 2.0 for client-side web applications
 */
export function initiateOAuthFlow(): void {
  if (!isDriveConfigured()) {
    console.error(
      "Google Drive is not configured. Please set VITE_GOOGLE_DRIVE_CLIENT_ID and VITE_GOOGLE_DRIVE_FOLDER_ID",
    );
    return;
  }

  // Build OAuth URL
  const redirectUri = `${window.location.origin}/csv`;
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: SCOPES.join(" "),
    include_granted_scopes: "true",
    state: "drive_auth",
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  // Redirect to Google OAuth
  window.location.href = authUrl;
}

/**
 * Handle OAuth callback and extract token from URL hash
 * Call this on page load to check for OAuth redirect
 */
export function handleOAuthCallback(): GoogleDriveToken | null {
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

    if (!accessToken || !expiresIn) {
      return null;
    }

    const token: GoogleDriveToken = {
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
 * List files in the configured Google Drive folder
 */
export async function listFilesInFolder(
  accessToken: string,
): Promise<DriveFile[]> {
  if (!FOLDER_ID) {
    throw new Error("Google Drive folder ID is not configured");
  }

  const params = new URLSearchParams({
    q: `'${FOLDER_ID}' in parents and trashed=false`,
    fields: "files(id,name,mimeType,modifiedTime,size,webViewLink)",
    orderBy: "modifiedTime desc",
    pageSize: "50",
  });

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to list files: ${response.statusText}`);
  }

  const data = (await response.json()) as { files: DriveFile[] };
  return data.files || [];
}

/**
 * Upload a CSV file to Google Drive
 */
export async function uploadCSVToDrive(
  filename: string,
  csvContent: string,
  accessToken: string,
): Promise<DriveFileInfo> {
  if (!FOLDER_ID) {
    throw new Error("Google Drive folder ID is not configured");
  }

  // Create file metadata
  const metadata = {
    name: filename,
    mimeType: "text/csv",
    parents: [FOLDER_ID],
  };

  // Create multipart request body with random boundary
  const boundary = `----FormBoundary${Math.random().toString(36).substring(2)}`;
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const body =
    delimiter +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) +
    delimiter +
    "Content-Type: text/csv\r\n\r\n" +
    csvContent +
    closeDelimiter;

  // Upload file
  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: body,
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to upload file: ${response.statusText} - ${errorText}`,
    );
  }

  const fileInfo = (await response.json()) as DriveFileInfo;
  return fileInfo;
}

/**
 * Get the configured folder ID
 */
export function getFolderId(): string | undefined {
  return FOLDER_ID;
}

/**
 * Get folder link to view in Google Drive
 */
export function getFolderLink(): string | undefined {
  if (!FOLDER_ID) return undefined;
  return `https://drive.google.com/drive/folders/${FOLDER_ID}`;
}

/**
 * Download a file's content from Google Drive
 */
export async function downloadFile(
  fileId: string,
  accessToken: string,
): Promise<string> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to download file: ${response.statusText} - ${errorText}`,
    );
  }

  return await response.text();
}
