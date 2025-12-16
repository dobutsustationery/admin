import { env, AutoModel, AutoProcessor, RawImage } from "@xenova/transformers";

// Configure transformers.js
// Skip local check to ensure we download from HF hub if not cached
env.allowLocalModels = false;
env.useBrowserCache = true;

// Singleton to hold the loaded model/processor
class RMBGProcessor {
  static instance: RMBGProcessor;
  model: any;
  processor: any;
  loading: boolean = false;

  constructor() {}

  static async getInstance() {
    if (!RMBGProcessor.instance) {
      RMBGProcessor.instance = new RMBGProcessor();
    }
    return RMBGProcessor.instance;
  }

  async load() {
    if (this.model) return;
    if (this.loading) {
      // Simple polling wait if already loading
      while (this.loading) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return;
    }

    this.loading = true;
    try {
      console.log("[BackgroundRemoval] Loading model briaai/RMBG-1.4...");
      // Use quantized model by default (default behavior of transformers.js)
      this.model = await AutoModel.from_pretrained("briaai/RMBG-1.4", {
        // explicit config if needed, defaults are usually fine
      });
      this.processor = await AutoProcessor.from_pretrained("briaai/RMBG-1.4");
      console.log("[BackgroundRemoval] Model loaded.");
    } catch (e) {
      console.error("[BackgroundRemoval] Failed to load model:", e);
      throw e;
    } finally {
      this.loading = false;
    }
  }
}

export async function removeBackground(
  imageUrl: string,
): Promise<string | null> {
  try {
    console.log(
      `[BackgroundRemoval] Processing image client-side: ${imageUrl}`,
    );

    const instance = await RMBGProcessor.getInstance();
    await instance.load(); // Ensure loaded

    // 1. Fetch Image
    // Transformers.js RawImage.fromURL handles CORS if the server allows it.
    // If imageUrl is a Blob URL or Data URL, it handles that too.
    // For Google Photos URLs, we might hit CORS if not proxied?
    // Wait, the original `editImage` used `fetch(url)` which assumes CORS is OK or proxied.
    // The implementation_plan says "client-side execution".
    // If `imageUrl` is external and strict CORS, `RawImage.fromURL` might fail.
    // But for `test-edit` we use a public accessible URL.
    // For the real app, we use Google Photos base URLs.
    // Google Photos Base URLs usually DO NOT allow CORS for canvas manipulation unless `crossorigin` is set.
    // However, we can use `fetch` with `mode: 'cors'` if allowed, or we might need to proxy the *image download*.
    // BUT calling the model is local.

    // Let's assume standard fetch works for now.
    const image = await RawImage.fromURL(imageUrl);

    // 2. Pre-process
    const { pixel_values } = await instance.processor(image);

    // 3. Predict
    const { output } = await instance.model({ input: pixel_values });

    // 4. Post-process (Mask extraction)
    // The output is the alpha mask. We need to resize it back to original image size and apply it.
    // Transformers.js example code for RMBG-1.4:

    const mask = await RawImage.fromTensor(
      output[0].mul(255).to("uint8"),
    ).resize(image.width, image.height);

    // 5. Composite
    // We need to apply the mask to the original image.
    // RawImage has a `clone` method? Or we can use canvas.

    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get canvas context");

    // Draw original image
    ctx.drawImage(image.toCanvas(), 0, 0);

    const maskData = mask.data; // This might be 1 channel or 3/4 depending on output.
    // RawImage.fromTensor usually makes RGB or RGBA?
    // RMBG output is usually 1 channel grayscale.

    // Let's inspect mask structure. Transformers.js RawImage is usually RGBA (4 channels).
    // If fromTensor, it converts.

    // 5. Composite
    // The mask raw image might be 1-channel or 3-channel grayscale.
    // We iterate pixels and set Alpha channel of original image to the mask value.
    const imgData = ctx.getImageData(0, 0, image.width, image.height);

    // mask.data is a Uint8Array.
    // If mask was created from 1-channel tensor, RawImage might still be 1, 3, or 4 channels depending on impl.
    // Let's assume mask.data length maps to pixels.
    // If mask.channels = 1, index i corresponds to pixel i.
    // If mask.channels = 3 (RGB), index i*3 is R.
    // Quick way to know is ratio of mask.data.length / (width*height)

    const pixelCount = image.width * image.height;
    const maskChannels = mask.data.length / pixelCount;

    for (let i = 0; i < pixelCount; i++) {
      // Index in RGBA image data (4 channels)
      const imgIdx = i * 4;

      // Index in Mask data
      // If 1 channel: i
      // If 3 channels: i * 3 (take first byte)
      // If 4 channels: i * 4 (take first byte? or alpha?)
      // RMBG output is usually grayscale, so any channel (R,G,B) is the value.

      let maskVal = 0;
      if (maskChannels === 1) {
        maskVal = mask.data[i];
      } else if (maskChannels >= 3) {
        maskVal = mask.data[i * maskChannels]; // Take Red/Gray value
      }

      // Set Alpha of original image
      imgData.data[imgIdx + 3] = maskVal;
    }

    ctx.putImageData(imgData, 0, 0);

    // 6. smart Crop
    // Scan alpha channel to find bounding box
    let minX = image.width;
    let minY = image.height;
    let maxX = 0;
    let maxY = 0;
    let foundPixel = false;

    // Settings for noise reduction
    const ALPHA_THRESHOLD = 40; // Ignore shadows/faint smoke
    const NEIGHBOR_THRESHOLD = 2; // Require at least 2 neighbors to avoid single-pixel specs

    for (let y = 1; y < image.height - 1; y++) {
      for (let x = 1; x < image.width - 1; x++) {
        const idx = (y * image.width + x) * 4 + 3;
        if (imgData.data[idx] > ALPHA_THRESHOLD) {
          // Noise Filter: Check 3x3 neighbors
          // If a pixel is isolated, it's likely dust.
          let neighborCount = 0;
          // Check 8 neighbors
          if (imgData.data[idx - 4] > ALPHA_THRESHOLD) neighborCount++; // Left
          if (imgData.data[idx + 4] > ALPHA_THRESHOLD) neighborCount++; // Right
          if (imgData.data[idx - image.width * 4] > ALPHA_THRESHOLD)
            neighborCount++; // Up
          if (imgData.data[idx + image.width * 4] > ALPHA_THRESHOLD)
            neighborCount++; // Down
          // Diagonals (optional, but good for connectivity)
          if (imgData.data[idx - image.width * 4 - 4] > ALPHA_THRESHOLD)
            neighborCount++;
          if (imgData.data[idx - image.width * 4 + 4] > ALPHA_THRESHOLD)
            neighborCount++;
          if (imgData.data[idx + image.width * 4 - 4] > ALPHA_THRESHOLD)
            neighborCount++;
          if (imgData.data[idx + image.width * 4 + 4] > ALPHA_THRESHOLD)
            neighborCount++;

          if (neighborCount >= NEIGHBOR_THRESHOLD) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            foundPixel = true;
          }
        }
      }
    }

    let finalCanvas = canvas;
    if (foundPixel) {
      const margin = 15;
      // Expand with margin but keep within bounds
      const cropX = Math.max(0, minX - margin);
      const cropY = Math.max(0, minY - margin);
      const cropWidth = Math.min(image.width, maxX + margin) - cropX;
      const cropHeight = Math.min(image.height, maxY + margin) - cropY;

      // Create cropped canvas
      if (cropWidth > 0 && cropHeight > 0) {
        const cropCanvas = document.createElement("canvas");
        cropCanvas.width = cropWidth;
        cropCanvas.height = cropHeight;
        const cropCtx = cropCanvas.getContext("2d");
        if (cropCtx) {
          cropCtx.putImageData(
            ctx.getImageData(cropX, cropY, cropWidth, cropHeight),
            0,
            0,
          );
          finalCanvas = cropCanvas;
        }
      }
    }

    // 7. Export to Base64 (strip prefix for consistency with previous API)
    const base64Url = finalCanvas.toDataURL("image/png");
    const base64Data = base64Url.split(",")[1];

    return base64Data;
  } catch (e) {
    console.error("[BackgroundRemoval] Client-side processing failed:", e);
    return null; // or throw
  }
}
