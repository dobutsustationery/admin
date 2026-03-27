import { describe, expect, it } from "vitest";
import { rootReducer, toTimestampMs } from "$lib/root-reducer";
import { update_field } from "$lib/inventory";
import {
  create_listing,
  update_listing,
  type Listing,
} from "$lib/listings-slice";
import { replace_shopify_sync_events } from "$lib/shopify-sync-slice";

describe("Root reducer timestamp normalization", () => {
  it("converts timestamp objects with millisecond precision from nanoseconds", () => {
    expect(
      toTimestampMs({ seconds: 1770000000, nanoseconds: 123_000_000 }),
    ).toBe(1770000000123);
    expect(
      toTimestampMs({ _seconds: 1770000000, _nanoseconds: 456_000_000 }),
    ).toBe(1770000000456);
  });

  it("preserves millisecond precision from createdAt nanoseconds", () => {
    let state = rootReducer(undefined, { type: "@@INIT" });

    const createdAtFirst = { seconds: 1770000000, nanoseconds: 123_000_000 };
    const createdAtSecond = { seconds: 1770000001, nanoseconds: 456_000_000 };

    state = rootReducer(state, {
      ...update_field({
        id: "123A",
        field: "description",
        from: "",
        to: "x",
      }),
      createdAt: createdAtFirst,
    } as any);

    state = rootReducer(state, {
      ...update_field({
        id: "123 A",
        field: "description",
        from: "",
        to: "y",
      }),
      createdAt: createdAtSecond,
    } as any);

    const collision = state.keyAudit.canonicalCollisions["123A"];
    expect(collision).toBeDefined();
    expect(collision.lastSeenAtMs).toBe(createdAtSecond.seconds * 1000 + 456);
  });

  it("does not move listing.lastUpdated backwards when older actions replay after sync completion", () => {
    let state = rootReducer(undefined, { type: "@@INIT" });

    const listing: Listing = {
      handle: "furukawa-mini-washi-paper-letter-set",
      title: "Furukawa Mini Washi Paper Letter Set",
      bodyHtml: "",
      productCategory: "Stationery",
      productType: "",
      vendor: "SPNSS Ltd.",
      tags: [],
      status: "active",
      option1Name: "Subtype",
      images: [],
      lastUpdated: 1774471922021,
    };

    state = rootReducer(state, create_listing({ listing }));

    state = rootReducer(
      state,
      replace_shopify_sync_events([
        {
          id: "result-1",
          eventType: "shopify/sync_completed",
          handle: listing.handle,
          requestId: "listing-sync-1",
          timestamp: {
            seconds: 1774472106,
            nanoseconds: 36_000_000,
          },
          createdAtMs: 1774472105859,
        },
      ]) as any,
    );

    expect(state.listings.handleToListing[listing.handle].lastUpdated).toBe(
      1774472106036,
    );

    state = rootReducer(state, {
      ...update_listing({
        handle: listing.handle,
        changes: { title: "Older replayed title" },
      }),
      _timestamp: 1774471922021,
    } as any);

    expect(state.listings.handleToListing[listing.handle].lastUpdated).toBe(
      1774472106036,
    );
  });
});
