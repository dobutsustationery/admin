/**
 * Google Drive Integration Service
 *
 * This module provides OAuth authentication and file upload functionality
 * for Google Drive integration in the Dobutsu Admin application.
 */

import type { drive_v3 } from "googleapis";
import { toGoogleDrivePublicImageUrl } from "$lib/drive-url";

// Constant for idempotency property
export const DERIVATION_KEY_PROPERTY = "derivation_key";

/**
 * Calculate a simple SHA-256 hash of a Blob/File for stable identification.
 */
export async function calculateHash(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a deterministic derivation key for a file in Drive
 * Format: {source_type}:{source_id}:{transform_name}
 */
export function generateDerivationKey(
  type: "photos" | "ext" | "drive",
  id: string,
  transform: "identity" | "remove_bg" | "crop" | string,
): string {
  // Simple normalization: no colons in IDs
  const safeId = id.replace(/:/g, "_");
  return `${type}:${safeId}:${transform}`;
}

// Environment configuration
const CLIENT_ID =
  (typeof window !== "undefined" &&
    (window as any).__GOOGLE_DRIVE_CLIENT_ID__) ||
  import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID;
const FOLDER_ID =
  (typeof window !== "undefined" &&
    (window as any).__GOOGLE_DRIVE_FOLDER_ID__) ||
  import.meta.env.VITE_GOOGLE_DRIVE_FOLDER_ID;
const SCOPES = (
  (typeof window !== "undefined" && (window as any).__GOOGLE_DRIVE_SCOPES__) ||
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
  thumbnailLink?: string;
  publicUrl?: string; // Public image link (lh3.googleusercontent.com/d/{id}=s0)
  apiUrl?: string; // API Media link (googleapis.com/.../files/{id}?alt=media)
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
  webViewLink?: string; // Preview (HTML)
  webContentLink?: string; // Download
  thumbnailLink?: string; // Low res or expiry-prone
  publicUrl?: string;
  apiUrl?: string;
}

function hydrateDriveFiles(files: DriveFile[]): DriveFile[] {
  return files.map((f) => {
    const apiUrl = `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`;
    return {
      ...f,
      publicUrl: toGoogleDrivePublicImageUrl(apiUrl),
      apiUrl,
    };
  });
}

async function fetchDriveFileById(
  accessToken: string,
  fileId: string,
): Promise<DriveFile | null> {
  const params = new URLSearchParams({
    fields:
      "id,name,mimeType,modifiedTime,size,webViewLink,webContentLink,thumbnailLink",
  });

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    if (response.status === 401) {
      console.error("Google Drive Token Expired (401). Clearing token.");
      clearToken();
    }
    throw new Error(
      `Failed to fetch Drive file ${fileId}: ${response.statusText}`,
    );
  }

  const file = (await response.json()) as DriveFile;
  return file;
}

function looksLikeDriveFileId(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,}$/.test(value.trim());
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Build a query string for searching by derivation key.
 */
export function buildDerivationKeyQuery(derivationKey: string): string {
  return `appProperties has { key='${DERIVATION_KEY_PROPERTY}' and value='${escapeDriveQueryValue(derivationKey)}' } and trashed=false`;
}

/**
 * Fast-path lookup for a single image by exact file ID or exact filename.
 * Used by live E2E imports to avoid broad folder scans.
 */
export async function findSingleImage(
  accessToken: string,
  preferred: string,
): Promise<DriveFile | null> {
  const trimmed = preferred.trim();
  if (!trimmed) return null;

  if (looksLikeDriveFileId(trimmed)) {
    const byId = await fetchDriveFileById(accessToken, trimmed);
    if (byId && byId.mimeType?.startsWith("image/")) {
      return hydrateDriveFiles([byId])[0];
    }
  }

  const params = new URLSearchParams({
    q: `name = '${escapeDriveQueryValue(trimmed)}' and mimeType contains 'image/' and trashed=false`,
    fields:
      "files(id,name,mimeType,modifiedTime,size,webViewLink,webContentLink,thumbnailLink)",
    orderBy: "modifiedTime desc",
    pageSize: "5",
  });

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!response.ok) {
    if (response.status === 401) {
      console.error("Google Drive Token Expired (401). Clearing token.");
      clearToken();
    }
    throw new Error(
      `Failed to search Drive images by name: ${response.statusText}`,
    );
  }

  const data = (await response.json()) as { files?: DriveFile[] };
  const first = (data.files || [])[0];
  return first ? hydrateDriveFiles([first])[0] : null;
}

/**
 * Fast-path fallback for E2E imports: get a small recent set of image files.
 * This avoids expensive recursive-ish folder scans when the test only needs 1-2 images.
 */
export async function listRecentImages(
  accessToken: string,
  limit = 10,
): Promise<DriveFile[]> {
  if (!FOLDER_ID) {
    throw new Error("Google Drive folder ID is not configured");
  }

  const pageSize = String(Math.max(1, Math.min(Math.max(limit * 2, 8), 50)));
  const listInParent = async (parentId: string): Promise<DriveFile[]> => {
    const params = new URLSearchParams({
      q: `'${parentId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields:
        "files(id,name,mimeType,modifiedTime,size,webViewLink,webContentLink,thumbnailLink)",
      orderBy: "modifiedTime desc",
      pageSize,
    });
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    if (!response.ok) {
      if (response.status === 401) {
        console.error("Google Drive Token Expired (401). Clearing token.");
        clearToken();
      }
      throw new Error(
        `Failed to list images in ${parentId}: ${response.statusText}`,
      );
    }
    const data = (await response.json()) as { files?: DriveFile[] };
    return data.files || [];
  };

  const [rootImages, imagesId, seedId] = await Promise.all([
    listInParent(FOLDER_ID),
    findFolder("Images", FOLDER_ID, accessToken),
    findFolder("Seed", FOLDER_ID, accessToken),
  ]);

  const [imagesFolderImages, seedImages] = await Promise.all([
    imagesId ? listInParent(imagesId) : Promise.resolve([]),
    seedId ? listInParent(seedId) : Promise.resolve([]),
  ]);

  let originalsId: string | null = null;
  let processedId: string | null = null;
  if (imagesId) {
    [originalsId, processedId] = await Promise.all([
      findFolder("Originals", imagesId, accessToken),
      findFolder("Processed", imagesId, accessToken),
    ]);
  }

  const [originalsImages, processedImages] = await Promise.all([
    originalsId ? listInParent(originalsId) : Promise.resolve([]),
    processedId ? listInParent(processedId) : Promise.resolve([]),
  ]);

  const all = [
    ...rootImages,
    ...seedImages,
    ...imagesFolderImages,
    ...originalsImages,
    ...processedImages,
  ]
    .sort((a, b) => {
      const tA = new Date(a.modifiedTime || 0).getTime();
      const tB = new Date(b.modifiedTime || 0).getTime();
      return tB - tA;
    })
    .slice(0, Math.max(1, limit));

  return hydrateDriveFiles(all);
}

/**
 * Check if Google Drive is configured
 */
export function isDriveConfigured(): boolean {
  // Allow test bypass
  if (typeof window !== "undefined" && (window as any).__MOCK_DRIVE_CONFIG__) {
    return true;
  }
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
export function initiateOAuthFlow(returnUrl?: string): void {
  if (!isDriveConfigured()) {
    console.error(
      "Google Drive is not configured. Please set VITE_GOOGLE_DRIVE_CLIENT_ID and VITE_GOOGLE_DRIVE_FOLDER_ID",
    );
    return;
  }

  // Build OAuth URL
  const redirectUri =
    import.meta.env.VITE_GOOGLE_DRIVE_REDIRECT_URI ||
    `${window.location.origin}/csv`;

  // Encode return URL in state if provided
  // We encode the return URL to ensure special characters don't break the state parsing
  const state = returnUrl
    ? `drive_auth|${encodeURIComponent(returnUrl)}`
    : "drive_auth";

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: SCOPES.join(" "),
    include_granted_scopes: "true",
    state: state,
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  // Redirect to Google OAuth
  window.location.href = authUrl;
}

/**
 * Handle OAuth callback and extract token from URL hash
 * Call this on page load to check for OAuth redirect
 */
export function handleOAuthCallback(): {
  token: GoogleDriveToken;
  state?: string;
} | null {
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

    return { token, state: state || undefined };
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
    if (response.status === 401) {
      console.error("Google Drive Token Expired (401). Clearing token.");
      clearToken();
    }
    throw new Error(`Failed to list files: ${response.statusText}`);
  }

  const data = (await response.json()) as { files: DriveFile[] };
  return data.files || [];
}

/**
 * List all images in the configured folder (recursive or flat depending on need, flat for now)
 * Used to discover files for Listing Creation.
 */
export async function listAllImages(accessToken: string): Promise<DriveFile[]> {
  if (!FOLDER_ID) {
    throw new Error("Google Drive folder ID is not configured");
  }

  // Search for images in the folder tree?
  // Or just strictly in the folder?
  // The requirement implies finding images for JANs. These might be in subfolders or root.
  // Let's search recursively in the folder ID tree?
  // 'q' param 'ancestors' is not directly supported in 'q', uses 'parents' for direct.
  // For deep search, we might need to rely on name convention or just search everything user has access to that looks like our data?
  // Safer: Search for mimeType = image/ inside FOLDER_ID (direct parent) for now.
  // If we need recursive, we need to iterate folders.
  // Wait, the previous logic (Photos) was flattened.
  // Let's assume a flat structure in the "Images" folder or "Processed" folder?
  // User said "the photos are stored in google drive".
  // Let's search in the configured root FOLDER_ID and its children?
  // Actually, 'q': `'${FOLDER_ID}' in parents` is direct.

  // Let's try to be broad: specific mimeType image/* and trashed=false.
  // BUT we should scope it to our folder if possible.
  // If files are in subfolders (e.g. "Images/Originals"), direct parent query won't find them.
  // Workaround: We can search for everything and filter? No, too many files.

  // Let's stick to the "Images" folder structure we defined: Root -> Images -> [Originals, Processed]
  // So we should search in "Images" folder ID?
  // We can use `ensureFolderStructure` to get the IDs, then search in them?
  // That seems safer.

  // Helper to search in a specific parent
  const searchInParent = async (parentId: string): Promise<DriveFile[]> => {
    const params = new URLSearchParams({
      q: `'${parentId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields:
        "files(id,name,mimeType,modifiedTime,size,webViewLink,webContentLink,thumbnailLink)",
      pageSize: "1000", // Fetch a lot
      orderBy: "name",
    });

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    if (!res.ok) {
      if (res.status === 401) {
        console.error("Google Drive Token Expired (401). Clearing token.");
        clearToken();
      }
      throw new Error(`Failed to list images in ${parentId}`);
    }
    const data = await res.json();
    return data.files || [];
  };

  try {
    // Get structure
    // This might be slow if we call it every time.
    // Ideally we cache these IDs or passed them.
    // For now, let's just find "Images" folder inside ROOT.
    // Search in Root FOLDER_ID
    const rootImages = await searchInParent(FOLDER_ID);

    // Search in "Images" folder (if exists)
    const imagesId = await findFolder("Images", FOLDER_ID, accessToken);
    const imagesFolderImages = imagesId ? await searchInParent(imagesId) : [];

    // Search in "Seed" (fixtures) if present at root.
    const seedId = await findFolder("Seed", FOLDER_ID, accessToken);
    const seedImages = seedId ? await searchInParent(seedId) : [];

    // Search in "Originals" (if exists, inside Images)
    let originalsImages: DriveFile[] = [];
    if (imagesId) {
      const originalsId = await findFolder("Originals", imagesId, accessToken);
      if (originalsId) originalsImages = await searchInParent(originalsId);
    }

    // Search in "Processed" (if exists, inside Images)
    let processedImages: DriveFile[] = [];
    if (imagesId) {
      const processedId = await findFolder("Processed", imagesId, accessToken);
      if (processedId) processedImages = await searchInParent(processedId);
    }

    return [
      ...hydrateDriveFiles(rootImages),
      ...hydrateDriveFiles(seedImages),
      ...hydrateDriveFiles(imagesFolderImages),
      ...hydrateDriveFiles(originalsImages),
      ...hydrateDriveFiles(processedImages),
    ];
  } catch (e) {
    console.error("Error listing all images:", e);
    return [];
  }
}

/**
 * Search for a file by its derivation key in appProperties.
 */
export async function findFileByDerivationKey(
  accessToken: string,
  derivationKey: string,
): Promise<DriveFile | null> {
  const query = buildDerivationKeyQuery(derivationKey);
  const params = new URLSearchParams({
    q: query,
    fields:
      "files(id,name,mimeType,modifiedTime,size,webViewLink,webContentLink,thumbnailLink)",
    pageSize: "1",
  });

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!response.ok) {
    if (response.status === 401) {
      console.error("Google Drive Token Expired (401). Clearing token.");
      clearToken();
    }
    throw new Error(
      `Failed to search by derivation key: ${response.statusText}`,
    );
  }

  const data = (await response.json()) as { files?: DriveFile[] };
  const first = (data.files || [])[0];
  return first ? hydrateDriveFiles([first])[0] : null;
}

/**
 * Upload a CSV file to Google Drive
 */
export async function uploadCSVToDrive(
  filename: string,
  csvContent: string,
  accessToken: string,
  derivationKey?: string,
): Promise<DriveFileInfo> {
  if (!FOLDER_ID) {
    throw new Error("Google Drive folder ID is not configured");
  }

  // Create file metadata
  const metadata: any = {
    name: filename,
    mimeType: "text/csv",
    parents: [FOLDER_ID],
  };

  if (derivationKey) {
    metadata.appProperties = { [DERIVATION_KEY_PROPERTY]: derivationKey };
  }

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
/**
 * Find a folder by name within a parent folder
 */
export async function findFolder(
  name: string,
  parentId: string,
  accessToken: string,
): Promise<string | null> {
  const query = `'${parentId}' in parents and name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const params = new URLSearchParams({
    q: query,
    fields: "files(id, name)",
    pageSize: "1",
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
    if (response.status === 401) {
      console.error("Google Drive Token Expired (401). Clearing token.");
      clearToken();
    }
    throw new Error(`Failed to find folder '${name}': ${response.statusText}`);
  }

  const data = await response.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

/**
 * Create a new folder
 */
export async function createFolder(
  name: string,
  parentId: string,
  accessToken: string,
): Promise<string> {
  const metadata = {
    name,
    mimeType: "application/vnd.google-apps.folder",
    parents: [parentId],
  };

  const response = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(metadata),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to create folder '${name}': ${response.statusText}`,
    );
  }

  const file = await response.json();
  return file.id;
}

/**
 * Ensure the required folder structure exists: Root -> Images -> [Originals, Processed]
 * Returns object with folder IDs
 */
export async function ensureFolderStructure(
  accessToken: string,
): Promise<{ originalsId: string; processedId: string }> {
  if (!FOLDER_ID) throw new Error("Root folder ID not configured");

  // 1. Find or Create "Images" folder
  let imagesId = await findFolder("Images", FOLDER_ID, accessToken);
  if (!imagesId) {
    imagesId = await createFolder("Images", FOLDER_ID, accessToken);
    // Make Images folder public/readable if needed? Or just files?
    // Usually standard to make files readable.
  }

  // 2. Find or Create "Originals"
  let originalsId = await findFolder("Originals", imagesId, accessToken);
  if (!originalsId) {
    originalsId = await createFolder("Originals", imagesId, accessToken);
  }

  // 3. Find or Create "Processed"
  let processedId = await findFolder("Processed", imagesId, accessToken);
  if (!processedId) {
    processedId = await createFolder("Processed", imagesId, accessToken);
  }

  return { originalsId, processedId };
}

/**
 * Set file permissions to be readable by anyone (or specific logic)
 * For now: role=reader, type=anyone
 */
export async function setFilePermissions(
  fileId: string,
  accessToken: string,
): Promise<void> {
  const permission = {
    role: "reader",
    type: "anyone",
  };

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(permission),
    },
  );

  if (!response.ok) {
    const err = await response.text();
    // Allow race condition where it's already public
    console.warn(`Failed to set permissions for ${fileId}: ${err}`);
  }
}

/**
 * Rename a file in Drive
 */
export async function renameFile(
  fileId: string,
  newName: string,
  accessToken: string,
): Promise<void> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: newName }),
    },
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to rename file ${fileId}: ${err}`);
  }
}

/**
 * Upload a Blob/File to Drive
 */
export async function uploadImageToDrive(
  blob: Blob,
  filename: string,
  folderId: string,
  accessToken: string,
  derivationKey: string,
): Promise<DriveFileInfo> {
  const metadata = {
    name: filename,
    parents: [folderId],
    appProperties: { [DERIVATION_KEY_PROPERTY]: derivationKey },
  };

  const boundary = `----FormBoundary${Math.random().toString(36).substring(2)}`;
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  // Read blob as base64 or text? Mutipart expects the binary.
  // Actually easiest way for binary upload in browser with metadata is strictly multipart
  // But we need to construct the body carefully.
  // Converting blob to string is tricky without FileReader.

  // Let's use FileReader to get ArrayBuffer -> String
  // OR just two separate requests if that's easier?
  // Drive API supports resumable upload which is cleaner but more steps.
  // Simple multipart:

  // Convert blob to string is the hard part for X HR body.
  // Let's use the resumable upload flow for robustness with binary data.
  // 1. Initiate Resumable Session
  // 2. Upload bytes

  const initRes = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        // We must specify X-Upload-Content-Type or Content-Type in body
      },
      body: JSON.stringify(metadata),
    },
  );

  if (!initRes.ok) {
    const errText = await initRes.text();
    throw new Error(`Failed to initiate upload: ${initRes.status} ${errText}`);
  }

  const uploadUrl = initRes.headers.get("Location");
  if (!uploadUrl) throw new Error("No upload location returned");

  // 2. Upload Data
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      // No Authorization header needed for the session URL usually, but can include
    },
    body: blob,
  });

  if (!uploadRes.ok) throw new Error("Failed to upload file data");

  const fileData = await uploadRes.json();

  // 3. Make public immediately
  await setFilePermissions(fileData.id, accessToken);

  // 4. Get WebContentLink (might need a re-fetch if not in response)
  // File resource is returned in fileData
  // We need webContentLink or webViewLink.
  // By default create returns minimal fields.
  // We can fetch details.

  const detailsParam = new URLSearchParams({
    fields: "id,name,webViewLink,webContentLink,thumbnailLink",
  });

  const detailsRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileData.id}?${detailsParam}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  const details = await detailsRes.json();
  console.log("Drive Upload Details:", details);

  // Optimize usage: thumbnailLink is usually better for embedding.
  // The API-provided `thumbnailLink` can be ephemeral (drive-storage signed links).
  // We prefer the 'permanent' endpoint that redirects to a fresh thumbnail.
  // This ensures the URL stored in our DB works forever.
  if (fileData.id) {
    details.thumbnailLink = `https://drive.google.com/thumbnail?id=${fileData.id}`;
    // Add stable full-size public image URL for app + external systems (e.g. Shopify)
    details.publicUrl = toGoogleDrivePublicImageUrl(String(fileData.id));
    // Add stable API URL for internal app usage (SecureImage)
    details.apiUrl = `https://www.googleapis.com/drive/v3/files/${fileData.id}?alt=media`;
  }

  return details;
}
