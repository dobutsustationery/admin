import { GoogleGenAI } from "@google/genai";
import { env } from "$env/dynamic/private";

const ai = new GoogleGenAI({
  apiKey: env.GOOGLE_API_KEY,
});

/**
 * Fetch image data from a URL using the user's OAuth token.
 */
async function fetchImage(url: string, token: string): Promise<{ data: string; mimeType: string }> {
  // Append modifiers to get a reasonable size for analysis/generation
  // e.g. w1024-h1024 to ensure legibility of barcodes but not massive
  const fetchUrl = `${url}=w1024-h1024`; 
  
  const response = await fetch(fetchUrl, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const base64 = buffer.toString("base64");
  const mimeType = response.headers.get("content-type") || "image/jpeg";

  return { data: base64, mimeType };
}

/**
 * Send a prompt with images to Gemini.
 */
async function imagePrompt(text: string, images: { data: string; mimeType: string }[]): Promise<string | null> {
  let countRetries = 0;
  while (true) {
    try {
      const contents: any[] = [{ text }];
      for (const img of images) {
        contents.push({
          inlineData: {
            data: img.data,
            mimeType: img.mimeType,
          },
        });
      }

      // Using gemini-2.0-flash as requested/implied by user script "gemini-2.0-flash"
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash", 
        contents: contents,
      });
      
      // Adaptation for @google/genai SDK response structure
      // If response.text is a getter/function or property
      // We'll try strictly checking what the new SDK offers.
      // Easiest safe bet if types are confusing:
      return (response as any).text || ((response as any).text && typeof (response as any).text === 'function' ? (response as any).text() : null) || JSON.stringify((response as any).candidates) || null;
    } catch (error: any) {
      console.error(`Error checking Gemini: ${error.message}`);
      if (countRetries < 3) {
        countRetries++;
        console.warn(`Retrying (${countRetries})...`);
        await new Promise((resolve) => setTimeout(resolve, 2000 * countRetries));
        continue;
      }
      return null;
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
    
    // 1. Group images by JAN code
    // Strategy: Iterate. Check if image has JAN. 
    // If YES -> Start new group.
    // If NO -> Add to current group. 
    // (Assumption: First image MUST have JAN, or we have an "unknown" group)

    const groups: { janCode: string; images: { baseUrl: string; dataPromise: Promise<{ data: string; mimeType: string }> }[] }[] = [];
    let currentGroup: typeof groups[0] | null = null;

    console.log(`Processing ${items.length} items...`);

    // We process sequentially to maintain order and context
    for (const item of items) {
        try {
            // Helper to get image data (lazy/cached)
            const imageDataPromise = fetchImage(item.baseUrl, accessToken); 
            // We await immediately for JAN check
            const imgData = await imageDataPromise;

            // Ask Gemini for JAN code
            // "Find the JAN code in this image."
            // Optimization: Maybe only check if it looks like a barcode? 
            // For now, we ask Gemini every time or check user heuristic?
            // User script: "Find the JAN code in this image." -> if null, it's a product image?
            // Actually user script implies: "images being chosen... have a barcode on the first of a group, then a series of images with no barcode..."
            
            const janCheck = await imagePrompt("Find the JAN code in this image. Return ONLY the numeric code. If no barcode is clearly visible, return 'NONE'.", [imgData]);
            const janCode = janCheck?.replace(/[^0-9]/g, "");

            if (janCode && janCode.length > 5 && janCode !== 'NONE') { // valid-ish JAN
                console.log(`Found JAN: ${janCode}`);
                currentGroup = {
                    janCode: janCode,
                    images: []
                };
                groups.push(currentGroup);
                // We typically include the barcode image in the group context for description too
                currentGroup.images.push({ baseUrl: item.baseUrl, dataPromise: imageDataPromise });
            } else {
                console.log(`No JAN found (result: ${janCheck}), adding to current group.`);
                if (!currentGroup) {
                    // Create a fallback group if the first image has no barcode
                    currentGroup = { janCode: "UNKNOWN", images: [] };
                    groups.push(currentGroup);
                }
                currentGroup.images.push({ baseUrl: item.baseUrl, dataPromise: imageDataPromise });
            }

        } catch (e) {
            console.error("Error processing item for grouping:", e);
        }
    }

    // 2. Generate descriptions for each group
    const results: ProcessingResult[] = [];

    for (const group of groups) {
        console.log(`Generating description for JAN ${group.janCode} with ${group.images.length} images...`);
        
        // Resolve all image data for this group
        const groupImagesData = await Promise.all(group.images.map(i => i.dataPromise));
        
        let categories = "";
        let description: string | null = "";

        // Logic from user script
        if (group.images.length > 1) {
            const categoriesRaw = await imagePrompt(
                "Make simple one word descriptions for each related product in these images, emphasizing the style or product differences, separated by a vertical bar (|).",
                groupImagesData
            );
            // logic to cleanup
             if (categoriesRaw) {
                // Heuristic from script: "splits[splits.length - 1]" - maybe it returns reasoning?
                const splits = categoriesRaw.split("\n").map(s => s.trim()).filter(s => s);
                categories = splits[splits.length - 1] || "";
            }

            description = await imagePrompt(
                `Write a playful product description for these images, prefacing each one with the one-word type of product, chosen from (${categories}), formatted with HTML tags.`,
                groupImagesData
            );
        } else {
            description = await imagePrompt(
                "Write a playful product description for this image, formatted with HTML tags.",
                groupImagesData
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
