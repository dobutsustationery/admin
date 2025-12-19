import { removeBackground } from "./background-removal";
import { ensureFolderStructure, uploadImageToDrive } from "$lib/google-drive";

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

/**
 * Fetch image data from a URL using the user's OAuth token.
 */
async function fetchImage(
  url: string,
  token: string,
): Promise<{ data: string; mimeType: string }> {
  // Append modifiers for reasonable size ONLY if it's a Google Photos URL
  // Drive links (drive.google.com) do not support these modifiers in the same way (or might break)
  // googleusercontent.com links (thumbnails) DO support them.
  const isDriveLink = url.includes("drive.google.com");
  const fetchUrl = isDriveLink ? url : `${url}=w1024-h1024`;

  const response = await fetch(fetchUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.statusText}`);
  }

  const blob = await response.blob();
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Result is "data:image/jpeg;base64,....."
      // We need just the base64 part
      const base64Data = result.split(",")[1];
      resolve(base64Data);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  return { data: base64, mimeType: blob.type || "image/jpeg" };
}

// ... imagePrompt function remains same ...
async function imagePrompt(
  text: string,
  images: { data: string; mimeType: string }[],
  accessToken: string,
  apiKey?: string,
): Promise<string | null> {
  let countRetries = 0;
  while (true) {
    try {
      const contents: any[] = [{ parts: [{ text }] }];
      const parts = contents[0].parts;

      for (const img of images) {
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
}

/**
 * Process a list of media items to group by JAN code and generate descriptions.
 */
export interface LiveGroup {
  janCode: string;
  imageUrls: string[];
  imageStatuses: ("pending" | "optimizing" | "done")[];
  description?: string;
  categories?: string;
  status: "collecting" | "generating" | "done";
}

export async function processMediaItems(
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
      baseUrl: string;
      dataPromise: Promise<{ data: string; mimeType: string }>;
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

  // Ensure 'Processed' folder exists
  let processedFolderId = "";
  try {
      const folders = await ensureFolderStructure(accessToken);
      processedFolderId = folders.processedId;
  } catch(e) {
      console.error("Failed to ensure folder structure", e);
      // Continue locally? Or fail?
      // Warn and try to continue, but upload will fail.
  }

  // 1. Group images by JAN code
  let processedCount = 0;
  for (const item of items) {
    processedCount++;
    notify(
      `Analyzing image ${processedCount}/${items.length}...`,
      processedCount,
    );

    try {
      const imageDataPromise = fetchImage(item.baseUrl, accessToken);
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
            imageStatuses: [],
            status: "collecting",
          });
        }
        targetGroupIdx = groups.length - 1;
      }

      // Add image to group
      groups[targetGroupIdx].images.push({
        baseUrl: item.baseUrl,
        dataPromise: imageDataPromise,
      });
      liveGroups[targetGroupIdx].imageUrls.push(item.baseUrl);
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

    // Check for variants only if there are enough images to likely contain variants (Heuristic: > 2 images)
    // User optimization: simple "Front + Back" (2 images) should skip this slow LLM check.
    if (group.images.length > 2) {
      try {
        // Ask AI if these are variants
        const identificationPrompt = `
                    You are a strict JSON generator. Look at these ${group.images.length} images.
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
          groupImagesData,
          accessToken,
          apiKey,
        );

        let variants: { name: string; indices: number[] }[] = [];
        if (variantJsonRaw) {
          try {
            // Robust JSON extraction
            let jsonStr = variantJsonRaw
              .replace(/```json/g, "")
              .replace(/```/g, "")
              .trim();
            // Find first '{' and last '}' to handle potential conversational preamble
            const firstBrace = jsonStr.indexOf("{");
            const lastBrace = jsonStr.lastIndexOf("}");
            if (firstBrace !== -1 && lastBrace !== -1) {
              jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
            }

            const parsed = JSON.parse(jsonStr);
            if (parsed.variants && Array.isArray(parsed.variants)) {
              variants = parsed.variants;
            }
          } catch (e) {
            console.warn("Failed to parse variant JSON", e, variantJsonRaw);
          }
        }

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
    });

    // 3. Edit Images (Background Removal & Crop)
    for (let imgIdx = 0; imgIdx < group.images.length; imgIdx++) {
      const img = group.images[imgIdx];
      const imgData = groupImagesData[imgIdx]; // Already fetched

      // Mark as optimizing
      if (liveGroup) {
        // Clone the group to trigger reactivity
        liveGroups[i] = {
          ...liveGroup,
          imageStatuses: [...liveGroup.imageStatuses],
        };
        liveGroups[i].imageStatuses[imgIdx] = "optimizing";
        notify(
          `Optimizing image ${imgIdx + 1}/${group.images.length} for ${group.janCode}...`,
          items.length,
        );
      }

      console.log(
        `[Image Optimization] Starting optimization for ${group.janCode} image ${imgIdx + 1}`,
      );

      try {
        // Background removal and crop
        console.log(
          `[Image Optimization] Starting optimization for ${group.janCode} image ${imgIdx + 1}`,
        );

        // Use the already fetched Base64 data to avoid 403 Forbidden on re-fetch without headers
        const dataUriInput = `data:${imgData.mimeType};base64,${imgData.data}`;
        const editedBase64 = await removeBackground(dataUriInput);

        if (editedBase64) {
          const dataUri = `data:image/png;base64,${editedBase64}`;
          
          // UPLOAD TO DRIVE
          let driveUrl = dataUri; // Fallback
          if (processedFolderId) {
             try {
                // Convert to blob
                const processedBlob = await (await fetch(dataUri)).blob();
                const filename = `processed_${group.janCode}_${imgIdx}_${Date.now()}.png`;
                const driveFile = await uploadImageToDrive(processedBlob, filename, processedFolderId, accessToken);
                driveUrl = driveFile.webContentLink || dataUri;
             } catch(uploadErr) {
                 console.error("Failed to upload processed image", uploadErr);
             }
          }

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
            liveGroups[idx].imageUrls[imgIdx] = driveUrl; // LINK Update
            liveGroups[idx].imageStatuses[imgIdx] = "done";
            
            // Update Results as well!
            const resIdx = results.findIndex(r => r.janCode === group.janCode);
            if (resIdx !== -1) {
                results[resIdx].imageUrls[imgIdx] = driveUrl;
            }

            notify(
              `Updated image ${imgIdx + 1} for ${group.janCode}`,
              items.length,
            );
            console.log(
              `[Image Optimization] Finished optimization for ${group.janCode} image ${imgIdx + 1} (Success)`,
            );
          }
        } else {
          console.warn(
            `[Image Optimization] Failed optimization for ${group.janCode} image ${imgIdx + 1} (No data returned)`,
          );
          const updatedLiveGroup = liveGroups.find(
            (g) => g.janCode === group.janCode,
          );
          if (updatedLiveGroup) {
            const idx = liveGroups.indexOf(updatedLiveGroup);
            liveGroups[idx] = {
              ...updatedLiveGroup,
              imageStatuses: [...updatedLiveGroup.imageStatuses],
            };
            liveGroups[idx].imageStatuses[imgIdx] = "done";
            notify(
              `Optimization failed for image ${imgIdx + 1} of ${group.janCode}`,
              items.length,
            );
          }
        }
      } catch (e) {
        console.error("Image optimization failed", e);
        const updatedLiveGroup = liveGroups.find(
          (g) => g.janCode === group.janCode,
        );
        if (updatedLiveGroup) {
          const idx = liveGroups.indexOf(updatedLiveGroup);
          liveGroups[idx] = {
            ...updatedLiveGroup,
            imageStatuses: [...updatedLiveGroup.imageStatuses],
          };
          liveGroups[idx].imageStatuses[imgIdx] = "done";
          notify(`Optimization error for image ${imgIdx + 1}`, items.length);
        }
      }
    }

    if (liveGroup) liveGroup.status = "done";
  }

  return results;
}

// Remove editImage function completely
