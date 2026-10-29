import { afterEach, describe, expect, it, vi } from "vitest";
const {
  createWorker,
} = require("../../functions/shared/etsy-listing-sync.cjs");

describe("Etsy listing worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("writes only inventory for stock sync, verifies readback, and ignores duplicate triggers", async () => {
    const docs = new Map<string, any>();
    const db = {
      collection: (name: string) => ({
        doc: (id: string) => {
          const key = `${name}/${id}`;
          return {
            get: async () => ({ data: () => docs.get(key) }),
            create: async (value: any) => {
              if (docs.has(key))
                throw Object.assign(Error("exists"), { code: 6 });
              docs.set(key, value);
            },
            set: async (value: any, options: any) => {
              docs.set(
                key,
                options?.merge ? { ...docs.get(key), ...value } : value,
              );
            },
          };
        },
      }),
    };
    const source = {
      products: [
        {
          product_id: 11,
          sku: "123",
          property_values: [
            {
              property_id: 513,
              property_name: "Title",
              scale_id: null,
              scale_name: null,
              value_ids: [64189375554],
              values: ["Regular"],
            },
          ],
          offerings: [
            {
              price: { amount: 450, divisor: 100 },
              quantity: 8,
              is_enabled: true,
              readiness_state_id: 77,
            },
          ],
        },
      ],
      quantity_on_property: [],
      price_on_property: [],
      sku_on_property: [],
    };
    let updated = false;
    const fetchMock = vi.fn(async (url: string, options: any) => {
      if (options.method === "PUT") {
        expect(url).toContain("/listings/100/inventory");
        const body = JSON.parse(options.body);
        if (
          body.products.some((p: any) =>
            p.property_values.some(
              (v: any) => typeof v.property_name !== "string",
            ),
          )
        ) {
          return new Response(
            JSON.stringify({
              error: "Expected string value for 'property_name' (got NULL).",
            }),
            { status: 400 },
          );
        }
        expect(body.products[0].property_values).toEqual([
          {
            property_id: 513,
            property_name: "Title",
            value_ids: [64189375554],
            values: ["Regular"],
          },
        ]);
        expect(body.products[0].offerings[0]).toEqual({
          price: 4.5,
          quantity: 3,
          is_enabled: true,
          readiness_state_id: 77,
        });
        updated = true;
      }
      const value = url.includes("/inventory")
        ? {
            ...source,
            products: source.products.map((p) => ({
              ...p,
              offerings: p.offerings.map((o) => ({
                ...o,
                quantity: updated ? 3 : 8,
              })),
            })),
          }
        : {
            listing_id: 100,
            shop_id: 1,
            title: "Product",
            description: "Text",
            state: "active",
            price: { currency_code: "EUR" },
            images: [],
          };
      return new Response(JSON.stringify(value), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const worker = createWorker({
      db,
      getConfig: () => ({ shopId: "1", apiKey: "key", accessToken: "token" }),
      delay: async () => {},
      now: () => 10,
    });
    const request = {
      creator: "user",
      mode: "sync",
      field: "quantity",
      entries: [
        {
          listingId: "100",
          targets: [
            {
              productId: "11",
              sku: "123",
              beforeQuantity: 8,
              beforePrice: 4.5,
              value: 3,
            },
          ],
        },
      ],
    };
    await worker.run("request", request);
    await worker.run("request", request);
    expect(
      fetchMock.mock.calls.filter(([, o]) => o.method === "PUT"),
    ).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([u]) => u.includes("/images"))).toBe(
      false,
    );
    expect(docs.get("etsy_listing_results/request").results[0].success).toBe(
      true,
    );
    expect(
      docs.get("etsy_listing_catalog/100").inventory.products[0].offerings[0]
        .quantity,
    ).toBe(3);
  });
});
