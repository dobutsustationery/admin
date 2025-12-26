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

  async predictMask(image: any) {
     await this.load();
     // Pre-process
     const { pixel_values } = await this.processor(image);
     // Predict
     const { output } = await this.model({ input: pixel_values });
     // Post-process (Resize mask)
     const mask = await RawImage.fromTensor(
       output[0].mul(255).to("uint8")
     ).resize(image.width, image.height);
     return mask;
  }
}

export async function removeBackground(
  imageUrl: string,
): Promise<string | null> {
  try {
    const instance = await RMBGProcessor.getInstance();
    const image = await RawImage.fromURL(imageUrl);

    // 1. Get Mask
    const mask = await instance.predictMask(image);

    // 2. Composite (Apply Mask)
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get canvas context");

    ctx.drawImage(image.toCanvas(), 0, 0);

    const imgData = ctx.getImageData(0, 0, image.width, image.height);
    const pixelCount = image.width * image.height;
    const maskChannels = mask.data.length / pixelCount;

    for (let i = 0; i < pixelCount; i++) {
      const imgIdx = i * 4;
      let maskVal = 0;
      if (maskChannels === 1) {
        maskVal = mask.data[i];
      } else if (maskChannels >= 3) {
        maskVal = mask.data[i * maskChannels]; 
      }
      imgData.data[imgIdx + 3] = maskVal;
    }

    ctx.putImageData(imgData, 0, 0);

    // 3. Smart Crop (Result is transparent now, so alpha scan will work)
    return await smartCrop(canvas);

  } catch (e) {
    console.error("[BackgroundRemoval] Client-side processing failed:", e);
    return null; 
  }
}

/**
 * Smart Crop: Trims transparent borders from an image
 */
export async function smartCrop(input: string | HTMLCanvasElement): Promise<string> {
    let canvas: HTMLCanvasElement;
    
    if (typeof input === 'string') {
        // Load Base64 to Canvas
        const img = new Image();
        img.src = input.startsWith('data:') ? input : `data:image/png;base64,${input}`;
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
        });
        canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error("No context");
        ctx.drawImage(img, 0, 0);
    } else {
        canvas = input;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("No context");
    
    const width = canvas.width;
    const height = canvas.height;
    const imgData = ctx.getImageData(0, 0, width, height);

    // 1. Determine Background Mode (Transparent vs Solid Color)
    // Scan alpha channel FIRST. If we find meaningful alpha, use that.
    const ALPHA_THRESHOLD = 40; 
    
    let hasTransparency = false;
    for (let i = 3; i < imgData.data.length; i += 4) {
        if (imgData.data[i] < 255 - ALPHA_THRESHOLD) {
            hasTransparency = true;
            break;
        }
    }

    // 2. Scan for Subject BBox
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let foundPixel = false;

    if (hasTransparency) {
        // --- ALPHA SCAN (Fast, for transparent images) ---
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                if (imgData.data[i + 3] > ALPHA_THRESHOLD) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    foundPixel = true;
                }
            }
        }
    } else {
        // --- AI SCAN (Slow, for opaque images - crops to mask bbox) ---
        console.log("[SmartCrop] Opaque image detected. Using AI for crop mask...");
        try {
             const instance = await RMBGProcessor.getInstance();
             // We need to pass url or RawImage. Since we have canvas, convert to blob url or RawImage.fromCanvas?
             // Only RawImage.fromURL or fromTensor is exposed usually, but let's see. 
             // RawImage can be created from canvas? No easily documented way in this context?
             // Actually, RawImage.read(url) works.
             // Or we just get base64.
             const b64 = canvas.toDataURL("image/png");
             const image = await RawImage.fromURL(b64);
             
             const mask = await instance.predictMask(image);
             
             // Scan mask data
             const pixelCount = width * height;
             const maskChannels = mask.data.length / pixelCount;
             
             for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const idx = (y * width + x);
                    let val = 0;
                    if (maskChannels === 1) val = mask.data[idx];
                    else val = mask.data[idx * maskChannels]; // R channel likely
                    
                    if (val > 10) { // Keep low threshold for mask
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                        foundPixel = true;
                    }
                }
             }
             
        } catch (e) {
            console.error("[SmartCrop] AI Mask failed:", e);
            // Fallback to full image (foundPixel = false)
        }
    }


    if (foundPixel) {
      // Add requested padding (15px)
      const margin = 15;
      const cropX = Math.max(0, minX - margin);
      const cropY = Math.max(0, minY - margin);
      const cropWidth = Math.min(width, maxX + margin) - cropX;
      const cropHeight = Math.min(height, maxY + margin) - cropY;

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
          return cropCanvas.toDataURL("image/png").split(",")[1];
        }
      }
    }
    
    return canvas.toDataURL("image/png").split(",")[1];
}
