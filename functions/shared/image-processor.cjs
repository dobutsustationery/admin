/**
 * Server-side image processing using sharp.
 * Deterministic background removal (mocked with smart crop + white background for now
 * to avoid heavy model downloads in ephemeral function environments).
 */

const sharp = require("sharp");

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
 * Remove background from an image (deterministic sharp-based implementation)
 * This is a placeholder for a full AI model that avoids runtime downloads.
 */
async function removeBackground(imageUrl, originalBuffer) {
  try {
    console.log(`[ImageProcessor] Processing background for ${imageUrl}...`);
    
    // For now, we perform a "Smart Contrast" + Center Crop to simulate the effect
    // without requiring a 170MB model download which fails in some restricted environments.
    // Real implementation should bundle the model or use a dedicated inference service.
    
    const image = sharp(originalBuffer);
    
    // 1. Convert to a square canvas with white background
    const processedBuffer = await image
      .resize(1024, 1024, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      })
      .flatten({ background: '#ffffff' }) // Remove alpha channel if it exists
      .png()
      .toBuffer();

    // 2. Return processed result
    return await smartCrop(processedBuffer);
  } catch (e) {
    console.error("[ImageProcessor] Image processing failed:", e);
    throw e;
  }
}

module.exports = {
  removeBackground,
  smartCrop,
};
