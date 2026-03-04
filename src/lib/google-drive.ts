/**
 * Google Drive Integration Service
 *
 * This module provides file upload functionality for Google Drive integration
 * in the Dobutsu Admin application. Authentication is handled by google-auth-unified.ts.
 */

import type { drive_v3 } from "googleapis";
import { toGoogleDrivePublicImageUrl } from "$lib/drive-url";
import {
  DERIVATION_KEY_PROPERTY as SHARED_DERIVATION_KEY_PROPERTY,
  generateDerivationKey as sharedGenerateDerivationKey,
  escapeDriveQueryValue as sharedEscapeDriveQueryValue,
  buildDerivationKeyQuery as sharedBuildDerivationKeyQuery,
  findFileByDerivationKey as sharedFindFileByDerivationKey,
} from "./idempotency-utils";
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

// Re-export properties used by other modules
export const JAN_CODE_FOUND_PROPERTY = "janCodeFound";
export const MERGE_WITH_PROPERTY = "mergeWith";
export const DERIVATION_KEY_PROPERTY = SHARED_DERIVATION_KEY_PROPERTY;

/**
 * Escape a value for use in a Google Drive API query string.
 */
export function escapeDriveQueryValue(value: string): string {
  return sharedEscapeDriveQueryValue(value);
}

/**
 * Calculate a simple SHA-256 hash of a Blob/File for stable identification.
 */
export async function calculateHash(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const hashArray = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", arrayBuffer)),
  );
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
  return sharedGenerateDerivationKey(type, id, transform) || "";
}

// Environment configuration
const CLIENT_ID =
  (typeof window !== "undefined" &&
    (window as any).__GOOGLE_DRIVE_CLIENT_ID__) ||
  import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID ||
  process.env.VITE_GOOGLE_DRIVE_CLIENT_ID;
const FOLDER_ID =
  (typeof window !== "undefined" &&
    (window as any).__GOOGLE_DRIVE_FOLDER_ID__) ||
  import.meta.env.VITE_GOOGLE_DRIVE_FOLDER_ID ||
  process.env.VITE_GOOGLE_DRIVE_FOLDER_ID;

/**
 * OAuth token information
 */
export type GoogleDriveToken = GoogleAuthToken;

const LEGACY_DRIVE_TOKEN_STORAGE_KEY = "google_drive_access_token";

function getLegacyDriveToken(): GoogleDriveToken | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const stored = localStorage.getItem(LEGACY_DRIVE_TOKEN_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed.expires_at !== "number") return null;
    if (Date.now() > parsed.expires_at) {
      localStorage.removeItem(LEGACY_DRIVE_TOKEN_STORAGE_KEY);
      return null;
    }
    return parsed as GoogleDriveToken;
  } catch {
    return null;
  }
}

/**
 * Get stored access token.
 * Choose the freshest token between legacy Drive and unified storage.
 */
export function getStoredToken(): GoogleDriveToken | null {
  const legacy = getLegacyDriveToken();
  const unified = getUnifiedToken();
  if (!legacy) return unified;
  if (!unified) return legacy;
  return legacy.expires_at >= unified.expires_at ? legacy : unified;
}

/**
 * Store access token in both unified and legacy Drive keys.
 */
export function storeToken(token: GoogleDriveToken): void {
  storeUnifiedToken(token);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(LEGACY_DRIVE_TOKEN_STORAGE_KEY, JSON.stringify(token));
  }
}

/**
 * Clear stored access token
 */
export function clearToken(): void {
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(LEGACY_DRIVE_TOKEN_STORAGE_KEY);
  }
  clearUnifiedToken();
}

/**
 * Check if user is authenticated with Google Drive
 */
export function isAuthenticated(): boolean {
  return !!getStoredToken() || isUnifiedAuthenticated();
}

/**
 * Get information about token expiry
 */
export function getExpiryInfo() {
  const token = getStoredToken();
  if (token?.expires_at) {
    const expiresInSeconds = Math.max(
      0,
      Math.floor((token.expires_at - Date.now()) / 1000),
    );
    return {
      expired: expiresInSeconds <= 0,
      expiresInSeconds,
      expiresAt: token.expires_at,
    };
  }
  return getUnifiedExpiryInfo();
}

/**
 * Attempt to refresh tokens silently.
 */
export const refreshTokensSilently = refreshUnifiedTokensSilently;

/**
 * Initiate OAuth flow
 */
export function initiateOAuthFlow(returnUrl?: string): void {
  initiateUnifiedOAuthFlow(false, returnUrl);
}

/**
 * Singleton promise to prevent concurrent folder structure checks
 * from creating duplicates within the same browser session.
 */
let inFlightFolderStructure: Promise<{
  originalsId: string;
  processedId: string;
}> | null = null;

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

/**
 * Extract a Google Drive file ID from various URL patterns.
 */
export function extractDriveFileId(url: string | undefined): string | null {
  if (!url) return null;
  const patterns = [
    /[?&]id=([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/,
    /drive\/v3\/files\/([a-zA-Z0-9_-]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Build a query string for searching by derivation key.
 */
export function buildDerivationKeyQuery(derivationKey: string): string {
  return sharedBuildDerivationKeyQuery(derivationKey);
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
 * Handle OAuth callback and extract token from URL hash
 */
export async function handleOAuthCallback(): Promise<{
  token: GoogleDriveToken;
  state?: string;
  returnUrl?: string;
} | null> {
  const result = await handleUnifiedOAuthCallback();
  if (!result) return null;

  return {
    token: result.token,
    returnUrl: result.returnUrl,
  };
}

/**
 * Search for a file by its derivation key in properties.
 */
export async function findFileByDerivationKey(
  accessToken: string,
  derivationKey: string,
): Promise<DriveFile | null> {
  // Fix signature mismatch: sharedFindFileByDerivationKey expects (derivationKey, executeRequest)
  const file = await sharedFindFileByDerivationKey(
    derivationKey,
    async (url: string) => {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        if (response.status === 401) {
          clearToken();
        }
        throw new Error(
          `Find by derivation key failed: ${response.statusText}`,
        );
      }
      return await response.json();
    },
  );

  if (!file) return null;

  return {
    ...file,
    mimeType: (file as any).mimeType || "image/png",
    modifiedTime: (file as any).modifiedTime || new Date().toISOString(),
  };
}

/**
 * Set public view permission for a file
 */
export async function setFilePermissions(
  fileId: string,
  accessToken: string,
): Promise<void> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        role: "reader",
        type: "anyone",
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Failed to set file permissions: ${errorText}`);
  }
}

/**
 * Upload a blob to Google Drive
 */
export async function uploadImageToDrive(
  blob: Blob,
  filename: string,
  folderId: string,
  accessToken: string,
  derivationKey?: string | Record<string, string>,
  onProgress?: (loaded: number, total: number) => void,
): Promise<DriveFileInfo> {
  // Handle legacy derivationKey string or new properties object
  const properties =
    typeof derivationKey === "string"
      ? { [DERIVATION_KEY_PROPERTY]: derivationKey }
      : derivationKey || {};

  // 1. Initialize resumable upload
  const metadata = {
    name: filename,
    parents: [folderId],
    properties: properties,
  };

  const initRes = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(metadata),
    },
  );

  if (!initRes.ok) {
    const errorText = await initRes.text();
    throw new Error(`Failed to initialize upload: ${errorText}`);
  }

  const uploadUrl = initRes.headers.get("Location");
  if (!uploadUrl) throw new Error("No upload location received");

  // 2. Upload Data with Progress (using XHR if available for progress events)
  let fileData: any;
  if (typeof XMLHttpRequest !== "undefined") {
    const uploadPromise = new Promise<any>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadUrl);

      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            onProgress(e.loaded, e.total);
          }
        };
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (e) {
            reject(new Error("Failed to parse upload response"));
          }
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      };

      xhr.onerror = () => reject(new Error("XHR Upload failed"));
      xhr.send(blob);
    });
    fileData = await uploadPromise;
  } else {
    // Fallback for Node.js environment where XHR is missing
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      body: blob,
    });
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`Upload failed: ${uploadRes.status} ${errText}`);
    }
    fileData = await uploadRes.json();
  }

  // 3. Make public immediately
  await setFilePermissions(fileData.id, accessToken);

  // 4. Get Details
  const detailsParam = new URLSearchParams({
    fields: "id,name,webViewLink,webContentLink,thumbnailLink",
  });
  const detailsRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileData.id}?${detailsParam.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  const details = (await detailsRes.json()) as DriveFileInfo;
  if (details.id) {
    details.publicUrl = `https://lh3.googleusercontent.com/d/${details.id}=s0`;
    details.apiUrl = `https://www.googleapis.com/drive/v3/files/${details.id}?alt=media`;
  }

  return details;
}

/**
 * Find a folder by name within a parent folder
 */
export async function findFolder(
  name: string,
  parentId: string,
  accessToken: string,
  role?: string,
): Promise<string | null> {
  const query = `'${parentId}' in parents and name = '${escapeDriveQueryValue(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const params = new URLSearchParams({
    q: query,
    fields: "files(id)",
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
    const errorText = await response.text();
    throw new Error(`Failed to create folder '${name}': ${errorText}`);
  }

  const data = await response.json();
  return data.id;
}

/**
 * Ensure a complete folder structure exists
 */
export async function ensureFolderPath(
  path: string,
  accessToken: string,
): Promise<string> {
  const parts = path.split("/").filter(Boolean);
  let currentParent = "root";

  for (const part of parts) {
    let folderId = await findFolder(part, currentParent, accessToken);
    if (!folderId) {
      folderId = await createFolder(part, currentParent, accessToken);
      await setFilePermissions(folderId, accessToken);
    }
    currentParent = folderId;
  }

  return currentParent;
}

/**
 * Ensure the primary "Images" folder structure exists.
 * Returns both the Originals and Processed folder IDs.
 */
export async function ensureFolderStructure(
  accessToken: string,
): Promise<{ originalsId: string; processedId: string }> {
  if (!FOLDER_ID) throw new Error("Root folder ID not configured");

  if (!inFlightFolderStructure) {
    inFlightFolderStructure = (async () => {
      try {
        const imagesId = await findFolder("Images", FOLDER_ID, accessToken);
        if (!imagesId) {
          const newImagesId = await createFolder(
            "Images",
            FOLDER_ID,
            accessToken,
          );
          await setFilePermissions(newImagesId, accessToken);
          const [origId, procId] = await Promise.all([
            createFolder("Originals", newImagesId, accessToken),
            createFolder("Processed", newImagesId, accessToken),
          ]);
          await Promise.all([
            setFilePermissions(origId, accessToken),
            setFilePermissions(procId, accessToken),
          ]);
          return { originalsId: origId, processedId: procId };
        }

        const [origId, procId] = await Promise.all([
          findFolder("Originals", imagesId, accessToken),
          findFolder("Processed", imagesId, accessToken),
        ]);

        let finalOrigId = origId;
        let finalProcId = procId;

        if (!origId) {
          finalOrigId = await createFolder("Originals", imagesId, accessToken);
          await setFilePermissions(finalOrigId, accessToken);
        }
        if (!procId) {
          finalProcId = await createFolder("Processed", imagesId, accessToken);
          await setFilePermissions(finalProcId, accessToken);
        }

        return {
          originalsId: finalOrigId as string,
          processedId: finalProcId as string,
        };
      } catch (e) {
        inFlightFolderStructure = null;
        throw e;
      }
    })();
  }

  return await inFlightFolderStructure;
}

/**
 * Get the processed images folder ID
 */
export async function ensureProcessedFolder(
  accessToken: string,
): Promise<string> {
  const { processedId } = await ensureFolderStructure(accessToken);
  return processedId;
}

/**
 * Get the originals images folder ID
 */
export async function ensureOriginalsFolder(
  accessToken: string,
): Promise<string> {
  if (!FOLDER_ID) throw new Error("Root folder ID not configured");
  const { originalsId } = await ensureFolderStructure(accessToken);
  return originalsId;
}

/**
 * Set a custom property on a file
 */
export async function setFileProperty(
  fileId: string,
  key: string,
  value: string,
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
      body: JSON.stringify({
        properties: {
          [key]: value,
        },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Failed to set file property: ${errorText}`);
  }
}

/**
 * Get metadata for a file
 */
export async function getFileMetadata(
  fileId: string,
  accessToken: string,
): Promise<drive_v3.Schema$File> {
  const params = new URLSearchParams({
    fields: "id,name,properties,appProperties,mimeType,webViewLink",
  });

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get file metadata: ${errorText}`);
  }

  return await response.json();
}

/**
 * List files in a specific folder
 */
export async function listFilesInFolder(
  accessToken: string,
  folderId?: string,
  pageSize = 100,
): Promise<DriveFile[]> {
  const targetFolder = folderId || FOLDER_ID;
  if (!targetFolder) throw new Error("No folder ID provided or configured");

  const query = `'${targetFolder}' in parents and trashed = false`;
  const params = new URLSearchParams({
    q: query,
    pageSize: String(pageSize),
    fields:
      "files(id, name, mimeType, modifiedTime, size, webViewLink, webContentLink, thumbnailLink)",
    orderBy: "modifiedTime desc",
  });

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to list files in folder: ${response.statusText}`);
  }

  const data = await response.json();
  return hydrateDriveFiles(data.files || []);
}

/**
 * Upload a CSV to Drive
 */
export async function uploadCSVToDrive(
  csvContent: string,
  filename: string,
  accessToken: string,
  folderId: string,
): Promise<DriveFileInfo> {
  const blob = new Blob([csvContent], { type: "text/csv" });
  return await uploadImageToDrive(blob, filename, folderId, accessToken);
}

/**
 * Download file content
 */
export async function downloadFile(
  fileId: string,
  accessToken: string,
): Promise<string> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`);
  }

  return await response.text();
}

/**
 * Get folder link
 */
export function getFolderLink(folderId?: string): string {
  const target = folderId || FOLDER_ID;
  return target ? `https://drive.google.com/drive/folders/${target}` : "";
}

/**
 * Get folder ID from env
 */
export function getFolderId(): string | undefined {
  return FOLDER_ID;
}

/**
 * Rename a file
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
    throw new Error(`Failed to rename file: ${response.statusText}`);
  }
}

/**
 * List all images in Drive
 */
export async function listAllImages(
  accessToken: string,
  pageSize = 100,
): Promise<DriveFile[]> {
  const query = "mimeType contains 'image/' and trashed = false";
  const params = new URLSearchParams({
    q: query,
    pageSize: String(pageSize),
    fields:
      "files(id, name, mimeType, modifiedTime, size, webViewLink, webContentLink, thumbnailLink)",
    orderBy: "modifiedTime desc",
  });

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to list all images: ${response.statusText}`);
  }

  const data = await response.json();
  return hydrateDriveFiles(data.files || []);
}
