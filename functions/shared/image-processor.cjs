/**
 * Server-side image processing using transformers.js and sharp.
 */

const { AutoModel, AutoProcessor, RawImage } = require("@xenova/transformers");
const sharp = require("sharp");

let model = null;
let processor = null;
let loadingPromise = null;

/**
 * Load the background removal model and processor
 */
async function loadModel() {
  if (model && processor) return { model, processor };
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    console.log("[ImageProcessor] Loading Xenova/modnet model...");
    // Use fp32 explicitly as per documentation and use Promise.all for speed
    const [m, p] = await Promise.all([
      AutoModel.from_pretrained("Xenova/modnet", { dtype: "fp32" }),
      AutoProcessor.from_pretrained("Xenova/modnet"),
    ]);
    model = m;
    processor = p;
    console.log("[ImageProcessor] Model loaded.");
    return { model, processor };
  })();

  return loadingPromise;
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
    console.log(`[ImageProcessor] AI background removal for ${imageUrl}...`);
    
    const { model, processor } = await loadModel();

    // 1. Load image using sharp to get raw pixel data
    const { data: rawData, info: rawInfo } = await sharp(originalBuffer)
      .removeAlpha() // MODNet expects 3 channels (RGB)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const img = new RawImage(rawData, rawInfo.width, rawInfo.height, 3);

    // 2. Pre-process
    const { pixel_values } = await processor(img);

    // 3. Predict mask
    const { output } = await model({ input: pixel_values });

    // 4. Post-process mask (resize to original)
    // Use canonical fromTensor API. MODNet output is [1, 1, H, W], 
    // so output[0] gives [1, H, W] which fromTensor handles as a single-channel image.
    const mask = await RawImage.fromTensor(output[0].mul(255).to("uint8")).resize(
      img.width,
      img.height,
    );

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
    console.error("[ImageProcessor] Background removal failed:", e);
    throw e;
  }
}

module.exports = {
  removeBackground,
  smartCrop,
};
