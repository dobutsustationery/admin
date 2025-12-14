/**
 * Client-side Gemini Integration using OAuth
 */

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

/**
 * Fetch image data from a URL using the user's OAuth token.
 */
async function fetchImage(url: string, token: string): Promise<{ data: string; mimeType: string }> {
  // Append modifiers for reasonable size
  const fetchUrl = `${url}=w1024-h1024`; 
  
  const response = await fetch(fetchUrl, {
    headers: {
      Authorization: `Bearer ${token}`
    }
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
        const base64Data = result.split(',')[1];
        resolve(base64Data);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  return { data: base64, mimeType: blob.type || "image/jpeg" };
}

/**
 * Send a prompt with images to Gemini via REST API.
 */
async function imagePrompt(text: string, images: { data: string; mimeType: string }[], accessToken: string): Promise<string | null> {
  let countRetries = 0;
  while (true) {
    try {
      const contents: any[] = [{ parts: [{ text }] }];
      const parts = contents[0].parts;
      
      for (const img of images) {
        parts.push({
          inline_data: {
            mime_type: img.mimeType,
            data: img.data
          }
        });
      }

      const response = await fetch(GEMINI_API_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "x-goog-user-project": import.meta.env.VITE_FIREBASE_PROJECT_ID || ""
        },
        body: JSON.stringify({ contents })
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
      if (error.message.includes("403") || error.message.includes("401") || countRetries >= 3) {
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
export async function processMediaItems(
    items: { baseUrl: string; id: string }[], 
    accessToken: string
): Promise<ProcessingResult[]> {
    
    const groups: { janCode: string; images: { baseUrl: string; dataPromise: Promise<{ data: string; mimeType: string }> }[] }[] = [];
    let currentGroup: typeof groups[0] | null = null;

    console.log(`Processing ${items.length} items...`);

    // 1. Group images by JAN code
    for (const item of items) {
        try {
            const imageDataPromise = fetchImage(item.baseUrl, accessToken); 
            const imgData = await imageDataPromise;

            const janCheck = await imagePrompt("Find the JAN code in this image. Return ONLY the numeric code. If no barcode is clearly visible, return 'NONE'.", [imgData], accessToken);
            const janCode = janCheck?.replace(/[^0-9]/g, "");

            if (janCode && janCode.length > 5 && janCode !== 'NONE') {
                console.log(`Found JAN: ${janCode}`);
                currentGroup = {
                    janCode: janCode,
                    images: []
                };
                groups.push(currentGroup);
                currentGroup.images.push({ baseUrl: item.baseUrl, dataPromise: imageDataPromise });
            } else {
                console.log(`No JAN found (result: ${janCheck}), adding to current group.`);
                if (!currentGroup) {
                    currentGroup = { janCode: "UNKNOWN", images: [] };
                    groups.push(currentGroup);
                }
                currentGroup.images.push({ baseUrl: item.baseUrl, dataPromise: imageDataPromise });
            }

        } catch (e: any) {
            console.error("Error processing item for grouping:", e);
             // Rethrow fatal auth errors
             if (e.message.includes("Gemini API error: 403") || e.message.includes("Gemini API error: 401")) {
                throw e;
            }
        }
    }

    // 2. Generate descriptions
    const results: ProcessingResult[] = [];

    for (const group of groups) {
        console.log(`Generating description for JAN ${group.janCode} with ${group.images.length} images...`);
        
        const groupImagesData = await Promise.all(group.images.map(i => i.dataPromise));
        
        let categories = "";
        let description: string | null = "";

        if (group.images.length > 1) {
            const categoriesRaw = await imagePrompt(
                "Make simple one word descriptions for each related product in these images, emphasizing the style or product differences, separated by a vertical bar (|).",
                groupImagesData,
                accessToken
            );
             if (categoriesRaw) {
                const splits = categoriesRaw.split("\n").map(s => s.trim()).filter(s => s);
                categories = splits[splits.length - 1] || "";
            }

            description = await imagePrompt(
                `Write a playful product description for these images, prefacing each one with the one-word type of product, chosen from (${categories}), formatted with HTML tags.`,
                groupImagesData,
                accessToken
            );
        } else {
            description = await imagePrompt(
                "Write a playful product description for this image, formatted with HTML tags.",
                groupImagesData,
                accessToken
            );
        }

        results.push({
            janCode: group.janCode,
            description: description || "Failed to generate",
            categories: categories,
            imageUrls: group.images.map(i => i.baseUrl)
        });
    }

    return results;
}
