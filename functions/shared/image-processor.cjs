/**
 * Server-side image processing using transformers.js and sharp.
 */

const { pipeline, RawImage } = require("@xenova/transformers");
const sharp = require("sharp");

let rmbgPipeline = null;

/**
 * Load the background removal model
 */
async function getRMBGPipeline() {
  if (rmbgPipeline) return rmbgPipeline;
  console.log("[ImageProcessor] Loading briaai/RMBG-1.4 model...");
  rmbgPipeline = await pipeline("image-segmentation", "briaai/RMBG-1.4");
  return rmbgPipeline;
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

  let minX = width, minY = height, maxX = 0, maxY = 0;
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

  return await image
    .extract({ left, top, width: extractWidth, height: extractHeight })
    .png()
    .toBuffer();
}

/**
 * Remove background from an image buffer
 */
async function removeBackground(inputBuffer) {
  try {
    const pipe = await getRMBGPipeline();
    
    // 1. Get Mask using transformers.js
    // RawImage from Buffer
    const img = await RawImage.fromBlob(new Blob([inputBuffer]));
    const output = await pipe(img);
    
    // The output of image-segmentation pipeline is already the masked image (usually)
    // or we might need to apply the mask manually if using Raw model.
    // For briaai/RMBG-1.4 via pipeline, it returns the processed image.
    
    // pipeline output can be a RawImage or a canvas-like object
    const processedRawImage = output; 
    
    // Convert back to Buffer via sharp
    const processedBuffer = await sharp(processedRawImage.data, {
      raw: {
        width: processedRawImage.width,
        height: processedRawImage.height,
        channels: 4
      }
    }).png().toBuffer();

    // 2. Smart Crop
    return await smartCrop(processedBuffer);
  } catch (e) {
    console.error("[ImageProcessor] Background removal failed:", e);
    throw e;
  }
}

module.exports = {
  removeBackground,
  smartCrop,
};
