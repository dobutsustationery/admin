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

test('Debug Gemini Models for Image Editing', async ({ page }) => {
    // 0. Setup
    const apiKey = getEnvVar(['VITE_GOOGLE_API_KEY', 'VITE_FIREBASE_STAGING_API_KEY']);
    if (!apiKey) {
        console.error("CRITICAL: API Key not found.");
        return; 
    }
    console.log(`API Key found (starts with: ${apiKey.substring(0, 4)}...)`);

    // 1. Load a test image as base64
    const imagePath = path.resolve('e2e/test-images/006ccee443ad388aa0799f9d6d97290f.jpg');
    if (!fs.existsSync(imagePath)) {
        console.log("No image found.");
        return;
    }
    const buffer = fs.readFileSync(imagePath);
    const base64Image = buffer.toString('base64');
    
    // 2. Define strategies to test
    const strategies = [
        {
            name: "Model: Gemini 1.5 Flash (Text Response)",
            model: "gemini-1.5-flash",
            prompt: "Remove the background from this image. Return ONLY the raw Base64 encoded string of the resulting PNG image.",
            mimeType: "text/plain",
        },
        {
            name: "Model: Gemini 1.5 Pro (Text Response)",
            model: "gemini-1.5-pro",
            prompt: "Remove the background. Return raw Base64 PNG.",
            mimeType: "text/plain",
        },
        {
             name: "Model: Gemini 2.0 Flash (Native Image Response Check)",
             model: "gemini-2.0-flash",
             prompt: "Remove background",
             mimeType: "image/png"  // Expect 400 failure, but verifying behavior hasn't changed
        }
    ];

    console.log("\n--- STARTING MODEL COMPARISON ---\n");

    for (const strat of strategies) {
        console.log(`\nTesting ${strat.name}...`);

        const result = await page.evaluate(async ({ apiKey, strat, base64Image }) => {
            const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${strat.model}:generateContent`;
            const url = `${GEMINI_API_URL}?key=${apiKey}`;

            const contents = [{
                parts: [
                    { text: strat.prompt },
                    { inline_data: { mime_type: "image/jpeg", data: base64Image } }
                ]
            }];

            const generationConfig: any = {
                maxOutputTokens: 8192 // Standard max for older models, verifying behavior
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

        if (result.success) {
            console.log(`  [SUCCESS] Status: 200, Time: ${result.duration}ms`);
            const data = result.data;
            const candidate = data.candidates?.[0];
            
            if (candidate?.finishReason) {
                console.log(`  FinishReason: ${candidate.finishReason}`);
            }

            let foundData = false;
            let totalLen = 0;
            candidate?.content?.parts?.forEach((p: any) => {
                if (p.text) {
                    totalLen += p.text.length;
                    foundData = true;
                }
            });
            console.log(`  Total Text Length: ${totalLen} chars`);
            if (totalLen > 0 && candidate.finishReason === "MAX_TOKENS") {
                console.warn("  -> Output Truncated.");
            }

        } else {
            console.error(`  [FAILED] Status: ${result.status}`);
            console.error(`  Error: ${result.text || result.error}`);
        }
    }
    console.log("\n--- EXPERIMENTS COMPLETE ---\n");
});
