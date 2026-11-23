import { afterEach, describe, expect, it, vi } from "vitest";
const {
  createWorker,
} = require("../../functions/shared/etsy-listing-sync.cjs");

describe("Etsy listing worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it.each(["stock", "zero", "rejected", "wrong_quantity"])(
    "syncs stock with replaced product IDs, reports progress and ignores duplicate triggers (%s)",
    async (scenario) => {
      const zeroStock = scenario === "zero";
      const rejected = scenario === "rejected";
      const wrongQuantity = scenario === "wrong_quantity";
      const failed = rejected || wrongQuantity;
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
      let deactivated = false;
      const fetchMock = vi.fn(async (url: string, options: any) => {
        if (options.method === "PATCH") {
          expect(zeroStock).toBe(true);
          expect(options.body).toBe("state=inactive");
          deactivated = true;
        }
        if (options.method === "PUT") {
          expect(zeroStock).toBe(false);
          if (rejected)
            return new Response(
              JSON.stringify({ error: "Test Etsy rejection" }),
              { status: 400 },
            );
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
                product_id: updated ? 99 : p.product_id,
                offerings: p.offerings.map((o) => ({
                  ...o,
                  quantity: updated && !wrongQuantity ? 3 : 8,
                })),
              })),
            }
          : {
              listing_id: 100,
              shop_id: 1,
              title: "Product",
              description: "Text",
              state: deactivated ? "inactive" : "active",
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
                value: zeroStock ? 0 : 3,
              },
            ],
          },
        ],
      };
      await worker.run("request", request);
      await worker.run("request", request);
      expect(
        fetchMock.mock.calls.filter(([, o]) => o.method === "PUT"),
      ).toHaveLength(zeroStock ? 0 : 1);
      expect(fetchMock.mock.calls.some(([u]) => u.includes("/images"))).toBe(
        false,
      );
      expect(docs.get("etsy_listing_results/request").results[0].success).toBe(
        !failed,
      );
      if (wrongQuantity)
        expect(docs.get("etsy_listing_results/request").results[0].error).toBe(
          "Update submitted for 123: requested quantity 3, but Etsy returned 8.",
        );
      if (!rejected) {
        expect(
          docs.get("etsy_listing_catalog/100").inventory.products[0]
            .offerings[0].quantity,
        ).toBe(zeroStock || failed ? 8 : 3);
        expect(docs.get("etsy_listing_catalog/100").state).toBe(
          zeroStock ? "inactive" : "active",
        );
      }
      expect(docs.get("sync/etsy-listings-request-requested").eventType).toBe(
        "etsy/sync_requested",
      );
      expect(docs.get("sync/etsy-listings-request-claimed").eventType).toBe(
        "etsy/sync_claimed",
      );
      expect(
        docs.get(
          `sync/etsy-listings-request-${failed ? "failed" : "completed"}`,
        ).payload.results[0].success,
      ).toBe(!failed);
    },
  );
});

describe("Etsy sales between refresh and sync", () => {
  afterEach(() => vi.unstubAllGlobals());
  async function runScenario(
    kind: "already_correct" | "mixed" | "conflict" | "uncertain_write",
  ) {
    const docs = new Map<string, any>();
    const db = {
      collection: (name: string) => ({
        doc: (id: string) => {
          const key = `${name}/${id}`;
          return {
            get: async () => ({ data: () => docs.get(key) }),
            create: async (value: any) => {
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
    const product = (id: number, sku: string, qty: number) => ({
      product_id: id,
      sku,
      property_values: [
        {
          property_id: 513,
          property_name: "Subtype",
          value_ids: [id],
          values: [sku],
        },
      ],
      offerings: [
        {
          price: { amount: 595, divisor: 100 },
          quantity: qty,
          is_enabled: true,
          readiness_state_id: 77,
        },
      ],
    });
    let inventory: any = {
      products: [
        product(1, "memo", kind === "conflict" ? 7 : 8),
        product(2, "seals", 5),
        product(3, "untouched", 3),
      ],
      quantity_on_property: [513],
      price_on_property: [],
      sku_on_property: [513],
    };
    const targets = [
      {
        productId: "1",
        sku: "memo",
        beforeQuantity: 9,
        beforePrice: 5.95,
        value: 8,
      },
      ...(kind !== "already_correct"
        ? [
            {
              productId: "2",
              sku: "seals",
              beforeQuantity: 5,
              beforePrice: 5.95,
              value: 4,
            },
          ]
        : []),
    ];
    const fetchMock = vi.fn(async (url: string, options: any) => {
      if (options.method === "PUT") {
        const body = JSON.parse(options.body);
        inventory = {
          ...body,
          products: body.products.map((p: any, i: number) => ({
            ...p,
            product_id: 100 + i,
          })),
        };
        if (kind === "uncertain_write")
          return new Response(
            JSON.stringify({ error: "Response failed after applying update" }),
            { status: 500 },
          );
      }
      return new Response(
        JSON.stringify(
          url.includes("/inventory")
            ? inventory
            : {
                listing_id: 100,
                shop_id: 1,
                title: "Museum animals",
                state: "active",
                price: { currency_code: "EUR" },
              },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const worker = createWorker({
      db,
      getConfig: () => ({ shopId: "1", apiKey: "key", accessToken: "token" }),
      delay: async () => {},
      now: () => 10,
    });
    await worker.run("sale", {
      creator: "user",
      mode: "sync",
      field: "quantity",
      entries: [{ listingId: "100", targets }],
    });
    return {
      docs,
      fetchMock,
      result: docs.get("etsy_listing_results/sale"),
      snapshot: docs.get("etsy_listing_catalog/100"),
    };
  }
  it("treats stock already deducted by Etsy as success without an inventory write", async () => {
    const s = await runScenario("already_correct");
    expect(s.result.status).toBe("completed");
    expect(s.result.results[0]).toMatchObject({
      success: true,
      action: "already_in_sync",
    });
    expect(s.fetchMock.mock.calls.some(([, o]) => o.method === "PUT")).toBe(
      false,
    );
    expect(s.snapshot.inventory.products[0].offerings[0].quantity).toBe(8);
  });
  it("updates the remaining variation despite another target already matching after a sale", async () => {
    const s = await runScenario("mixed");
    expect(s.result.status).toBe("completed");
    const writes = s.fetchMock.mock.calls.filter(([, o]) => o.method === "PUT");
    expect(writes).toHaveLength(1);
    const body = JSON.parse(writes[0][1].body);
    expect(body.products.map((p: any) => p.offerings[0].quantity)).toEqual([
      8, 4, 3,
    ]);
    expect(
      body.products.every(
        (p: any) =>
          p.offerings[0].price === 5.95 &&
          p.offerings[0].readiness_state_id === 77,
      ),
    ).toBe(true);
    expect(
      s.snapshot.inventory.products.map((p: any) => p.offerings[0].quantity),
    ).toEqual([8, 4, 3]);
  });
  it("refreshes the screen's quantities and reports exact values for a genuine new conflict", async () => {
    const s = await runScenario("conflict");
    expect(s.result.status).toBe("failed");
    expect(s.result.results[0].error).toContain(
      "reviewed 9, now 7, requested 8",
    );
    expect(s.fetchMock.mock.calls.some(([, o]) => o.method === "PUT")).toBe(
      false,
    );
    expect(s.snapshot.inventory.products[0].offerings[0].quantity).toBe(7);
  });
  it("recovers current Etsy inventory when an update takes effect but its API response fails", async () => {
    const s = await runScenario("uncertain_write");
    expect(s.result.status).toBe("failed");
    expect(s.result.results[0].error).toContain(
      "Response failed after applying update",
    );
    expect(
      s.snapshot.inventory.products.map((p: any) => p.offerings[0].quantity),
    ).toEqual([8, 4, 3]);
  });
});
