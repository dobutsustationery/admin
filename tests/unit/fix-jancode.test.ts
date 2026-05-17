import { describe, expect, it } from "vitest";
import { rootReducer as _rootReducer } from "$lib/root-reducer";
import {
  fix_jancode,
  new_order,
  package_item,
  update_field,
  update_item,
} from "$lib/inventory";
import { categorize_photo } from "$lib/photos-slice";
import { add_proposals_internal } from "$lib/listing-creation-slice";
import { resolve_conflict as resolveOrderConflict } from "$lib/order-import-slice";
import { resolve_conflict as resolveShopifyConflict } from "$lib/shopify-import-slice";

// Every replayed action carries a timestamp in production; these
// fixtures omit it, so stamp a fixed one (deriveCreationTimestampMs
// fails loudly on a missing timestamp).
const TS = { _seconds: 1_700_000_000, _nanoseconds: 0 };
const rootReducer = (s: any, a: any) =>
  _rootReducer(
    s,
    a && typeof a === "object" && a.type && !("timestamp" in a)
      ? { ...a, timestamp: TS }
      : a,
  );

describe("fix_jancode", () => {
  it("re-keys inventory and dependent references without requiring an order retype flow", () => {
    const oldJan = "1111111111111";
    const newJan = "2222222222222";
    const subtype = "Blue";
    const oldKey = `${oldJan}${subtype}`;
    const newKey = `${newJan}${subtype}`;

    let state: any = rootReducer(undefined, { type: "@@INIT" });

    state = rootReducer(
      state,
      update_item({
        id: oldKey,
        item: {
          janCode: oldJan,
          subtype,
          description: "Tea Pack",
          hsCode: "123456",
          image: "https://img.example/a.jpg",
          qty: 10,
          pieces: 1,
          shipped: 0,
          creationDate: "Jan 1, 2026",
          timestamp: 0,
        },
      }) as any,
    );

    state = rootReducer(
      state,
      update_field({
        id: oldKey,
        field: "handle",
        from: "",
        to: "tea-pack",
      }) as any,
    );

    state = rootReducer(
      state,
      new_order({
        orderID: "order-1",
        date: new Date("2026-01-15"),
        email: "test@example.com",
        product: "Test Order",
      }) as any,
    );
    state = rootReducer(
      state,
      package_item({
        orderID: "order-1",
        itemKey: oldKey as any,
        qty: 2,
      }) as any,
    );

    state = rootReducer(
      state,
      categorize_photo({
        janCode: `${oldJan}:${subtype}`,
        photo: {
          id: "photo-1",
          baseUrl: "https://lh3.googleusercontent.com/d/file1",
          productUrl: "",
          mimeType: "image/jpeg",
          filename: "photo-1.jpg",
          mediaMetadata: { creationTime: "", width: "1", height: "1" },
        },
      }) as any,
    );

    state = rootReducer(
      state,
      add_proposals_internal([
        {
          janCode: oldJan,
          inventoryItemIds: [oldKey],
          photoGroupIds: [oldJan, `${oldJan}:${subtype}`],
          title: "Tea Pack",
          bodyHtml: "<p>desc</p>",
          productCategory: "Food",
          vendor: "Vendor",
          tags: [],
          option1Name: "Color",
          variants: [
            {
              id: "v1",
              itemId: oldKey,
              option1Value: subtype,
              photoGroupKey: `${oldJan}:${subtype}`,
              qty: 10,
            },
          ],
          status: "draft",
        },
      ]) as any,
    );

    state = rootReducer(
      state,
      resolveOrderConflict({
        index: 0,
        resolution: {
          type: "data_mismatch",
          itemKey: oldKey,
          fieldResolutions: {},
        } as any,
      }) as any,
    );

    state = rootReducer(
      state,
      resolveShopifyConflict({
        index: 0,
        resolvedActions: [{ type: "noop", payload: { itemKey: oldKey } }],
      }) as any,
    );

    state = rootReducer(
      state,
      fix_jancode({
        itemKey: oldKey as any,
        newJanCode: newJan,
        mergeMode: "merge_if_identical",
      }) as any,
    );

    expect(state.inventory.idToItem[oldKey]).toBeUndefined();
    expect(state.inventory.idToItem[newKey]).toBeDefined();
    expect(state.inventory.idToItem[newKey].janCode).toBe(newJan);

    const orderItems = state.inventory.orderIdToOrder["order-1"].items;
    expect(orderItems.find((i: any) => i.itemKey === oldKey)).toBeUndefined();
    expect(orderItems.find((i: any) => i.itemKey === newKey)?.qty).toBe(2);

    expect(state.listings.idToHandle[oldKey]).toBeUndefined();
    expect(state.listings.idToHandle[newKey]).toBe("tea-pack");

    expect(
      state.photos.janCodeToPhotos[`${oldJan}:${subtype}`],
    ).toBeUndefined();
    expect(state.photos.janCodeToPhotos[`${newJan}:${subtype}`]).toBeDefined();

    expect(state.listingCreation.proposals[oldJan]).toBeUndefined();
    expect(state.listingCreation.proposals[newJan]).toBeDefined();
    expect(state.listingCreation.proposals[newJan].inventoryItemIds).toContain(
      newKey,
    );
    expect(state.listingCreation.proposals[newJan].variants[0].itemId).toBe(
      newKey,
    );
    expect(
      state.listingCreation.proposals[newJan].variants[0].photoGroupKey,
    ).toBe(`${newJan}:${subtype}`);

    expect(state.orderImport.resolutions[0].itemKey).toBe(newKey);
    expect(state.shopifyImport.resolutions[0][0].payload.itemKey).toBe(newKey);

    expect(state.keyAudit.ghostMap[oldKey]?.canonicalId).toBe(newKey);
  });
});
