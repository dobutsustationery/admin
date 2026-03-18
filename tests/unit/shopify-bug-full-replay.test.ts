import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { rootReducer } from "$lib/root-reducer";

function trim(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function isShopifyUrl(v: unknown): boolean {
  return trim(v).includes("cdn.shopify.com");
}

function canonicalize(url: string): string {
  const value = trim(url);
  if (!value) return "";
  try {
    const u = new URL(value);
    u.pathname = u.pathname.replace(/\/{2,}/g, "/");
    return u.toString();
  } catch {
    return value;
  }
}

describe("Replay Shopify Full Bug Log", () => {
  it.skip("inspects remaining Shopify URLs after full replay", () => {
    const path = join(process.cwd(), "test-data", "shopify-bug-full.jsonl");
    const lines = readFileSync(path, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const uploadedSourceUrls = new Set<string>();
    let state: any = rootReducer(undefined, { type: "@@INIT" });

    for (const line of lines) {
      const action = JSON.parse(line);
      if (action.type === "photos/shopify_cdn_uploaded") {
        const sourceBaseUrl = trim(action?.payload?.sourceBaseUrl);
        const sourceUrl = trim(action?.payload?.sourceUrl);
        if (sourceBaseUrl) uploadedSourceUrls.add(canonicalize(sourceBaseUrl));
        if (sourceUrl) uploadedSourceUrls.add(canonicalize(sourceUrl));
      }
      state = rootReducer(state, action);
    }

    const remainingInventory = Object.values(state.inventory?.idToItem || {})
      .map((item: any) => trim(item?.image))
      .filter((url) => isShopifyUrl(url));

    const remainingListings = Object.values(
      state.listings?.handleToListing || {},
    )
      .flatMap((listing: any) =>
        (listing?.images || []).map((img: any) => trim(img?.url)),
      )
      .filter((url) => isShopifyUrl(url));

    const remaining = Array.from(
      new Set([...remainingInventory, ...remainingListings].map(canonicalize)),
    );
    const coveredByUploaded = remaining.filter((u) =>
      uploadedSourceUrls.has(u),
    );
    const missingUploaded = remaining.filter((u) => !uploadedSourceUrls.has(u));

    console.log("[shopify-bug-full] remaining shopify urls", remaining.length);
    console.log(
      "[shopify-bug-full] remaining covered by shopify_cdn_uploaded",
      coveredByUploaded.length,
    );
    console.log(
      "[shopify-bug-full] remaining without shopify_cdn_uploaded",
      missingUploaded.length,
    );
    console.log(
      "[shopify-bug-full] sample missing",
      missingUploaded.slice(0, 20),
    );

    expect(remaining.length).toBe(0);
  });
});
