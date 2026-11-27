import { afterEach, describe, expect, it, vi } from "vitest";
const core = require("../../functions/shared/shopify-sync-core.cjs");

const drive = (id: string) => `https://lh3.googleusercontent.com/d/${id}=s0`;
const cdn = (id: string) =>
  `https://cdn.shopify.com/s/files/1/123/files/${id}_s1600_12345678-abcd.png?v=1`;
const config = {
  storeUrl: "test.myshopify.com",
  apiVersion: "2026-01",
  accessToken: "test-token",
};
const sourceA = "drive-file-A_12345";
const sourceB = "drive-file-B-12345";
function setup(images: any[], variants: any[] = []) {
  const product: any = {
    id: 1,
    handle: "example",
    images: structuredClone(images),
    variants: structuredClone(variants),
  };
  const writes: any[] = [];
  let nextId = 100;
  let failUploads = false;
  const fetchMock = vi.fn(async (url: string, options: any = {}) => {
    const method = options.method || "GET";
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : {};
    if (method === "GET" && path.endsWith("/products/1.json")) {
      return { ok: true, json: async () => structuredClone({ product }) };
    }
    if (path.endsWith("/graphql.json")) {
      return {
        ok: true,
        json: async () => ({
          data: {
            productByHandle: {
              id: "gid://shopify/Product/1",
              handle: "example",
              status: "ACTIVE",
              variants: {
                nodes: product.variants.map((v: any) => ({
                  id: `gid://shopify/ProductVariant/${v.id}`,
                  sku: v.sku,
                })),
              },
            },
          },
        }),
      };
    }
    writes.push({ method, path, body });
    if (method === "PUT" && path.endsWith("/products/1.json")) {
      const variants = body.product.variants.map((v: any) => ({
        ...product.variants.find((old: any) => old.sku === v.sku),
        ...v,
      }));
      Object.assign(product, body.product, { variants });
      return { ok: true, json: async () => structuredClone({ product }) };
    }
    if (method === "POST" && path.endsWith("/images.json")) {
      if (failUploads)
        return {
          ok: false,
          status: 500,
          json: async () => ({ errors: "Upload failed" }),
        };
      const image = { ...body.image, id: nextId++, variant_ids: [] };
      product.images.push(image);
      return {
        ok: true,
        json: async () => ({ image: structuredClone(image) }),
      };
    }
    const imageMatch = /\/images\/(\d+)\.json$/.exec(path);
    if (imageMatch && method === "DELETE") {
      product.images = product.images.filter(
        (i: any) => i.id !== Number(imageMatch[1]),
      );
      product.images.forEach((i: any, index: number) => {
        i.position = index + 1;
      });
      return { ok: true, json: async () => ({}) };
    }
    if (imageMatch && method === "PUT") {
      const index = product.images.findIndex(
        (i: any) => i.id === Number(imageMatch[1]),
      );
      const image = { ...product.images[index], ...body.image };
      product.images.splice(index, 1);
      product.images.splice((body.image.position || index + 1) - 1, 0, image);
      product.images.forEach((i: any, idx: number) => {
        i.position = idx + 1;
      });
      return {
        ok: true,
        json: async () => ({ image: structuredClone(image) }),
      };
    }
    const variantMatch = /\/variants\/(\d+)\.json$/.exec(path);
    if (variantMatch && method === "PUT") {
      const variant = product.variants.find(
        (v: any) => v.id === Number(variantMatch[1]),
      );
      Object.assign(variant, body.variant);
      return {
        ok: true,
        json: async () => ({ variant: structuredClone(variant) }),
      };
    }
    throw Error(`Unexpected request ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    product,
    writes,
    failUploads: () => {
      failUploads = true;
    },
  };
}
const image = (
  id: number,
  file: string,
  alt: string,
  position: number,
  variant_ids: number[] = [],
) => ({ id, src: cdn(file), alt, position, variant_ids });
const request = (images: any[], variants: any[] = []) => ({
  handle: "example",
  listing: { title: "Example", images },
  variants,
});
const gallery = (file: string, alt: string, position: number) => ({
  url: drive(file),
  altText: alt,
  position,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Shopify image reconciliation", () => {
  it("performs complete product syncs without submitting or rewriting unchanged images", async () => {
    const s = setup(
      [image(10, sourceA, "A", 1, [20])],
      [{ id: 20, sku: "123", position: 1, image_id: 10 }],
    );
    const req = request(
      [gallery(sourceA, "A", 1)],
      [{ sku: "123", subtype: "A", image: drive(sourceA) }],
    );
    await core.upsertProductFromRequest(config, req);
    await core.upsertProductFromRequest(config, req);
    expect(s.writes).toHaveLength(2);
    for (const write of s.writes) {
      expect(write.path).toBe("/admin/api/2026-01/products/1.json");
      expect(write.body.product).not.toHaveProperty("images");
    }
    expect(s.product.images[0].id).toBe(10);
  });

  it("uploads a shared gallery and variant image only once on an empty product", async () => {
    const s = setup([], [{ id: 20, sku: "123", position: 1 }]);
    await core.reconcileVariantOrderAndImages(
      config,
      s.product,
      request(
        [gallery(sourceA, "A", 1)],
        [{ sku: "123", subtype: "A", image: drive(sourceA) }],
      ),
    );
    expect(s.writes.filter((w) => w.method === "POST")).toHaveLength(1);
    expect(s.product.images).toHaveLength(1);
    expect(s.product.variants[0].image_id).toBe(s.product.images[0].id);
  });

  it("omits image imports from product writes for both creates and updates", () => {
    const req = request([gallery(sourceA, "A", 1)], [{ sku: "123" }]);
    expect(core.buildProductPayload(req, null)).not.toHaveProperty("images");
    expect(
      core.buildProductPayload(req, { id: 1, variants: [] }),
    ).not.toHaveProperty("images");
  });

  it("reuses CDN images and variant links with zero image writes on repeated syncs", async () => {
    const s = setup(
      [image(10, sourceA, "A", 1, [20])],
      [{ id: 20, sku: "123", position: 1, image_id: 10 }],
    );
    const req = request(
      [gallery(sourceA, "A", 1)],
      [{ sku: "123", subtype: "A", image: drive(sourceA) }],
    );
    await core.reconcileVariantOrderAndImages(config, s.product, req);
    await core.reconcileVariantOrderAndImages(config, s.product, req);
    expect(s.writes).toEqual([]);
    expect(s.product.images[0].id).toBe(10);
  });

  it("uploads only missing images, removes obsolete images, and is then idempotent", async () => {
    const s = setup([
      image(10, sourceA, "A", 1),
      image(11, "obsolete-file-12345", "Old", 2),
    ]);
    const req = request([gallery(sourceA, "A", 1), gallery(sourceB, "B", 2)]);
    await core.reconcileProductGallery(config, 1, req);
    expect(s.writes.filter((w) => w.method === "POST")).toHaveLength(1);
    expect(s.writes.find((w) => w.method === "POST").body.image.src).toContain(
      sourceB,
    );
    expect(
      s.writes.filter((w) => w.method === "DELETE").map((w) => w.path),
    ).toEqual(["/admin/api/2026-01/products/1/images/11.json"]);
    expect(s.product.images.map((i: any) => i.id)).toEqual([10, 100]);
    s.writes.length = 0;
    await core.reconcileProductGallery(config, 1, req);
    expect(s.writes).toEqual([]);
  });

  it("reorders images and edits alt text without importing them again", async () => {
    const s = setup([
      image(10, sourceA, "A", 1),
      image(11, sourceB, "Old B", 2),
    ]);
    const req = request([gallery(sourceB, "B", 1), gallery(sourceA, "A", 2)]);
    await core.reconcileProductGallery(config, 1, req);
    expect(s.writes).toHaveLength(1);
    expect(s.writes[0]).toMatchObject({
      method: "PUT",
      body: { image: { id: 11, position: 1, alt: "B" } },
    });
    expect(s.product.images.map((i: any) => i.id)).toEqual([11, 10]);
    s.writes.length = 0;
    await core.reconcileProductGallery(config, 1, req);
    expect(s.writes).toEqual([]);
  });

  it("keeps the attached copy of a legacy duplicate and shares it across variants", async () => {
    const s = setup([
      image(10, sourceA, "A", 1),
      image(11, sourceA, "A", 2, [20]),
    ]);
    const result = await core.reconcileProductGallery(
      config,
      1,
      request(
        [gallery(sourceA, "A", 1)],
        [
          { sku: "123", image: drive(sourceA) },
          { sku: "456", image: drive(sourceA) },
        ],
      ),
    );
    expect(s.product.images.map((i: any) => i.id)).toEqual([11]);
    expect(result.variantImageIdBySku.get("123")).toBe(11);
    expect(result.variantImageIdBySku.get("456")).toBe(11);
    expect(s.writes.map((w) => w.method)).toEqual(["DELETE"]);
  });

  it("does not delete the existing gallery if a new image upload fails", async () => {
    const s = setup([image(10, sourceA, "A", 1)]);
    s.failUploads();
    await expect(
      core.reconcileProductGallery(
        config,
        1,
        request([gallery(sourceB, "B", 1)]),
      ),
    ).rejects.toThrow("Upload failed");
    expect(s.product.images.map((i: any) => i.id)).toEqual([10]);
    expect(s.writes.some((w) => w.method === "DELETE")).toBe(false);
  });

  it("matches exact external image URLs while ignoring cache query strings", async () => {
    const s = setup([
      {
        id: 10,
        src: "https://example.com/photo.jpg?v=2",
        alt: "A",
        position: 1,
      },
    ]);
    await core.reconcileProductGallery(
      config,
      1,
      request([
        { url: "https://example.com/photo.jpg?v=1", altText: "A", position: 1 },
      ]),
    );
    expect(s.writes).toEqual([]);
  });
});
