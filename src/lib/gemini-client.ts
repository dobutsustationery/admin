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
async function imagePrompt(text: string, images: { data: string; mimeType: string }[], accessToken: string, apiKey?: string): Promise<string | null> {
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

      const url = apiKey ? `${GEMINI_API_URL}?key=${apiKey}` : GEMINI_API_URL;
      const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "x-goog-user-project": import.meta.env.VITE_FIREBASE_PROJECT_ID || ""
      };
      
      if (!apiKey) {
          headers["Authorization"] = `Bearer ${accessToken}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
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
export interface LiveGroup {
    janCode: string;
    imageUrls: string[];
    imageStatuses: ('pending' | 'optimizing' | 'done')[];
    description?: string;
    categories?: string;
    status: 'collecting' | 'generating' | 'done';
}

export async function processMediaItems(
    items: { baseUrl: string; id: string }[], 
    accessToken: string,
    apiKey?: string,
    onStateChange?: (groups: LiveGroup[], progress: { current: number, total: number, message: string }) => void
): Promise<ProcessingResult[]> {
    
    const groups: { janCode: string; images: { baseUrl: string; dataPromise: Promise<{ data: string; mimeType: string }> }[] }[] = [];
    // We maintain a "live" version for the UI
    const liveGroups: LiveGroup[] = [];
    
    const notify = (msg: string, current = 0) => {
        onStateChange?.([...liveGroups], { current, total: items.length, message: msg });
    };

    notify("Starting analysis...", 0);
    console.log(`Processing ${items.length} items...`);

    // 1. Group images by JAN code
    let processedCount = 0;
    for (const item of items) {
        processedCount++;
        notify(`Analyzing image ${processedCount}/${items.length}...`, processedCount);
        
        try {
            const imageDataPromise = fetchImage(item.baseUrl, accessToken); 
            const imgData = await imageDataPromise;

            const janCheck = await imagePrompt("Find the JAN code in this image. Return ONLY the numeric code. If no barcode is clearly visible, return 'NONE'.", [imgData], accessToken, apiKey);
            const janCode = janCheck?.replace(/[^0-9]/g, "");
            
            let targetGroupIdx = -1;

            if (janCode && janCode.length > 5 && janCode !== 'NONE') {
                console.log(`Found JAN: ${janCode}`);
                
                // Find or create group
                targetGroupIdx = groups.findIndex(g => g.janCode === janCode);
                if (targetGroupIdx === -1) {
                    groups.push({ janCode, images: [] });
                    liveGroups.push({ janCode, imageUrls: [], imageStatuses: [], status: 'collecting' });
                    targetGroupIdx = groups.length - 1;
                }
            } else {
                console.log(`No JAN found, adding to current/last group.`);
                // Add to last group or create UNKNOWN
                if (groups.length === 0) {
                     groups.push({ janCode: "UNKNOWN", images: [] });
                     liveGroups.push({ janCode: "UNKNOWN", imageUrls: [], imageStatuses: [], status: 'collecting' });
                }
                targetGroupIdx = groups.length - 1;
            }
            
            // Add image to group
            groups[targetGroupIdx].images.push({ baseUrl: item.baseUrl, dataPromise: imageDataPromise });
            liveGroups[targetGroupIdx].imageUrls.push(item.baseUrl);
            liveGroups[targetGroupIdx].imageStatuses.push('pending');
            
            notify(`Added to ${liveGroups[targetGroupIdx].janCode}`, processedCount);

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
    
    // Mark all as generating
    liveGroups.forEach(g => g.status = 'generating');
    notify("Starting generation...", items.length);

    // Use standard for loop so we can modify 'groups' array if we split variants
    for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        notify(`Generating description for ${group.janCode}...`, items.length);
        
        const groupImagesData = await Promise.all(group.images.map(img => img.dataPromise));
        
        let categories = "";
        let description: string | null = "";
        let splitOccurred = false;

        // Check for variants if multiple images
        if (group.images.length > 1) {
            try {
                // Ask AI if these are variants
                const identificationPrompt = `
                    Look at these ${group.images.length} images. Do they show different variants of a product (e.g. different colors, flavors, or types) sharing the same packaging style?
                    
                    CRITICAL: Ignore "Back of package" or "Ingredient Label" or "Nutrition Facts" images. If one image is the front and another is the back, they are SAMME product. 
                    Only return YES if there are multiple DIFFERENT FRONT FACES.

                    If NO (same product, just different angles/sides), return: {"variants": []}
                    
                    If YES, group them by variant. Return valid JSON:
                    {
                        "variants": [
                            { "name": "Red", "indices": [0, 1] },
                            { "name": "Blue", "indices": [2] }
                        ]
                    }
                    Indices are 0-based.
                `;
                
                const variantJsonRaw = await imagePrompt(identificationPrompt, groupImagesData, accessToken, apiKey);
                
                let variants: { name: string, indices: number[] }[] = [];
                if (variantJsonRaw) {
                    try {
                        const cleanJson = variantJsonRaw.replace(/```json/g, '').replace(/```/g, '').trim();
                        const parsed = JSON.parse(cleanJson);
                        if (parsed.variants && Array.isArray(parsed.variants)) {
                            variants = parsed.variants;
                        }
                    } catch (e) {
                         console.warn("Failed to parse variant JSON", e);
                    }
                }

                if (variants.length > 1) {
                   console.log(`Splitting ${group.janCode} into ${variants.length} variants.`);
                   
                   // Remove current group/liveGroup
                   groups.splice(i, 1);
                   const oldLiveIndex = liveGroups.findIndex(g => g.janCode === group.janCode);
                   if (oldLiveIndex !== -1) liveGroups.splice(oldLiveIndex, 1);
                   
                   // Create new groups
                   // We insert them at 'i' so they are processed next
                   // We process them in reverse order so they land in correct order when unshifted/spliced? 
                   // No, splice inserts at index.
                   
                   const newGroupsToAdd = [];
                   const newLiveGroupsToAdd: LiveGroup[] = [];

                   for (const v of variants) {
                       const newJan = `${group.janCode}:${v.name}`;
                       const newImages = v.indices.map(idx => group.images[idx]).filter(x => x);
                       
                       if (newImages.length > 0) {
                           newGroupsToAdd.push({ janCode: newJan, images: newImages });
                           newLiveGroupsToAdd.push({ 
                               janCode: newJan, 
                               imageUrls: newImages.map(img => img.baseUrl), 
                               imageStatuses: newImages.map(() => 'pending'),
                               status: 'generating' 
                           });
                       }
                   }
                   
                   // Insert into arrays
                   // Note: We need to splice them in.
                   groups.splice(i, 0, ...newGroupsToAdd);
                   if (oldLiveIndex !== -1) {
                        liveGroups.splice(oldLiveIndex, 0, ...newLiveGroupsToAdd);
                   } else {
                        // Should not happen, but push if missing
                        liveGroups.push(...newLiveGroupsToAdd);
                   }
                   
                   // Notify UI of split
                   notify(`Split ${group.janCode} into ${variants.length} variants..`, items.length);
                   
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
            apiKey
        );
        
        // Clean up response if it contains markdown or preamble
        if (description) {
            // Remove markdown code blocks
            description = description.replace(/```html/g, '').replace(/```/g, '');
            // Remove common preambles (heuristic)
            const htmlStart = description.indexOf('<');
            if (htmlStart > -1) {
                description = description.substring(htmlStart);
            }
            description = description.trim();
        }

        // Update live group
        const liveGroup = liveGroups.find(g => g.janCode === group.janCode);
        if (liveGroup) {
            liveGroup.description = description || "Failed";
            liveGroup.categories = categories;
            liveGroup.status = 'generating'; // Still generating images
            notify(`Optimizing images for ${group.janCode}...`, items.length);
        }

        results.push({
            janCode: group.janCode,
            description: description || "Failed to generate",
            categories: categories,
            imageUrls: group.images.map(i => i.baseUrl)
        });

        // 3. Edit Images (Background Removal & Crop)
        for (let imgIdx = 0; imgIdx < group.images.length; imgIdx++) {
            const img = group.images[imgIdx];
            const imgData = groupImagesData[imgIdx]; // Already fetched
            
            // Mark as optimizing
            if (liveGroup) {
                // Clone the group to trigger reactivity
                liveGroups[i] = { ...liveGroup, imageStatuses: [...liveGroup.imageStatuses] };
                liveGroups[i].imageStatuses[imgIdx] = 'optimizing';
                notify(`Optimizing image ${imgIdx + 1}/${group.images.length} for ${group.janCode}...`, items.length);
            }
            
            console.log(`[Image Optimization] Starting optimization for ${group.janCode} image ${imgIdx + 1}`);

            try {
                // Background removal and crop prompt - Explicit text instruction
                const editPrompt = "Remove the background from this image. Then, crop the image tightly around the subject with a 15px margin. Return ONLY the raw Base64 encoded string of the resulting PNG image. Do not use Markdown formatting. Do not wrap in JSON.";
                
                const editedBase64 = await editImage(editPrompt, imgData, accessToken, apiKey);
                
                if (editedBase64) {
                    const dataUri = `data:image/png;base64,${editedBase64}`;
                    // Update Live Group
                    // Re-fetch current live group (it might have been replaced in previous iteration if mixed)
                    const updatedLiveGroup = liveGroups.find(g => g.janCode === group.janCode);
                    if (updatedLiveGroup) {
                        const idx = liveGroups.indexOf(updatedLiveGroup);
                        liveGroups[idx] = { 
                            ...updatedLiveGroup, 
                            imageUrls: [...updatedLiveGroup.imageUrls],
                            imageStatuses: [...updatedLiveGroup.imageStatuses]
                        };
                        liveGroups[idx].imageUrls[imgIdx] = dataUri;
                        liveGroups[idx].imageStatuses[imgIdx] = 'done';
                        
                        notify(`Updated image ${imgIdx + 1} for ${group.janCode}`, items.length);
                        console.log(`[Image Optimization] Finished optimization for ${group.janCode} image ${imgIdx + 1} (Success)`);
                    }
                } else {
                     console.warn(`[Image Optimization] Failed optimization for ${group.janCode} image ${imgIdx + 1} (No data returned)`);
                     const updatedLiveGroup = liveGroups.find(g => g.janCode === group.janCode);
                     if (updatedLiveGroup) {
                        const idx = liveGroups.indexOf(updatedLiveGroup);
                        liveGroups[idx] = { ...updatedLiveGroup, imageStatuses: [...updatedLiveGroup.imageStatuses] };
                        liveGroups[idx].imageStatuses[imgIdx] = 'done'; 
                        notify(`Optimization failed for image ${imgIdx + 1} of ${group.janCode}`, items.length);
                     }
                }
            } catch (e) {
                console.error("Image optimization failed", e);
                const updatedLiveGroup = liveGroups.find(g => g.janCode === group.janCode);
                if (updatedLiveGroup) {
                    const idx = liveGroups.indexOf(updatedLiveGroup);
                    liveGroups[idx] = { ...updatedLiveGroup, imageStatuses: [...updatedLiveGroup.imageStatuses] };
                    liveGroups[idx].imageStatuses[imgIdx] = 'done';
                    notify(`Optimization error for image ${imgIdx + 1}`, items.length);
                }
            }
        }
        
        if (liveGroup) liveGroup.status = 'done';
    }

    return results;
}

/**
 * Edit an image using Gemini 2.0 Flash. 
 * Note: This assumes the API returns inline data for the generated image.
 */
async function editImage(prompt: string, inputImage: { data: string; mimeType: string }, accessToken: string, apiKey?: string): Promise<string | null> {
  // We reuse the basic structure but need to parse the binary or base64 response part
  // The standard generateContent response might contain 'inlineData' in candidates if configured?
  // Or plain text if it refuses.
  
  // Actually, standard REST API for generateContent returns JSON. 
  // If it generates an image, it's usually in `parts` as `inline_data`.
  
  try {
      const contents = [{
        parts: [
            { text: prompt },
            { inline_data: { mime_type: inputImage.mimeType, data: inputImage.data } }
        ]
      }];

      const url = apiKey ? `${GEMINI_API_URL}?key=${apiKey}` : GEMINI_API_URL;
      const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "x-goog-user-project": import.meta.env.VITE_FIREBASE_PROJECT_ID || ""
      };
      
      if (!apiKey) {
          headers["Authorization"] = `Bearer ${accessToken}`;
      }
      
      // We might need to ask for specific response schema or just standard?
      // For image output, we typically just ask.
      
      // Use text/plain with high token limit to accommodate base64 string
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ 
            contents,
            generationConfig: {
                responseMimeType: "text/plain",
                maxOutputTokens: 65536
            }
        })
      });

      if (!response.ok) {
          const txt = await response.text();
          throw new Error(`${response.status} ${response.statusText}: ${txt}`);
      }
      
      const data = await response.json();
      
      // Check for inline data (native - unlikely with text/plain but possible)
      const part = data.candidates?.[0]?.content?.parts?.find((p: any) => p.inline_data);
      if (part && part.inline_data) {
          return part.inline_data.data;
      }
      
      // Check for text
      const textPart = data.candidates?.[0]?.content?.parts?.find((p: any) => p.text);
      if (textPart && textPart.text) {
          let text = textPart.text.trim();
          // Remove potential markdown code blocks if the model ignored instructions
          text = text.replace(/```\w*/g, '').replace(/```/g, '').trim();
          
          console.log("Gemini edit response text (First 200 chars):", text.substring(0, 200));
          
          // Verify it looks like base64 (alphanumeric + +/=)
          // Simple check: no spaces, long length
          if (text.length > 100 && !text.includes(" ")) {
              return text;
          }
           
          // Fallback: Try JSON parse just in case
           try {
              if (text.startsWith('{')) {
                  const json = JSON.parse(text);
                  const imgSrc = json.edited_image || json.processed_image || json.image || json.data || json.image_data;
                   if (imgSrc && typeof imgSrc === 'string' && imgSrc.length > 100) {
                          return imgSrc.startsWith('data:') ? imgSrc.split(',')[1] : imgSrc;
                   }
              }
           } catch (e) {}
           
           console.warn("Gemini returned text but it doesn't look like a raw base64 image or valid JSON.");
      }
      
      // If we got here, we failed. Dump response for debugging.
      console.warn("Edit Image Failed. Full Response dump:", JSON.stringify(data, null, 2));
      
      return null;
  } catch (e) {
      console.error("Edit image error:", e);
      return null;
  }
}
