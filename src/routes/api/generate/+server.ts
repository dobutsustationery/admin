import { json } from "@sveltejs/kit";
import { processMediaItems } from "$lib/gemini";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
    try {
        const { items, accessToken } = await request.json();

        if (!items || !Array.isArray(items)) {
            return json({ error: "Invalid items provided" }, { status: 400 });
        }
        if (!accessToken) {
            return json({ error: "Access token required" }, { status: 401 });
        }

        // Process the items
        // Note: This operation can take a while.
        const results = await processMediaItems(items, accessToken);

        return json({ results });
    } catch (e: any) {
        console.error("API Error generating descriptions:", e);
        return json({ error: e.message || "Internal Server Error" }, { status: 500 });
    }
};
