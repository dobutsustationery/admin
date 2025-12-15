import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Parse .env manually to get API KEY
function getEnvVar(keys: string[]): string | undefined {
    // Try process.env first
    for (const key of keys) {
        if (process.env[key]) return process.env[key];
    }

    // Try files
    const files = ['.env', '.env.local', '.env.staging'];
    for (const file of files) {
        try {
            const envPath = path.resolve(file);
            if (fs.existsSync(envPath)) {
                const envContent = fs.readFileSync(envPath, 'utf-8');
                for (const key of keys) {
                     const match = envContent.match(new RegExp(`^${key}=("?)(.*?)\\1$`, 'm'));
                     if (match) return match[2];
                }
            }
        } catch (e) {}
    }
    return undefined;
}

test('Debug Gemini Image Editing', async ({ page }) => {
    // 0. Setup
    const apiKey = getEnvVar(['VITE_GOOGLE_API_KEY', 'VITE_FIREBASE_STAGING_API_KEY']);
    if (!apiKey) {
        console.error("CRITICAL: No API Key found in .env, .env.local, or .env.staging");
        return; 
    }
    console.log(`API Key found (starts with: ${apiKey.substring(0, 4)}...)`);

    // 1. Load a test image as base64
    const imagePath = path.resolve('e2e/test-images/006ccee443ad388aa0799f9d6d97290f.jpg');
    if (!fs.existsSync(imagePath)) {
        console.log("Downloading fallback test image...");
        // Use a tiny 1x1 red pixel if file missing, but we prefer the real one
        // Base64 for red dot:
        // iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKwftQAAAABJRU5ErkJggg==
    }
    console.log(`Loading test image: ${imagePath}`);
    const buffer = fs.readFileSync(imagePath);
    const base64Image = buffer.toString('base64');
    
    // 2. Define strategies to test
    const strategies = [
        {
            name: "Strategy 1: Native Image Response (image/png) [Previously Failed]",
            prompt: "Remove background. Return processed image.",
            mimeType: "image/png",
            maxTokens: 65536
        },
        {
            name: "Strategy 2: Text Response (Raw Base64) [Current Implementation]",
            prompt: "Remove the background from this image. Then, crop the image tightly around the subject with a 15px margin. Return ONLY the raw Base64 encoded string of the resulting PNG image. Do not use Markdown formatting. Do not wrap in JSON.",
            mimeType: "text/plain",
            maxTokens: 65536
        },
        {
            name: "Strategy 3: JSON Response [Alternative]",
            prompt: "Remove background. Return JSON object { \"image_data\": \"<BASE64>\" }.",
            mimeType: "application/json",
            maxTokens: 65536
        }
    ];

    console.log("\n--- STARTING GEMINI EXPERIMENTS ---\n");

    for (const strat of strategies) {
        console.log(`\nTesting ${strat.name}...`);

        // Execute inside browser context to use fetch
        const result = await page.evaluate(async ({ apiKey, strat, base64Image }) => {
            const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
            const url = `${GEMINI_API_URL}?key=${apiKey}`;

            // Handle MimeType for input image (assuming jpeg from file extension)
            const inputMimeType = "image/jpeg";

            const contents = [{
                parts: [
                    { text: strat.prompt },
                    { inline_data: { mime_type: inputMimeType, data: base64Image } }
                ]
            }];

            const generationConfig: any = {
                maxOutputTokens: strat.maxTokens
            };
            if (strat.mimeType) generationConfig.responseMimeType = strat.mimeType;

            const t0 = performance.now();
            try {
                const response = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ contents, generationConfig })
                });

                const t1 = performance.now();
                const duration = Math.round(t1 - t0);

                if (!response.ok) {
                    return { success: false, status: response.status, text: await response.text(), duration };
                }

                const data = await response.json();
                return { success: true, data, duration };
            } catch (e: any) {
                return { success: false, error: e.toString(), duration: 0 };
            }
        }, { apiKey, strat, base64Image });

        // Log Results
        if (result.success) {
            console.log(`  [SUCCESS] Status: 200, Time: ${result.duration}ms`);
            
            const data = result.data;
            const candidate = data.candidates?.[0];
            
            if (candidate?.finishReason) {
                console.log(`  FinishReason: ${candidate.finishReason}`);
            }

            let foundImage = false;
            
            // Check parts
            candidate?.content?.parts?.forEach((p: any, i: number) => {
                if (p.inline_data) {
                    console.log(`  Part ${i}: [INLINE IMAGE] ${p.inline_data.mime_type}, Size: ${p.inline_data.data.length} chars`);
                    foundImage = true;
                } else if (p.text) {
                    const snippet = p.text.substring(0, 100).replace(/\n/g, ' ');
                    console.log(`  Part ${i}: [TEXT] Length: ${p.text.length} chars. Start: "${snippet}"`);
                    if (p.text.length > 1000) foundImage = true; // Assume large text is base64
                }
            });

            if (!foundImage) {
                console.warn("  [WARNING] No image data found in response!");
                console.log("  Full Dump:", JSON.stringify(data));
            }

        } else {
            console.error(`  [FAILED] Status: ${result.status}`);
            console.error(`  Error: ${result.text || result.error}`);
        }
    }
    console.log("\n--- EXPERIMENTS COMPLETE ---\n");
});
