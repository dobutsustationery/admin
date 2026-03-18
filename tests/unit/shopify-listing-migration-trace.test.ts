import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { rootReducer } from "$lib/root-reducer";

const TARGET_HANDLE = "uni-kuru-toga-0-5mm-mechanical-pencil";

function trim(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function isShopifyUrl(raw: string): boolean {
  return raw.toLowerCase().includes("cdn.shopify.com");
}

function toIdentity(raw: string): string {
  const value = trim(raw);
  if (!value) return "";
  try {
    const u = new URL(value);
    if (!u.hostname.toLowerCase().includes("cdn.shopify.com")) return "";
    u.pathname = u.pathname.replace(/\/{2,}/g, "/");
    u.pathname = u.pathname.replace(
      /^(\/s\/files\/(?:[^/]+\/){4})deleted\/files\//i,
      "$1files/",
    );
    return u.toString();
  } catch {
    return "";
  }
}

function getListingIdentityMap(
  state: any,
  handle: string,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const listing = state?.listings?.handleToListing?.[handle];
  const images = Array.isArray(listing?.images) ? listing.images : [];
  for (const img of images) {
    const raw = trim((img as any)?.url);
    if (!raw || !isShopifyUrl(raw)) continue;
    const identity = toIdentity(raw);
    if (!identity) continue;
    const set = map.get(identity) || new Set<string>();
    set.add(raw);
    map.set(identity, set);
  }
  return map;
}

describe("Shopify Migration Trace For Specific Listing (@diagnostic)", () => {
  it("analyzes each unresolved Shopify URL for a single listing", () => {
    const path = join(process.cwd(), "test-data", "shopify-bug-full.jsonl");
    const lines = readFileSync(path, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const completionByIdentity = new Map<
      string,
      Array<{
        index: number;
        actionType: string;
        requestId: string;
        sourceUrl: string;
        sourceBaseUrl: string;
        permanentUrl: string;
      }>
    >();

    for (let i = 0; i < lines.length; i += 1) {
      const action = JSON.parse(lines[i]);
      if (action?.type !== "photos/shopify_cdn_uploaded") continue;
      const sourceUrl = trim(action?.payload?.sourceUrl);
      const sourceBaseUrl = trim(action?.payload?.sourceBaseUrl);
      const identity = toIdentity(sourceBaseUrl || sourceUrl);
      if (!identity) continue;
      const arr = completionByIdentity.get(identity) || [];
      arr.push({
        index: i,
        actionType: action.type,
        requestId: trim(action?.payload?.requestId),
        sourceUrl,
        sourceBaseUrl,
        permanentUrl: trim(action?.payload?.permanentUrl),
      });
      completionByIdentity.set(identity, arr);
    }

    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};

    let state: any = rootReducer(undefined, { type: "@@INIT" });
    let prevMap = getListingIdentityMap(state, TARGET_HANDLE);

    const lifecycleByIdentity = new Map<
      string,
      {
        rawUrls: Set<string>;
        firstSeenIndex: number | null;
        lastSeenIndex: number | null;
        addEvents: Array<{ index: number; actionType: string }>;
        removeEvents: Array<{ index: number; actionType: string }>;
      }
    >();

    try {
      for (let i = 0; i < lines.length; i += 1) {
        const action = JSON.parse(lines[i]);
        const next = rootReducer(state, action);
        const currentMap = getListingIdentityMap(next, TARGET_HANDLE);

        for (const [identity, rawSet] of currentMap.entries()) {
          const rec = lifecycleByIdentity.get(identity) || {
            rawUrls: new Set<string>(),
            firstSeenIndex: null,
            lastSeenIndex: null,
            addEvents: [],
            removeEvents: [],
          };
          rawSet.forEach((u) => rec.rawUrls.add(u));
          if (rec.firstSeenIndex == null) rec.firstSeenIndex = i;
          rec.lastSeenIndex = i;
          lifecycleByIdentity.set(identity, rec);
        }

        const prevIds = new Set(prevMap.keys());
        const curIds = new Set(currentMap.keys());

        for (const identity of curIds) {
          if (prevIds.has(identity)) continue;
          const rec = lifecycleByIdentity.get(identity)!;
          rec.addEvents.push({
            index: i,
            actionType: String(action?.type || ""),
          });
        }

        for (const identity of prevIds) {
          if (curIds.has(identity)) continue;
          const rec = lifecycleByIdentity.get(identity) || {
            rawUrls: new Set<string>(),
            firstSeenIndex: null,
            lastSeenIndex: null,
            addEvents: [],
            removeEvents: [],
          };
          rec.removeEvents.push({
            index: i,
            actionType: String(action?.type || ""),
          });
          lifecycleByIdentity.set(identity, rec);
        }

        state = next;
        prevMap = currentMap;
      }
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    const finalMap = getListingIdentityMap(state, TARGET_HANDLE);
    const unresolved = Array.from(finalMap.keys()).map((identity) => {
      const lifecycle = lifecycleByIdentity.get(identity);
      const completions = completionByIdentity.get(identity) || [];
      const firstSeen = lifecycle?.firstSeenIndex ?? null;
      const lastSeen = lifecycle?.lastSeenIndex ?? null;
      const lastAdd = lifecycle?.addEvents.at(-1)?.index ?? null;
      const lastAddType = lifecycle?.addEvents.at(-1)?.actionType || "";
      const lastCompletion = completions.at(-1)?.index ?? null;
      const firstCompletion = completions[0]?.index ?? null;

      let diagnosis = "unknown";
      if (completions.length === 0) {
        diagnosis = "no_completion_for_identity";
      } else if (firstSeen != null && (lastCompletion ?? -1) < firstSeen) {
        diagnosis = "completion_happened_before_image_added_to_listing";
      } else if (
        lastAdd != null &&
        lastCompletion != null &&
        lastAdd > lastCompletion
      ) {
        diagnosis = "image_reintroduced_after_last_completion";
      } else {
        diagnosis = "completion_exists_but_url_still_present";
      }

      return {
        identity,
        rawUrls: Array.from(lifecycle?.rawUrls || []),
        firstSeen,
        lastSeen,
        firstCompletion,
        lastCompletion,
        completionCount: completions.length,
        lastAdd,
        lastAddType,
        lastCompletionRequestId: completions.at(-1)?.requestId || "",
        diagnosis,
      };
    });

    console.info("[shopify-listing-trace] handle", TARGET_HANDLE);
    console.info(
      "[shopify-listing-trace] finalListingImageCount",
      Array.isArray(state?.listings?.handleToListing?.[TARGET_HANDLE]?.images)
        ? state.listings.handleToListing[TARGET_HANDLE].images.length
        : 0,
    );
    console.info("[shopify-listing-trace] unresolvedCount", unresolved.length);
    console.info("[shopify-listing-trace] unresolvedDetails", unresolved);

    expect(state?.listings?.handleToListing?.[TARGET_HANDLE]).toBeTruthy();
  });
});
