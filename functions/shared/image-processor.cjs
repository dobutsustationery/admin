/**
 * Server-side image processing using transformers.js and sharp.
 */

const {
  env,
  AutoModel,
  AutoProcessor,
  RawImage,
} = require("@xenova/transformers");
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
  if (rmbgModel && rmbgProcessor)
    return { model: rmbgModel, processor: rmbgProcessor };
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    console.log(
      "[ImageProcessor] Loading briaai/RMBG-1.4 model from local path...",
    );
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
    if (
      e.message.includes("heif") ||
      e.message.includes("decode") ||
      e.message.includes("header")
    ) {
      try {
        const { width, height, data } = await heicDecode({
          buffer: inputBuffer,
        });
        const info = { width, height, channels: 4 };
        const image = sharp(Buffer.from(data), {
          raw: { width, height, channels: 4 },
        });
        return { image, data: Buffer.from(data), info };
      } catch (fallbackError) {
        console.error(
          "[ImageProcessor] Fallback decode also failed:",
          fallbackError,
        );
        throw e; // Throw original error if fallback also fails
      }
    }
    throw e;
  }
}

/**
 * Smart Crop: Trims transparent borders from an image
 */
/**
 * Generates a subject mask using the RMBG model.
 */
async function getSubjectMask(inputBuffer) {
  const { model, processor } = await loadRMBGModel();
  const { data, info } = await decodeImage(inputBuffer);

  const rgbData = await sharp(data, {
    raw: {
      width: info.width,
      height: info.height,
      // @ts-ignore
      channels: info.channels,
    },
  })
    .removeAlpha()
    .toBuffer();

  const img = new RawImage(rgbData, info.width, info.height, 3);
  const { pixel_values } = await processor(img);
  const { output } = await model({ input: pixel_values });

  return await RawImage.fromTensor(output[0].mul(255).to("uint8")).resize(
    img.width,
    img.height,
  );
}
async function smartCrop(inputBuffer) {
  const { image, data, info } = await decodeImage(inputBuffer);
  const { width, height } = info;
  const ALPHA_THRESHOLD = 10;

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

  // If the transparency-based bounding box is the full image, it's likely an opaque image.
  // In this case, we fall back to AI subject detection.
  const isFullImage =
    foundPixel &&
    minX === 0 &&
    minY === 0 &&
    maxX === width - 1 &&
    maxY === height - 1;

  let finalMargin = 20;

  if (!foundPixel || isFullImage) {
    try {
      console.log(
        "[ImageProcessor] No transparency or full image detected, using AI subject detection for cropping...",
      );
      const mask = await getSubjectMask(inputBuffer);
      let maxScore = 0;
      for (let i = 0; i < mask.data.length; i++) {
        if (mask.data[i] > maxScore) maxScore = mask.data[i];
      }

      const dynamicThreshold = Math.max(128, maxScore * 0.5);

      let aiFoundPixel = false;
      let aiMinX = width,
        aiMinY = height,
        aiMaxX = 0,
        aiMaxY = 0;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const score = mask.data[y * width + x];
          if (score >= dynamicThreshold) {
            if (x < aiMinX) aiMinX = x;
            if (x > aiMaxX) aiMaxX = x;
            if (y < aiMinY) aiMinY = y;
            if (y > aiMaxY) aiMaxY = y;
            aiFoundPixel = true;
          }
        }
      }

      if (aiFoundPixel) {
        minX = aiMinX;
        minY = aiMinY;
        maxX = aiMaxX;
        maxY = aiMaxY;
        foundPixel = true;
        finalMargin = 50; // Use larger margin for AI crop
        console.log(
          `[ImageProcessor] AI Bounding Box: (${minX},${minY}) to (${maxX},${maxY}) with 50px margin`,
        );
      }
    } catch (e) {
      console.warn(
        "[ImageProcessor] AI subject detection failed for cropping, returning original image",
        e,
      );
      return inputBuffer;
    }
  }

  if (!foundPixel) return inputBuffer;

  const left = Math.max(0, minX - finalMargin);
  const top = Math.max(0, minY - finalMargin);
  const extractWidth = Math.min(width, maxX + finalMargin + 1) - left;
  const extractHeight = Math.min(height, maxY + finalMargin + 1) - top;

  // If the final crop is still basically the full image, return original to avoid unnecessary processing
  const isStillFullImage =
    left === 0 &&
    top === 0 &&
    extractWidth === width &&
    extractHeight === height;
  if (isStillFullImage) {
    console.log("[ImageProcessor] Resulting crop is full image, skipping.");
    return inputBuffer;
  }

  console.log(
    `[ImageProcessor] Cropping ${width}x${height} -> ${extractWidth}x${extractHeight} at (${left}, ${top})`,
  );

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
    const mask = await getSubjectMask(originalBuffer);
    const { data: originalData, info } = await decodeImage(originalBuffer);

    for (let i = 0; i < info.width * info.height; i++) {
      originalData[i * 4 + 3] = mask.data[i];
    }

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
    console.error(
      `[ImageProcessor] Background removal failed for ${imageUrl}:`,
      e,
    );
    throw e;
  }
}

module.exports = {
  removeBackground,
  autoColorCorrect,
  smartCrop,
};
