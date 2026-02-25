/**
 * Server-side image processing using transformers.js and sharp.
 */

const { AutoModel, AutoProcessor, RawImage } = require("@xenova/transformers");
const sharp = require("sharp");

let model = null;
let processor = null;

/**
 * Load the background removal model and processor
 */
async function loadModel() {
  if (model && processor) return { model, processor };
  console.log("[ImageProcessor] Loading briaai/RMBG-1.4 model...");
  // Use quantized model by default to save memory and download time
  model = await AutoModel.from_pretrained("briaai/RMBG-1.4");
  processor = await AutoProcessor.from_pretrained("briaai/RMBG-1.4");
  console.log("[ImageProcessor] Model loaded.");
  return { model, processor };
}

/**
 * Smart Crop: Trims transparent borders from an image
 */
async function smartCrop(inputBuffer) {
  const image = sharp(inputBuffer);
  const { data, info } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const ALPHA_THRESHOLD = 40;

  let minX = width,
    minY = height,
    maxX = 0,
    maxY = 0;
  let foundPixel = false;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        foundPixel = true;
      }
    }
  }

  if (!foundPixel) return inputBuffer;

  const margin = 15;
  const left = Math.max(0, minX - margin);
  const top = Math.max(0, minY - margin);
  const extractWidth = Math.min(width, maxX + margin) - left;
  const extractHeight = Math.min(height, maxY + margin) - top;

  if (extractWidth <= 0 || extractHeight <= 0) return inputBuffer;

  return await image
    .extract({ left, top, width: extractWidth, height: extractHeight })
    .png()
    .toBuffer();
}

/**
 * Remove background from an image buffer using AI
 */
async function removeBackground(imageUrl, originalBuffer) {
  try {
    console.log(`[ImageProcessor] Processing background for ${imageUrl}...`);
    
    const { model, processor } = await loadModel();

    // 1. Load image
    const img = await RawImage.read(originalBuffer);

    // 2. Pre-process
    const { pixel_values } = await processor(img);

    // 3. Predict mask
    const { output } = await model({ input: pixel_values });

    // 4. Post-process mask (resize to original)
    // RMBG-1.4 output is [1, 1, H, W]
    const mask = await RawImage.fromTensor(output.mul(255).to("uint8"), [
      output.dims[2],
      output.dims[3],
    ]).resize(img.width, img.height);

    // 5. Composite (Apply Mask) using sharp
    const { data: originalData, info } = await sharp(originalBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Apply mask to alpha channel
    for (let i = 0; i < info.width * info.height; i++) {
      originalData[i * 4 + 3] = mask.data[i];
    }

    // 6. Convert back to Buffer via sharp
    const processedBuffer = await sharp(originalData, {
      raw: {
        width: info.width,
        height: info.height,
        channels: 4,
      },
    })
      .png()
      .toBuffer();

    // 7. Smart Crop
    return await smartCrop(processedBuffer);
  } catch (e) {
    console.error("[ImageProcessor] Background removal failed, falling back to basic crop:", e);
    
    // Fallback: Just return a smart-cropped version of the original with a white background
    const image = sharp(originalBuffer);
    const fallbackBuffer = await image
      .resize(1024, 1024, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      })
      .flatten({ background: '#ffffff' })
      .png()
      .toBuffer();
      
    return await smartCrop(fallbackBuffer);
  }
}

module.exports = {
  removeBackground,
  smartCrop,
};
