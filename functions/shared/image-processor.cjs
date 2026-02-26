/**
 * Server-side image processing using transformers.js and sharp.
 */

const { env, AutoModel, AutoProcessor, RawImage } = require("@xenova/transformers");
const sharp = require("sharp");
const path = require("path");
const heicDecode = require("heic-decode");

// Configure Transformers.js to use local model files only.
// This avoids 429 Too Many Requests errors from Hugging Face and improves startup time.
env.allowRemoteModels = false;
env.localModelPath = path.join(__dirname, "../models");

let rmbgModel = null;
let rmbgProcessor = null;
let loadingPromise = null;

/**
 * Load the high-quality RMBG-1.4 model
 */
async function loadRMBGModel() {
  if (rmbgModel && rmbgProcessor) return { model: rmbgModel, processor: rmbgProcessor };
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    console.log("[ImageProcessor] Loading briaai/RMBG-1.4 model from local path...");
    // Use AutoModel (generic) as it handles the custom Segformer mapping better in v2
    const [model, processor] = await Promise.all([
      AutoModel.from_pretrained("briaai/RMBG-1.4"),
      AutoProcessor.from_pretrained("briaai/RMBG-1.4"),
    ]);
    rmbgModel = model;
    rmbgProcessor = processor;
    console.log("[ImageProcessor] RMBG-1.4 model loaded.");
    return { model, processor };
  })();

  return loadingPromise;
}

/**
 * Robustly decodes an image buffer, falling back to heic-decode for HEIF/HEIC if sharp fails.
 */
async function decodeImage(inputBuffer) {
  try {
    // Try native sharp first (fastest, supports most formats)
    const image = sharp(inputBuffer);
    const { data, info } = await image
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { image, data, info };
  } catch (e) {
    // If it's potentially a HEIF issue, try manual decode
    if (e.message.includes("heif") || e.message.includes("decode") || e.message.includes("header")) {
      try {
        const { width, height, data } = await heicDecode({ buffer: inputBuffer });
        const info = { width, height, channels: 4 };
        const image = sharp(Buffer.from(data), {
          raw: { width, height, channels: 4 }
        });
        return { image, data: Buffer.from(data), info };
      } catch (fallbackError) {
        console.error("[ImageProcessor] Fallback decode also failed:", fallbackError);
        throw e; // Throw original error if fallback also fails
      }
    }
    throw e;
  }
}

/**
 * Smart Crop: Trims transparent borders from an image
 */
async function smartCrop(inputBuffer) {
  const { image, data, info } = await decodeImage(inputBuffer);
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
 * Auto Color Correct (Auto Levels)
 */
async function autoColorCorrect(originalBuffer) {
  try {
    const { info, data } = await decodeImage(originalBuffer);
    const { width, height } = info;
    const pixelCount = width * height;

    // 1. Compute Histograms
    const histR = new Uint32Array(256);
    const histG = new Uint32Array(256);
    const histB = new Uint32Array(256);

    for (let i = 0; i < data.length; i += 4) {
      histR[data[i]]++;
      histG[data[i + 1]]++;
      histB[data[i + 2]]++;
    }

    // 2. Find Min/Max using cumulative distribution (Auto Levels)
    const clipPercent = 0.005; // 0.5%
    const minCount = pixelCount * clipPercent;

    const getLevels = (hist) => {
      let min = 0;
      let sum = 0;
      for (let i = 0; i < 256; i++) {
        sum += hist[i];
        if (sum > minCount) {
          min = i;
          break;
        }
      }

      let max = 255;
      sum = 0;
      for (let i = 255; i >= 0; i--) {
        sum += hist[i];
        if (sum > minCount) {
          max = i;
          break;
        }
      }
      return { min, max };
    };

    const levelsR = getLevels(histR);
    const levelsG = getLevels(histG);
    const levelsB = getLevels(histB);

    // 3. Apply Correction
    const map = (val, min, max) => {
      if (max === min) return val;
      let v = Math.round(((val - min) * 255) / (max - min));
      if (v < 0) v = 0;
      if (v > 255) v = 255;
      return v;
    };

    // Modify buffer in place
    for (let i = 0; i < data.length; i += 4) {
      data[i] = map(data[i], levelsR.min, levelsR.max);
      data[i + 1] = map(data[i + 1], levelsG.min, levelsG.max);
      data[i + 2] = map(data[i + 2], levelsB.min, levelsB.max);
    }

    return await sharp(data, {
      raw: {
        width: info.width,
        height: info.height,
        channels: 4,
      },
    })
      .png()
      .toBuffer();
  } catch (e) {
    console.error("[ImageProcessor] Color correction failed:", e);
    throw e;
  }
}

/**
 * Remove background from an image buffer using high-quality AI (RMBG-1.4)
 */
async function removeBackground(imageUrl, originalBuffer) {
  try {
    console.log(`[ImageProcessor] AI background removal for ${imageUrl}...`);
    
    const { model, processor } = await loadRMBGModel();

    // 1. Load image using decodeImage helper to get raw pixel data (RGB)
    const { data: originalData, info } = await decodeImage(originalBuffer);

    // transformers.js needs RGB (3 channels), so we strip alpha if it exists
    const rgbData = await sharp(originalData, {
      raw: {
        width: info.width,
        height: info.height,
        channels: info.channels,
      }
    })
      .removeAlpha()
      .toBuffer();

    const img = new RawImage(rgbData, info.width, info.height, 3);

    // 2. Pre-process
    const { pixel_values } = await processor(img);

    // 3. Predict mask
    const { output } = await model({ input: pixel_values });

    // 4. Post-process mask (resize to original)
    // The output[0] is the mask tensor
    const mask = await RawImage.fromTensor(output[0].mul(255).to("uint8")).resize(
      img.width,
      img.height,
    );

    // 5. Composite (Apply Mask) using sharp
    // originalData already has alpha from decodeImage

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
    console.error(`[ImageProcessor] Background removal failed for ${imageUrl}:`, e);
    throw e;
  }
}

module.exports = {
  removeBackground,
  autoColorCorrect,
  smartCrop,
};
