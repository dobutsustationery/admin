import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { rootReducer } from "$lib/root-reducer";

function trim(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
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

function countIdentityInState(state: any, identity: string): number {
  if (!identity) return 0;
  let count = 0;

  for (const item of Object.values(state.inventory?.idToItem || {})) {
    const image = trim((item as any)?.image);
    if (toIdentity(image) === identity) count += 1;
  }

  for (const listing of Object.values(state.listings?.handleToListing || {})) {
    const images = (listing as any)?.images || [];
    for (const img of images) {
      const url = trim((img as any)?.url);
      if (toIdentity(url) === identity) count += 1;
    }
  }

  return count;
}

function stringifyRewriteTargets(state: any): string {
  return JSON.stringify({
    inventory: {
      idToItem: state?.inventory?.idToItem || {},
    },
    listings: {
      handleToListing: state?.listings?.handleToListing || {},
    },
  });
}

describe("Shopify Migration Rewrite Effectiveness (@diagnostic)", () => {
  it("counts rewrite impact for each shopify_cdn completion", () => {
    const path = join(process.cwd(), "test-data", "shopify-bug-full.jsonl");
    const lines = readFileSync(path, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const originalLog = console.log;
    const originalWarn = console.warn;
    // Keep replay output readable; this reducer emits very noisy logs.
    console.log = () => {};
    console.warn = () => {};

    let state: any = rootReducer(undefined, { type: "@@INIT" });
    let completionCount = 0;
    let zeroRewriteCount = 0;
    let rewroteAtLeastOneCount = 0;
    let totalRewrittenRefs = 0;
    const topZeroRewrite: Array<{ requestId: string; sourceUrl: string }> = [];

    try {
      for (const line of lines) {
        const action = JSON.parse(line);

        if (action.type === "photos/shopify_cdn_uploaded") {
          const sourceBaseUrl = trim(action?.payload?.sourceBaseUrl);
          const sourceUrl = trim(action?.payload?.sourceUrl);
          const identity = toIdentity(sourceBaseUrl || sourceUrl);
          const beforeCount = countIdentityInState(state, identity);
          const next = rootReducer(state, action);
          const afterCount = countIdentityInState(next, identity);

          completionCount += 1;
          const rewritten = Math.max(0, beforeCount - afterCount);
          totalRewrittenRefs += rewritten;

          if (rewritten === 0) {
            zeroRewriteCount += 1;
            if (topZeroRewrite.length < 20) {
              topZeroRewrite.push({
                requestId: trim(action?.payload?.requestId),
                sourceUrl: sourceBaseUrl || sourceUrl,
              });
            }
          } else {
            rewroteAtLeastOneCount += 1;
          }

          state = next;
          continue;
        }

        state = rootReducer(state, action);
      }
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    const summary = {
      completionCount,
      rewroteAtLeastOneCount,
      zeroRewriteCount,
      totalRewrittenRefs,
      avgRewritesPerCompletion:
        completionCount > 0 ? totalRewrittenRefs / completionCount : 0,
    };

    console.info("[shopify-migration-diagnostic]", summary);
    console.info(
      "[shopify-migration-diagnostic] sample zero-rewrite completions:",
      topZeroRewrite,
    );

    expect(completionCount).toBeGreaterThan(0);
  });

  it("removes every rewritten source URL from state after each completion", () => {
    const path = join(process.cwd(), "test-data", "shopify-bug-full.jsonl");
    const lines = readFileSync(path, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};

    let state: any = rootReducer(undefined, { type: "@@INIT" });
    const leaked: Array<{
      requestId: string;
      matchedUrl: string;
      sourceUrl: string;
      sourceBaseUrl: string;
    }> = [];
    let completionCount = 0;
    let checkedCount = 0;

    try {
      for (const line of lines) {
        const action = JSON.parse(line);
        if (action.type !== "photos/shopify_cdn_uploaded") {
          state = rootReducer(state, action);
          continue;
        }

        completionCount += 1;
        const sourceUrl = trim(action?.payload?.sourceUrl);
        const sourceBaseUrl = trim(action?.payload?.sourceBaseUrl);
        const candidates = [sourceBaseUrl, sourceUrl].filter(Boolean);

        const before = stringifyRewriteTargets(state);
        const next = rootReducer(state, action);
        const after = stringifyRewriteTargets(next);

        for (const candidate of candidates) {
          if (!before.includes(candidate)) continue;
          checkedCount += 1;
          if (after.includes(candidate)) {
            leaked.push({
              requestId: trim(action?.payload?.requestId),
              matchedUrl: candidate,
              sourceUrl,
              sourceBaseUrl,
            });
            if (leaked.length >= 20) break;
          }
        }

        state = next;
      }
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    console.info(
      "[shopify-migration-diagnostic] completionCount",
      completionCount,
    );
    console.info("[shopify-migration-diagnostic] checkedCount", checkedCount);
    console.info("[shopify-migration-diagnostic] leakedSample", leaked);

    expect(completionCount).toBeGreaterThan(0);
    expect(checkedCount).toBeGreaterThan(0);
    expect(leaked).toEqual([]);
  });
});
