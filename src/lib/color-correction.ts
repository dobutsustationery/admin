/**
 * Auto Color Correction (Auto Levels)
 * 
 * Performs histogram stretching on R, G, B channels independently.
 * Clips top/bottom 0.5% of pixels to avoid outlier influence.
 */
export async function autoColorCorrect(input: string): Promise<string> {
    const img = new Image();
    img.src = input.startsWith('data:') ? input : `data:image/png;base64,${input}`;
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
    });

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("No context");
    
    ctx.drawImage(img, 0, 0);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;
    const pixelCount = canvas.width * canvas.height;

    // 1. Compute Histograms
    const histR = new Uint32Array(256);
    const histG = new Uint32Array(256);
    const histB = new Uint32Array(256);

    for (let i = 0; i < data.length; i += 4) {
        histR[data[i]]++;
        histG[data[i+1]]++;
        histB[data[i+2]]++;
    }

    // 2. Find Min/Max using cumulative distribution (Auto Levels)
    const clipPercent = 0.005; // 0.5%
    const minCount = pixelCount * clipPercent;
    const maxCount = pixelCount * (1 - clipPercent);

    const getLevels = (hist: Uint32Array) => {
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
            if (sum > minCount) { // Symmetric clip
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
    const map = (val: number, min: number, max: number) => {
        if (max === min) return val;
        let v = (val - min) * 255 / (max - min);
        if (v < 0) v = 0;
        if (v > 255) v = 255;
        return v;
    };

    for (let i = 0; i < data.length; i += 4) {
        data[i] = map(data[i], levelsR.min, levelsR.max);
        data[i+1] = map(data[i+1], levelsG.min, levelsG.max);
        data[i+2] = map(data[i+2], levelsB.min, levelsB.max);
    }

    ctx.putImageData(imgData, 0, 0);

    return canvas.toDataURL("image/png").split(",")[1];
}
