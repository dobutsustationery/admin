import { describe, expect, it } from "vitest";
import { rootReducer as _rootReducer } from "../../src/lib/root-reducer";
// Fixtures omit the per-action timestamp that every replayed action
// carries in production; stamp one (deriveCreationTimestampMs fails
// loudly on a missing timestamp).
const rootReducer = (s: any, a: any) =>
  _rootReducer(
    s,
    a && typeof a === "object" && a.type && !("timestamp" in a)
      ? { ...a, timestamp: { _seconds: 1_700_000_000, _nanoseconds: 0 } }
      : a,
  );
import {
  append_raw_rows,
  import_batch,
  set_header,
  start_session,
} from "../../src/lib/shopify-import-slice";

const HEADER =
  "Handle,Title,Body (HTML),Vendor,Standard Product Type,Custom Product Type,Tags,Published,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Option3 Name,Option3 Value,Variant SKU,Variant Grams,Variant Inventory Tracker,Variant Inventory Qty,Variant Inventory Policy,Variant Fulfillment Service,Variant Price,Variant Compare At Price,Variant Requires Shipping,Variant Taxable,Image Src,Image Position,Image Alt Text,Gift Card,SEO Title,SEO Description,Google Shopping / Google Product Category,Google Shopping / Gender,Google Shopping / Age Group,Google Shopping / MPN,Google Shopping / AdWords Grouping,Google Shopping / AdWords Labels,Google Shopping / Condition,Google Shopping / Custom Product,Google Shopping / Custom Label 0,Google Shopping / Custom Label 1,Google Shopping / Custom Label 2,Google Shopping / Custom Label 3,Google Shopping / Custom Label 4,Variant Image,Variant Weight Unit,Variant Tax Code,Cost per item,Price / International,Compare At Price / International,Status";

const headers = HEADER.split(",");

function row(data: Record<string, string>) {
  const encode = (value: string) => {
    const v = String(value || "");
    if (/[",\n\r]/.test(v)) {
      return `"${v.replace(/"/g, '""')}"`;
    }
    return v;
  };
  return headers.map((h) => encode(data[h] || "")).join(",");
}

describe("Shopify import image linking", () => {
  it("keeps variant images while preserving listing images from the same CSV fragment", () => {
    const handle = "amifa-animal-family-flake-stickers-4542804108606";
    const rows = [
      row({
        Handle: handle,
        Title: "Amifa Animal Family Flake Stickers Cute Kawaii (40)",
        "Body (HTML)": "<p>Available in: Bear, Rabbit and Cat families</p>",
        "Option1 Name": "Subtype",
        "Option1 Value": "Bear",
        "Variant SKU": "4542804108606Bear",
        "Variant Grams": "10.1",
        "Variant Inventory Qty": "14",
        "Variant Price": "4.00",
        "Image Src":
          "https://cdn.shopify.com/s/files/1/files/IMG_5186_502f921f-3591-4743-a544-1b6f36ebdff4.png?v=1759222577",
        "Image Position": "1",
        "Image Alt Text": "Amifa Family Stickers House Pack Bear",
        "Variant Image":
          "https://cdn.shopify.com/s/files/1/files/IMG_5186_083da038-af51-4180-868e-801af39b382e.png?v=1759222579",
      }),
      row({
        Handle: handle,
        "Option1 Value": "Rabbit",
        "Variant SKU": "4542804108606Rabbit",
        "Variant Grams": "10.1",
        "Variant Inventory Qty": "12",
        "Variant Price": "4.00",
        "Image Src":
          "https://cdn.shopify.com/s/files/1/files/IMG_5186_083da038-af51-4180-868e-801af39b382e.png?v=1759222579",
        "Image Position": "2",
        "Variant Image":
          "https://cdn.shopify.com/s/files/1/files/IMG_5188_729d1526-9f2d-4a5b-ba26-b9d50a35f552.png?v=1759222577",
      }),
      row({
        Handle: handle,
        "Option1 Value": "Cat",
        "Variant SKU": "4542804108606Cat",
        "Variant Grams": "10.1",
        "Variant Inventory Qty": "12",
        "Variant Price": "4.00",
        "Image Src":
          "https://cdn.shopify.com/s/files/1/files/IMG_5187_99351e0b-fde2-4942-9947-6556175931f8.png?v=1759222577",
        "Image Position": "3",
        "Variant Image":
          "https://cdn.shopify.com/s/files/1/files/IMG_5190_b8b49ed3-cc21-456b-87f7-25870d3d0e73.png?v=1759222577",
      }),
      row({
        Handle: handle,
        "Image Src":
          "https://cdn.shopify.com/s/files/1/files/IMG_5188.png?v=1759222577",
        "Image Position": "4",
      }),
      row({
        Handle: handle,
        "Image Src":
          "https://cdn.shopify.com/s/files/1/files/IMG_5188_729d1526-9f2d-4a5b-ba26-b9d50a35f552.png?v=1759222577",
        "Image Position": "5",
      }),
      row({
        Handle: handle,
        "Image Src":
          "https://cdn.shopify.com/s/files/1/files/IMG_5189_f8d57323-db48-47ed-9e89-eb1142f2eabc.png?v=1759222577",
        "Image Position": "6",
      }),
      row({
        Handle: handle,
        "Image Src":
          "https://cdn.shopify.com/s/files/1/files/IMG_5190.png?v=1759222577",
        "Image Position": "7",
      }),
      row({
        Handle: handle,
        "Image Src":
          "https://cdn.shopify.com/s/files/1/files/IMG_5190_b8b49ed3-cc21-456b-87f7-25870d3d0e73.png?v=1759222577",
        "Image Position": "8",
      }),
      row({
        Handle: handle,
        "Image Src":
          "https://cdn.shopify.com/s/files/1/files/IMG_5191_c03b545b-3a65-47fe-bfc6-808c3bbf7136.png?v=1759222577",
        "Image Position": "9",
      }),
    ];

    let state: any = rootReducer(undefined, { type: "@@INIT" });
    state = rootReducer(state, start_session({ id: "file-1", name: "x.csv" }));
    state = rootReducer(state, set_header(HEADER));
    state = rootReducer(
      state,
      append_raw_rows({
        rawRows: rows,
        done: true,
      }),
    );
    state = rootReducer(
      state,
      import_batch({
        filter: "NEW",
        options: {
          useShopifyImages: true,
          useShopifyDescription: true,
          useShopifyHandles: true,
          useShopifyWeights: true,
          ignoreShopifyQty: false,
        },
      }),
    );

    const listing = state.listings.handleToListing[handle];
    expect(listing).toBeDefined();

    const listingUrls = listing.images.map((img: any) => img.url);
    expect(listingUrls).toHaveLength(6);
    expect(new Set(listingUrls).size).toBe(6);
    expect(listingUrls).toEqual(
      expect.arrayContaining([
        "https://cdn.shopify.com/s/files/1/files/IMG_5186_502f921f-3591-4743-a544-1b6f36ebdff4.png?v=1759222577",
        "https://cdn.shopify.com/s/files/1/files/IMG_5187_99351e0b-fde2-4942-9947-6556175931f8.png?v=1759222577",
        "https://cdn.shopify.com/s/files/1/files/IMG_5188.png?v=1759222577",
        "https://cdn.shopify.com/s/files/1/files/IMG_5189_f8d57323-db48-47ed-9e89-eb1142f2eabc.png?v=1759222577",
        "https://cdn.shopify.com/s/files/1/files/IMG_5190.png?v=1759222577",
        "https://cdn.shopify.com/s/files/1/files/IMG_5191_c03b545b-3a65-47fe-bfc6-808c3bbf7136.png?v=1759222577",
      ]),
    );

    expect(state.inventory.idToItem["4542804108606Bear"].image).toBe(
      "https://cdn.shopify.com/s/files/1/files/IMG_5186_083da038-af51-4180-868e-801af39b382e.png?v=1759222579",
    );
    expect(state.inventory.idToItem["4542804108606Rabbit"].image).toBe(
      "https://cdn.shopify.com/s/files/1/files/IMG_5188_729d1526-9f2d-4a5b-ba26-b9d50a35f552.png?v=1759222577",
    );
    expect(state.inventory.idToItem["4542804108606Cat"].image).toBe(
      "https://cdn.shopify.com/s/files/1/files/IMG_5190_b8b49ed3-cc21-456b-87f7-25870d3d0e73.png?v=1759222577",
    );
  });
});
