import {
  ensureFolderStructure,
  uploadImageToDrive,
  findFileByDerivationKey,
  generateDerivationKey,
  extractDriveFileId,
  getStoredToken as getDriveToken,
} from "$lib/google-drive";
import { toGoogleDrivePublicImageUrl } from "$lib/drive-url";
import {
  type Firestore,
  collection,
  addDoc,
  serverTimestamp,
  onSnapshot,
  query,
  where,
  limit,
} from "firebase/firestore";
import {
  SYNC_COLLECTION,
  PHOTOS_IMAGE_TRANSFORM_REQUEST_EVENT,
} from "$lib/sync-events";

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// In-flight request tracking to avoid redundant sync requests
const inFlightRequests = new Set<string>();

export type GeminiImageInput =
  | { kind: "inline"; data: string; mimeType: string }
  | { kind: "file_uri"; fileUri: string; mimeType: string };

function inferImageMimeTypeFromUrl(url: string): string {
  const lower = String(url || "").toLowerCase();
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".webp")) return "image/webp";
  if (lower.includes(".gif")) return "image/gif";
  if (lower.includes(".heic") || lower.includes(".heif")) return "image/heic";
  return "image/jpeg";
}

function toGeminiPublicImageUrl(rawUrl: string): string {
  const normalized = toGoogleDrivePublicImageUrl(rawUrl);
  if (!normalized) return "";

  if (normalized.includes("googleusercontent.com")) {
    // Preserve public URL path but remove transient resize suffixes for stable full-res access.
    return normalized.replace(/=[a-z0-9,-]+$/i, "=s0");
  }

  return normalized;
}

function isPublicGeminiImageUrl(url: string): boolean {
  const value = String(url || "").trim();
  if (!value) return false;
  if (!/^https?:\/\//i.test(value)) return false;
  if (value.includes("googleapis.com/drive/v3/files/")) return false;
  if (value.startsWith("data:")) return false;

  // Prefer URL-based Gemini fetch for public Drive/Googleusercontent links and generic HTTPS URLs.
  return true;
}

/**
 * Fetch image data from a URL using the user's OAuth token.
 */
export async function fetchImage(
  url: string,
  token?: string,
): Promise<GeminiImageInput> {
  const publicUrl = toGeminiPublicImageUrl(url);
  if (isPublicGeminiImageUrl(publicUrl)) {
    return {
      kind: "file_uri",
      fileUri: publicUrl,
      mimeType: inferImageMimeTypeFromUrl(publicUrl),
    };
  }

  // Handle Google Drive Thumbnail URLs:
  // These (drive.google.com/thumbnail?id=...) do NOT support CORS for fetch().
  // We must convert them to the Drive API 'get media' endpoint:
  // https://www.googleapis.com/drive/v3/files/{fileId}?alt=media

  let fetchUrl = toGoogleDrivePublicImageUrl(url);

  // Extract ID from drive thumbnail link or standard public export link
  // Matches:
  // 1. drive.google.com/thumbnail?id=XYZ
  // 2. drive.google.com/uc?id=XYZ
  // 3. drive.google.com/uc?export=view&id=XYZ
  const driveIdMatch = fetchUrl.match(
    /drive\.google\.com\/(?:thumbnail|uc)\?.*id=([^&]+)/,
  );
  let driveApiUrl = "";
  if (driveIdMatch && driveIdMatch[1]) {
    const fileId = driveIdMatch[1];
    // Prefer public URL first to avoid unnecessary auth failures/noise.
    driveApiUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    fetchUrl = toGoogleDrivePublicImageUrl(fetchUrl);
  } else if (url.includes("googleusercontent.com")) {
    // Normalize to full-resolution download form. If a resized suffix was persisted
    // accidentally (e.g. =w400-h400-c), strip it and request original bytes.
    const base = url.replace(/=[a-z0-9,-]+$/i, "");
    fetchUrl = `${base}=d`;
  }

  const headers: Record<string, string> = {};
  if (token && fetchUrl.includes("googleapis.com/drive/v3/files/")) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  try {
    let response = await fetch(fetchUrl, {
      headers,
      referrerPolicy: "no-referrer",
    });

    if (!response.ok) {
      // For Drive links, fallback to API endpoint when token is available.
      if (
        token &&
        driveIdMatch &&
        (response.status === 401 ||
          response.status === 403 ||
          response.status === 0)
      ) {
        const apiResponse = await fetch(driveApiUrl, {
          headers: { Authorization: `Bearer ${token}` },
          referrerPolicy: "no-referrer",
        });
        if (apiResponse.ok) {
          return processResponse(apiResponse);
        }
      }

      if (url.includes("googleusercontent.com") && fetchUrl !== url) {
        const rawResponse = await fetch(url, {
          headers,
          referrerPolicy: "no-referrer",
        });
        if (rawResponse.ok) {
          return processResponse(rawResponse);
        }
      }

      throw new Error(
        `Failed to fetch image (${response.status}): ${response.statusText}`,
      );
    }
    return processResponse(response);
  } catch (e: any) {
    // If the fallback (or initial) fetch failed, rethrow.
    // Note: CORS errors on public URL usually show up as TypeError: Failed to fetch
    throw e;
  }
}

export async function fetchImageInline(
  url: string,
  token?: string,
): Promise<{ data: string; mimeType: string }> {
  const result = await fetchImage(url, token);
  if (result.kind === "inline") {
    return { data: result.data, mimeType: result.mimeType };
  }

  // Force a direct fetch when a caller explicitly needs bytes (canvas/local processing paths).
  const response = await fetch(result.fileUri, {
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch image (${response.status}): ${response.statusText}`,
    );
  }
  const inline = await processResponse(response);
  if (inline.kind !== "inline") {
    throw new Error("Expected inline Gemini image payload");
  }
  return { data: inline.data, mimeType: inline.mimeType };
}

async function processResponse(response: Response): Promise<GeminiImageInput> {
  const blob = await response.blob();

  // Refuse to process blobs larger than 4MB for inline transmission.
  // Gemini supports up to 20MB for total request, but we want to avoid
  // heavy client-side base64 encoding and transmission for large photos.
  const MAX_SIZE = 4 * 1024 * 1024; // 4MB
  if (blob.size > MAX_SIZE) {
    throw new Error(
      `Image is too large (${(blob.size / 1024 / 1024).toFixed(1)}MB) to send as inline data. Please use a public URL or a smaller version.`,
    );
  }

  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64Data = result.split(",")[1];
      resolve(base64Data);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  return { kind: "inline", data: base64, mimeType: blob.type || "image/jpeg" };
}

// ... imagePrompt function remains same ...
export async function imagePrompt(
  text: string,
  images: GeminiImageInput[],
  accessToken: string,
  apiKey?: string,
): Promise<string | null> {
  let countRetries = 0;
  while (true) {
    try {
      const contents: any[] = [{ parts: [{ text }] }];
      const parts = contents[0].parts;

      for (const img of images) {
        if (img.kind === "file_uri") {
          parts.push({
            file_data: {
              mime_type: img.mimeType,
              file_uri: img.fileUri,
            },
          });
          continue;
        }

        parts.push({
          inline_data: {
            mime_type: img.mimeType,
            data: img.data,
          },
        });
      }

      const url = apiKey ? `${GEMINI_API_URL}?key=${apiKey}` : GEMINI_API_URL;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-goog-user-project": import.meta.env.VITE_FIREBASE_PROJECT_ID || "",
      };

      if (!apiKey) {
        headers["Authorization"] = `Bearer ${accessToken}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ contents }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `Gemini API error: ${response.status} ${response.statusText}`;
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.error && errorJson.error.message) {
            errorMessage += ` - ${errorJson.error.message}`;
          }
        } catch (e) {
          errorMessage += ` - ${errorText}`;
        }

        // Don't retry on auth/permission errors
        if (response.status === 401 || response.status === 403) {
          throw new Error(errorMessage);
        }
        throw new Error(errorMessage);
      }

      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (error: any) {
      console.error(`Error checking Gemini: ${error.message}`);
      // Re-throw if it's a 403/401 or if we ran out of retries
      if (
        error.message.includes("403") ||
        error.message.includes("401") ||
        countRetries >= 3
      ) {
        throw error;
      }

      countRetries++;
      console.warn(`Retrying (${countRetries})...`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * countRetries));
    }
  }
}

export interface ProcessingResult {
  janCode: string;
  description: string;
  categories: string;
  imageUrls: string[];
  photoIds: string[];
}

export async function detectVariants(
  images: GeminiImageInput[],
  accessToken: string,
  apiKey?: string,
  customPrompt?: string,
): Promise<{ name: string; indices: number[] }[]> {
  const identificationPrompt =
    customPrompt ||
    `
        You are a strict JSON generator. Look at these ${images.length} images.
        Task: Group these images into Product Variants (e.g. Red vs Blue) based on their packaging.

        RULES:
        1. Identify variants based on **FRONT FACES ONLY**.
        2. If there is only ONE unique front face (e.g. 1 Front + 3 Backs), return NO variants.
        3. Ignore Backs, Ingredients, or Nutrition Labels for the purpose of *counting* variants.
        4. If you find multiple variants, assign ALL images (Fronts AND Backs) to them.
        
        OUTPUT FORMAT:
        If NO variants (Same Product):
        { "variants": [] }

        If YES (Multiple Variants):
        {
            "variants": [
                { "name": "Variant Name", "indices": [0, 1] },
                { "name": "Variant Name", "indices": [2, 3] }
            ]
        }
        
        Return ONLY valid JSON. No markdown. No conversation.
    `;

  const variantJsonRaw = await imagePrompt(
    identificationPrompt,
    images,
    accessToken,
    apiKey,
  );

  console.log(`[Variant Detection] Raw Response:`, variantJsonRaw);

  if (variantJsonRaw) {
    try {
      let jsonStr = variantJsonRaw
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();
      const firstBrace = jsonStr.indexOf("{");
      const lastBrace = jsonStr.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1) {
        jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
      }

      const parsed = JSON.parse(jsonStr);
      if (parsed.variants && Array.isArray(parsed.variants)) {
        console.log(`[Variant Detection] Parsed Variants:`, parsed.variants);
        return parsed.variants;
      }
    } catch (e) {
      console.warn("Failed to parse variant JSON", e, variantJsonRaw);
    }
  }
  return [];
}

/**
 * Process a list of media items to group by JAN code and generate descriptions.
 */
export interface LiveGroup {
  janCode: string;
  imageUrls: string[];
  photoIds: string[];
  imageStatuses: ("pending" | "optimizing" | "done")[];
  description?: string;
  categories?: string;
  status: "collecting" | "generating" | "done";
}

/**
 * Orchestrates product proposal generation and image optimization.
 * Uses a hybrid model:
 * 1. AI analysis (detect variants, generate descriptions) happens on the client.
 * 2. Heavy image transforms (background removal) are dispatched to backend sync queue.
 *
 * @param firestore Firestore instance for sync queue dispatch.
 * @param uid Current user ID for audit/ownership.
 * @param processedFolderId Drive folder ID where transformed images should be stored.
 * @param items List of Google Photos media items to process.
 * @param accessToken Google Drive/Photos OAuth token.
 */
export async function processMediaItems(
  firestore: Firestore,
  uid: string,
  processedFolderId: string,
  items: { baseUrl: string; id: string }[],
  accessToken: string,
  apiKey?: string,
  onStateChange?: (
    groups: LiveGroup[],
    progress: { current: number; total: number; message: string },
  ) => void,
): Promise<ProcessingResult[]> {
  const groups: {
    janCode: string;
    images: {
      id: string;
      baseUrl: string;
      dataPromise: Promise<GeminiImageInput>;
    }[];
  }[] = [];
  // We maintain a "live" version for the UI
  const liveGroups: LiveGroup[] = [];

  const notify = (msg: string, current = 0) => {
    onStateChange?.([...liveGroups], {
      current,
      total: items.length,
      message: msg,
    });
  };

  notify("Starting analysis...", 0);
  console.log(`Processing ${items.length} items...`);

  // 1. Group images by JAN code
  let processedCount = 0;
  for (const item of items) {
    processedCount++;
    notify(
      `Analyzing image ${processedCount}/${items.length}...`,
      processedCount,
    );

    try {
      const fetchUrl = toGeminiPublicImageUrl(item.baseUrl) || item.baseUrl;
      const imageDataPromise = fetchImage(fetchUrl, accessToken);
      const imgData = await imageDataPromise;

      const janCheck = await imagePrompt(
        "Find the JAN code in this image. Return ONLY the numeric code. If no barcode is clearly visible, return 'NONE'.",
        [imgData],
        accessToken,
        apiKey,
      );
      const janCode = janCheck?.replace(/[^0-9]/g, "");

      let targetGroupIdx = -1;

      if (janCode && janCode.length > 5 && janCode !== "NONE") {
        console.log(`Found JAN: ${janCode}`);

        // Find or create group
        targetGroupIdx = groups.findIndex((g) => g.janCode === janCode);
        if (targetGroupIdx === -1) {
          groups.push({ janCode, images: [] });
          liveGroups.push({
            janCode,
            imageUrls: [],
            photoIds: [],
            imageStatuses: [],
            status: "collecting",
          });
          targetGroupIdx = groups.length - 1;
        }
      } else {
        console.log(`No JAN found, adding to current/last group.`);
        // Add to last group or create UNKNOWN
        if (groups.length === 0) {
          groups.push({ janCode: "UNKNOWN", images: [] });
          liveGroups.push({
            janCode: "UNKNOWN",
            imageUrls: [],
            photoIds: [],
            imageStatuses: [],
            status: "collecting",
          });
        }
        targetGroupIdx = groups.length - 1;
      }

      // Add image to group
      groups[targetGroupIdx].images.push({
        id: item.id,
        baseUrl: item.baseUrl,
        dataPromise: imageDataPromise,
      });
      liveGroups[targetGroupIdx].imageUrls.push(item.baseUrl);
      liveGroups[targetGroupIdx].photoIds.push(item.id);
      liveGroups[targetGroupIdx].imageStatuses.push("pending");

      notify(`Added to ${liveGroups[targetGroupIdx].janCode}`, processedCount);
    } catch (e: any) {
      console.error("Error processing item for grouping:", e);
      // Rethrow fatal auth errors
      if (
        e.message.includes("Gemini API error: 403") ||
        e.message.includes("Gemini API error: 401")
      ) {
        throw e;
      }
    }
  }

  // 2. Generate descriptions
  const results: ProcessingResult[] = [];

  // Mark all as generating
  liveGroups.forEach((g) => (g.status = "generating"));
  notify("Starting generation...", items.length);

  // Use standard for loop so we can modify 'groups' array if we split variants
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    notify(`Generating description for ${group.janCode}...`, items.length);

    const groupImagesData = await Promise.all(
      group.images.map((img) => img.dataPromise),
    );

    let categories = "";
    let description: string | null = "";
    let splitOccurred = false;

    // Check for variants only if there are enough images to likely contain variants (Heuristic: > 1 image)
    if (group.images.length > 1) {
      console.log(
        `[Variant Detection] Checking group ${group.janCode} with ${group.images.length} images...`,
      );
      try {
        const variants = await detectVariants(
          groupImagesData,
          accessToken,
          apiKey,
        );

        if (variants.length > 1) {
          console.log(
            `Splitting ${group.janCode} into ${variants.length} variants.`,
          );

          // Remove current group/liveGroup
          groups.splice(i, 1);
          const oldLiveIndex = liveGroups.findIndex(
            (g) => g.janCode === group.janCode,
          );
          if (oldLiveIndex !== -1) liveGroups.splice(oldLiveIndex, 1);

          // Create new groups
          const newGroupsToAdd = [];
          const newLiveGroupsToAdd: LiveGroup[] = [];

          for (const v of variants) {
            const newJan = `${group.janCode}:${v.name}`;
            const newImages = v.indices
              .map((idx) => group.images[idx])
              .filter((x) => x);

            if (newImages.length > 0) {
              newGroupsToAdd.push({ janCode: newJan, images: newImages });
              newLiveGroupsToAdd.push({
                janCode: newJan,
                imageUrls: newImages.map((img) => img.baseUrl),
                photoIds: newImages.map((img) => img.id),
                imageStatuses: newImages.map(() => "pending"),
                status: "generating",
              });
            }
          }

          // Insert into arrays
          // Note: We need to splice them in.
          groups.splice(i, 0, ...newGroupsToAdd);
          if (oldLiveIndex !== -1) {
            liveGroups.splice(oldLiveIndex, 0, ...newLiveGroupsToAdd);
          } else {
            liveGroups.push(...newLiveGroupsToAdd);
          }

          // Notify UI of split
          notify(
            `Split ${group.janCode} into ${variants.length} variants..`,
            items.length,
          );

          // Decrement i so we process these new groups in next iteration
          i--;
          splitOccurred = true;
        }
      } catch (e) {
        console.error("Variant detection error", e);
      }
    }

    if (splitOccurred) continue;

    // Normal Generation (Single product or failed split)
    description = await imagePrompt(
      "Write a playful product description for this product, formatted with HTML tags. Return ONLY the HTML. Do not include markdown code blocks or conversational text.",
      groupImagesData,
      accessToken,
      apiKey,
    );

    // Clean up response if it contains markdown or preamble
    if (description) {
      // Remove markdown code blocks
      description = description.replace(/```html/g, "").replace(/```/g, "");
      // Remove common preambles (heuristic)
      const htmlStart = description.indexOf("<");
      if (htmlStart > -1) {
        description = description.substring(htmlStart);
      }
      description = description.trim();
    }

    // Update live group
    const liveGroup = liveGroups.find((g) => g.janCode === group.janCode);
    if (liveGroup) {
      liveGroup.description = description || "Failed";
      liveGroup.categories = categories;
      liveGroup.status = "generating"; // Still generating images
      notify(`Optimizing images for ${group.janCode}...`, items.length);
    }

    results.push({
      janCode: group.janCode,
      description: description || "Failed to generate",
      categories: categories,
      imageUrls: group.images.map((i) => i.baseUrl),
      photoIds: group.images.map((i) => i.id),
    });

    // 3. Edit Images (Background Removal & Crop)
    // Client-side processing is disabled in favor of backend workers.
    for (let imgIdx = 0; imgIdx < group.images.length; imgIdx++) {
      const img = group.images[imgIdx];

      try {
        const driveId = extractDriveFileId(img.baseUrl);
        const sourceType = driveId ? "drive" : "photos";
        const sourceId = driveId || img.id;

        const derivationKey = generateDerivationKey(
          sourceType,
          sourceId,
          "remove_bg",
        );

        // 1. Check for existing transform
        const existing = await findFileByDerivationKey(
          accessToken,
          derivationKey,
        );

        let driveUrl: string | null = null;

        if (existing) {
          console.info(
            `[GeminiClient] Idempotent match found for ${derivationKey}: ${existing.id}`,
          );
          driveUrl = existing.publicUrl || existing.webContentLink || "";
        } else {
          // 2. Request Transform via Sync Queue
          const requestId = `photo-transform-${sourceId}`;

          if (inFlightRequests.has(requestId)) {
            console.info(
              `[GeminiClient] Request for ${requestId} already in flight, waiting...`,
            );
          } else {
            console.info(
              `[GeminiClient] Requesting transform for ${sourceId} (${derivationKey})...`,
            );
            inFlightRequests.add(requestId);

            notify(
              `Requesting background removal for ${group.janCode}...`,
              items.length,
            );

            // We use addDoc because sync collection is append-only
            await addDoc(collection(firestore, SYNC_COLLECTION), {
              eventType: PHOTOS_IMAGE_TRANSFORM_REQUEST_EVENT,
              requestId,
              creator: uid,
              requestedBy: uid,
              requestedAt: Date.now(),
              source: "gemini-client",
              photoId: img.id,
              filename: `processed_${img.id}.png`,
              mimeType: "image/png",
              payloadVersion: 1,
              payload: {
                photoId: img.id,
                sourceBaseUrl: img.baseUrl || "",
                filename: `processed_${img.id}.png`,
                mimeType: "image/png",
                targetFolderId: processedFolderId,
                sourceType,
                transform: "remove_bg",
                derivationKey,
                sourceRef: {
                  mediaItemId: img.id,
                  url: img.baseUrl || "",
                  driveFileId: driveId,
                },
              },
              createdAtMs: Date.now(),
              createdAt: serverTimestamp(),
              timestamp: serverTimestamp(),
            });
          }

          // 3. Poll for completion
          notify(
            `Waiting for server to process ${group.janCode}...`,
            items.length,
          );
          driveUrl = await new Promise<string | null>((resolve) => {
            const q = query(
              collection(firestore, SYNC_COLLECTION),
              where("requestId", "==", requestId),
              where("eventType", "in", [
                "photos/image_transform_completed",
                "photos/image_transfer_completed", // Fallback if worker misreports
                "photos/image_transfer_failed",
                "photos/image_transform_failed",
              ]),
              limit(1),
            );

            const unsubscribe = onSnapshot(
              q,
              (snap) => {
                if (snap.empty) return;
                const data = snap.docs[0].data();
                unsubscribe();
                inFlightRequests.delete(requestId);

                if (data.eventType.endsWith("completed")) {
                  const payload = data.payload || {};
                  resolve(payload.permanentUrl || payload.apiUrl || null);
                } else {
                  console.error(
                    "[GeminiClient] Transform failed",
                    data.payload?.errorMessage,
                  );
                  resolve(null);
                }
              },
              (err) => {
                console.error("[GeminiClient] Polling error", err);
                unsubscribe();
                inFlightRequests.delete(requestId);
                resolve(null);
              },
            );

            // Safety Timeout (60s)
            setTimeout(() => {
              unsubscribe();
              inFlightRequests.delete(requestId);
              notify(
                `Server timeout processing ${group.janCode}`,
                items.length,
              );
              resolve(null);
            }, 60000);
          });
        }

        if (driveUrl) {
          // Update Live Group
          const updatedLiveGroup = liveGroups.find(
            (g) => g.janCode === group.janCode,
          );
          if (updatedLiveGroup) {
            const idx = liveGroups.indexOf(updatedLiveGroup);
            liveGroups[idx] = {
              ...updatedLiveGroup,
              imageUrls: [...updatedLiveGroup.imageUrls],
              imageStatuses: [...updatedLiveGroup.imageStatuses],
            };
            liveGroups[idx].imageUrls[imgIdx] = driveUrl;
            liveGroups[idx].imageStatuses[imgIdx] = "done";

            // Update Results
            const resIdx = results.findIndex(
              (r) => r.janCode === group.janCode,
            );
            if (resIdx !== -1) {
              results[resIdx].imageUrls[imgIdx] = driveUrl;
            }
          }
        } else {
          // Fallback to original image if transform failed or timed out
          const updatedLiveGroup = liveGroups.find(
            (g) => g.janCode === group.janCode,
          );
          if (updatedLiveGroup) {
            const idx = liveGroups.indexOf(updatedLiveGroup);
            liveGroups[idx].imageStatuses[imgIdx] = "done";
          }
        }
      } catch (e) {
        console.error("Transform request failed", e);
      }
    }

    if (liveGroup) liveGroup.status = "done";
  }

  return results;
}

// ... existing code ...

const DEFAULT_UNCATEGORIZED_CODE = "UNCATEGORIZED";

export async function categorizeMediaItems(
  items: { baseUrl: string; id: string }[],
  accessToken: string,
  apiKey?: string,
  onMatch?: (item: { baseUrl: string; id: string }, janCode: string) => void,
  onProgress?: (current: number, total: number, message: string) => void,
): Promise<void> {
  const total = items.length;
  let current = 0;

  onProgress?.(0, total, "Starting categorization...");

  let lastSeenJanCode: string | null = null;
  const driveToken = getDriveToken();
  const effectiveToken = accessToken || driveToken?.access_token;

  for (const item of items) {
    current++;
    onProgress?.(current, total, `Analyzing image ${current}/${total}...`);

    try {
      // 1. Fetch
      // Prioritize public URL to use file_uri (no download)
      const fetchUrl = toGeminiPublicImageUrl(item.baseUrl) || item.baseUrl;
      const imageData = await fetchImage(fetchUrl, effectiveToken);

      // 2. Identify
      const janCheck = await imagePrompt(
        "Find the JAN code (Japanese Article Number, 8 or 13 digits) in this image. Return ONLY the numeric code. If no barcode is clearly visible, return 'NONE'.",
        [imageData],
        accessToken,
        apiKey,
      );

      let janCode = janCheck?.replace(/[^0-9]/g, "") || "";

      // Validate length
      if (janCode.length >= 8 && janCode !== "NONE") {
        // FOUND A NEW JAN
        lastSeenJanCode = janCode;
        console.log(`[Categorize] ${item.id} -> Found JAN: ${janCode}`);
      } else {
        // NO JAN FOUND
        if (lastSeenJanCode) {
          janCode = lastSeenJanCode; // Inherit
          console.log(
            `[Categorize] ${item.id} -> No JAN, inheriting: ${janCode}`,
          );
        } else {
          janCode = DEFAULT_UNCATEGORIZED_CODE;
          console.log(`[Categorize] ${item.id} -> No JAN, no history.`);
        }
      }

      // 3. Notify
      if (janCode !== DEFAULT_UNCATEGORIZED_CODE) {
        onMatch?.(item, janCode);
      } else {
        console.log(`[Categorize] Skipping ${item.id} (Uncategorized)`);
      }
    } catch (e: any) {
      console.error(`Error categorizing item ${item.id}:`, e);
      // On error, do we inherit? Probably safer not to, or maybe yes?
      // If fetch fails, we can't see the image.
      // Let's NOT inherit on error to avoid grouping broken images blindly.
    }
  }

  onProgress?.(current, total, "Categorization complete.");
}
