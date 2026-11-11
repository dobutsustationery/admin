import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  { createImagePreparer } = require("../../functions/shared/amazon-images.cjs");
const sharp = createRequire(process.cwd() + "/functions/package.json")("sharp");
function fixture(input: Buffer) {
  const files = new Map<string, { data: Buffer; options: any }>();
  let downloads = 0;
  const bucket = {
    name: "test-amazon-images",
    file: (name: string) => ({
      exists: async () => [files.has(name)],
      save: async (data: Buffer, options: any) => {
        files.set(name, { data, options });
      },
    }),
  };
  return {
    files,
    downloads: () => downloads,
    prepare: createImagePreparer({
      bucket,
      fetchImage: async () => {
        downloads++;
        return { ok: true, arrayBuffer: async () => input };
      },
    }),
  };
}
describe("Amazon image delivery copies", () => {
  it("sends a smaller JPEG, records the original URL and reuses the cached copy", async () => {
    const input = await sharp({
      create: {
        width: 3000,
        height: 2400,
        channels: 4,
        background: "#ff000080",
      },
    })
      .png()
      .toBuffer();
    const f = fixture(input),
      entry = {
        method: "PATCH",
        body: {
          patches: [
            {
              op: "replace",
              path: "/attributes/main_product_image_locator",
              value: [{ media_location: "https://example.com/source.png" }],
            },
          ],
        },
      };
    const out = await f.prepare(entry),
      stored = [...f.files.values()][0];
    expect(out.imageSources.main_product_image_locator[0].media_location).toBe(
      "https://example.com/source.png",
    );
    expect(out.body.patches[0].value[0].media_location).toMatch(
      /^https:\/\/storage.googleapis.com\/test-amazon-images\/amazon-images\/v1\/.*\.jpg$/,
    );
    const metadata = await sharp(stored.data).metadata();
    expect(metadata).toMatchObject({
      format: "jpeg",
      width: 2048,
      height: 1638,
    });
    expect(entry.body.patches[0].value[0].media_location).toBe(
      "https://example.com/source.png",
    );
    await f.prepare(entry);
    expect(f.downloads()).toBe(1);
  });
  it("never enlarges a smaller original", async () => {
    const f = fixture(
      await sharp({
        create: { width: 640, height: 480, channels: 3, background: "white" },
      })
        .png()
        .toBuffer(),
    );
    await f.prepare({
      method: "PUT",
      syncIssue: "presence",
      body: {
        attributes: {
          main_product_image_locator: [
            { media_location: "https://example.com/small.png" },
          ],
        },
      },
    });
    expect(await sharp([...f.files.values()][0].data).metadata()).toMatchObject(
      { width: 640, height: 480 },
    );
  });
  it("leaves quantity-only changes and unchanged images on category updates alone", async () => {
    const f = fixture(Buffer.from("unused"));
    for (const e of [
      {
        method: "PATCH",
        body: {
          patches: [
            {
              op: "replace",
              path: "/attributes/fulfillment_availability",
              value: [{ quantity: 4 }],
            },
          ],
        },
      },
      {
        method: "PUT",
        updateExisting: true,
        syncIssue: "category",
        syncPatches: [
          {
            op: "replace",
            path: "/attributes/model_number",
            value: [{ value: "sku" }],
          },
        ],
        body: {
          attributes: {
            main_product_image_locator: [
              { media_location: "https://m.media-amazon.com/image.jpg" },
            ],
          },
        },
      },
    ])
      expect(await f.prepare(e)).toBe(e);
    expect(f.downloads()).toBe(0);
    expect(f.files.size).toBe(0);
  });
  it("changes only requested image fields on a merged category update", async () => {
    const f = fixture(
      await sharp({
        create: { width: 100, height: 100, channels: 3, background: "white" },
      })
        .png()
        .toBuffer(),
    );
    const image = [{ media_location: "https://example.com/new.png" }],
      e = {
        method: "PUT",
        updateExisting: true,
        syncIssue: "all",
        syncPatches: [
          {
            op: "replace",
            path: "/attributes/other_product_image_locator_1",
            value: image,
          },
        ],
        body: {
          attributes: {
            main_product_image_locator: [
              { media_location: "https://m.media-amazon.com/keep.jpg" },
            ],
            other_product_image_locator_1: image,
          },
        },
      };
    const out = await f.prepare(e);
    expect(out.body.attributes.main_product_image_locator).toEqual(
      e.body.attributes.main_product_image_locator,
    );
    expect(out.syncPatches[0].value).toEqual(
      out.body.attributes.other_product_image_locator_1,
    );
    expect(out.imageSources.other_product_image_locator_1).toEqual(image);
    expect(f.downloads()).toBe(1);
  });
});
