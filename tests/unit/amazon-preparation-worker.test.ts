import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const { createWorker, validateRequest, JOBS, REQUESTS } = createRequire(
  import.meta.url,
)("../../functions/shared/amazon-preparation-worker.cjs");
function database() {
  const docs = new Map<string, any>();
  let gate = Promise.resolve(),
    rejectCommit = false;
  const ref = (path: string): any => ({
    path,
    id: path.split("/").at(-1),
    get: async () => snap(path),
  });
  const snap = (path: string): any => ({
    exists: docs.has(path),
    data: () => structuredClone(docs.get(path)),
    ref: ref(path),
    id: path.split("/").at(-1),
  });
  const db: any = {
    collection: (name: string) => ({
      doc: (id: string) => ref(`${name}/${id}`),
      where: (_field: string, _op: string, value: number) => ({
        limit: (n: number) => ({
          get: async () => ({
            docs: [...docs.entries()]
              .filter(([p, d]) => p.startsWith(name + "/") && d.dueAt <= value)
              .slice(0, n)
              .map(([p]) => snap(p)),
          }),
        }),
      }),
    }),
    runTransaction: async (fn: any) => {
      const previous = gate;
      let release: any;
      gate = new Promise((r) => (release = r));
      await previous;
      const writes: any[] = [];
      try {
        const result = await fn({
          get: async (r: any) => snap(r.path),
          create: (r: any, d: any) => {
            if (docs.has(r.path)) throw Error("exists");
            writes.push([r.path, d]);
          },
          set: (r: any, d: any) => writes.push([r.path, d]),
          update: (r: any, d: any) =>
            writes.push([r.path, { ...docs.get(r.path), ...d }]),
        });
        if (rejectCommit) {
          rejectCommit = false;
          throw Error("crash before commit");
        }
        for (const [p, d] of writes) docs.set(p, structuredClone(d));
        return result;
      } finally {
        release();
      }
    },
  };
  return { db, docs, failNextCommit: () => (rejectCommit = true), ref };
}
const config = { sellerId: "seller", marketplaceId: "A1F83G8C2ARO7P" };
const entry = (sku = "sku") => ({
  itemKey: sku,
  sku,
  method: "PATCH",
  body: {
    productType: "STICKER_DECAL",
    patches: [
      {
        op: "replace",
        path: "/attributes/fulfillment_availability",
        value: [{ fulfillment_channel_code: "DEFAULT", quantity: 4 }],
      },
    ],
  },
});
const ok = (data: any) => ({ ok: true, status: 200, data });
function setup(write?: any) {
  const mem = database();
  let time = 1000,
    remote: any = ok({
      offers: [{ price: { currencyCode: "GBP", amount: 4 } }],
      fulfillmentAvailability: [
        { fulfillmentChannelCode: "DEFAULT", quantity: 2 },
      ],
    });
  const calls: any[] = [],
    readbacks: any[] = [];
  const w = createWorker({
    db: mem.db,
    getConfig: () => config,
    getToken: async () => "token",
    read: async ({ sku }: any) =>
      typeof remote === "function" ? remote(sku) : remote,
    write: async (args: any) => {
      calls.push(args);
      return write
        ? write(args)
        : ok({ status: args.preview ? "VALID" : "ACCEPTED" });
    },
    enqueueReadback: async (...args: any[]) => {
      readbacks.push(args);
    },
    now: () => time,
    pause: async () => {},
  });
  const request = async (id: string, data: any) => {
    const d = { ...config, creator: "user", ...data };
    mem.docs.set(`${REQUESTS}/${id}`, d);
    await w.enqueue(id, d);
  };
  const jobs = () =>
    [...mem.docs.entries()]
      .filter(([p]) => p.startsWith(JOBS + "/"))
      .map(([p, d]) => ({ ...d, id: p.split("/").at(-1), ref: mem.ref(p) }));
  return {
    ...mem,
    w,
    request,
    jobs,
    calls,
    readbacks,
    setTime: (t: number) => (time = t),
    setRemote: (r: any) => (remote = r),
  };
}
describe("independent Amazon preview/publication worker", () => {
  it("rejects broad patches, implicit exemptions and publication without stock review", () => {
    const base = { creator: "user", ...config };
    expect(() =>
      validateRequest({ ...base, mode: "publish", jobIds: ["a".repeat(64)] }),
    ).toThrow();
    expect(() =>
      validateRequest({
        ...base,
        mode: "preview",
        entries: [
          {
            ...entry(),
            body: {
              productType: "PRODUCT",
              patches: [
                { op: "replace", path: "/attributes/brand", value: [] },
              ],
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      validateRequest({
        ...base,
        mode: "preview",
        entries: [entry(), entry()],
      }),
    ).toThrow();
  });
  it("publishes valid neighbours while leaving rejected products for later, and never duplicates a publish", async () => {
    const s = setup(async ({ entry: e, preview }: any) =>
      ok({
        status: e.sku === "bad" ? "INVALID" : preview ? "VALID" : "ACCEPTED",
        issues:
          e.sku === "bad"
            ? [{ severity: "ERROR", code: "8560", message: "Missing details" }]
            : [],
      }),
    );
    await s.request("preview", {
      mode: "preview",
      entries: [entry("good"), entry("bad")],
    });
    await s.w.tick();
    expect(s.jobs().map((j) => j.status)).toEqual(["ready", "blocked"]);
    const ids = s.jobs().map((j) => j.id);
    await s.request("publish", {
      mode: "publish",
      stockConfirmed: true,
      jobIds: ids,
    });
    await s.request("duplicate", {
      mode: "publish",
      stockConfirmed: true,
      jobIds: ids,
    });
    await Promise.all([s.w.tick(), s.w.tick()]);
    expect(s.calls.filter((c) => !c.preview).map((c) => c.entry.sku)).toEqual([
      "good",
    ]);
    expect(s.jobs().map((j) => j.status)).toEqual(["submitted", "blocked"]);
    expect(s.readbacks).toHaveLength(1);
    expect(
      [...s.docs.values()].some(
        (d) =>
          d.type === "amazonPrepare/job" &&
          d.payload.validation?.data.status === "INVALID",
      ),
    ).toBe(true);
  });
  it("detects changed Amazon stock after preview and does not overwrite it", async () => {
    const s = setup();
    await s.request("p", { mode: "preview", entries: [entry()] });
    await s.w.tick();
    s.setRemote(
      ok({
        fulfillmentAvailability: [
          { fulfillmentChannelCode: "DEFAULT", quantity: 1 },
        ],
      }),
    );
    await s.request("w", {
      mode: "publish",
      stockConfirmed: true,
      jobIds: s.jobs().map((j) => j.id),
    });
    await s.w.tick();
    expect(s.calls.filter((c) => !c.preview)).toHaveLength(0);
    expect(s.jobs()[0].error).toContain("changed since preview");
  });
  it("recovers an uncertain write with readback and no retry", async () => {
    const s = setup(async ({ preview }: any) => {
      if (!preview) throw Error("connection lost after send");
      return ok({ status: "VALID" });
    });
    await s.request("p", { mode: "preview", entries: [entry()] });
    await s.w.tick();
    await s.request("w", {
      mode: "publish",
      stockConfirmed: true,
      jobIds: s.jobs().map((j) => j.id),
    });
    await s.w.tick();
    await s.w.tick();
    expect(s.calls.filter((c) => !c.preview)).toHaveLength(1);
    expect(s.jobs()[0].status).toBe("unknown");
    expect(s.readbacks).toHaveLength(1);
  });
  it("a crashed publishing lease resumes with observation only", async () => {
    const s = setup();
    await s.request("p", { mode: "preview", entries: [entry()] });
    await s.w.tick();
    const j = s.jobs()[0];
    s.docs.set(j.ref.path, {
      ...s.docs.get(j.ref.path),
      status: "publishing",
      lease: "crashed",
      leaseUntil: 240000,
      dueAt: 0,
    });
    s.setTime(240001);
    await s.w.tick();
    expect(s.calls.filter((c) => !c.preview)).toHaveLength(0);
    expect(s.jobs()[0].status).toBe("unknown");
    expect(s.readbacks).toHaveLength(1);
  });
  it("expires old previews without publishing", async () => {
    const s = setup();
    await s.request("p", { mode: "preview", entries: [entry()] });
    await s.w.tick();
    s.setTime(1801001);
    await s.request("w", {
      mode: "publish",
      stockConfirmed: true,
      jobIds: s.jobs().map((j) => j.id),
    });
    await s.w.tick();
    expect(s.calls.filter((c) => !c.preview)).toHaveLength(0);
    expect(s.jobs()[0].error).toContain("expired");
  });
  it("retries throttled preview without blocking other products", async () => {
    let first = true;
    const s = setup(async ({ entry: e }: any) => {
      if (e.sku === "busy" && first) {
        first = false;
        return { ok: false, status: 429, retryAfter: "120", data: {} };
      }
      return ok({ status: "VALID" });
    });
    await s.request("p", {
      mode: "preview",
      entries: [entry("busy"), entry("good")],
    });
    await s.w.tick();
    expect(s.jobs().map((j) => j.status)).toEqual(["queued", "ready"]);
    s.setTime(121000);
    await s.w.tick();
    expect(s.jobs().map((j) => j.status)).toEqual(["ready", "ready"]);
  });
});

it("readback is given the exact submitted targets, even for an already buyable listing", async () => {
  const s = setup();
  await s.request("p", { mode: "preview", entries: [entry()] });
  await s.w.tick();
  await s.request("w", {
    mode: "publish",
    stockConfirmed: true,
    jobIds: s.jobs().map((j) => j.id),
  });
  await s.w.tick();
  expect(s.readbacks[0][3]).toEqual({ quantity: 4 });
});

describe("Offer-only server validation", () => {
  const offer = () => ({
    itemKey: "offer",
    sku: "offer",
    method: "PUT",
    body: {
      productType: "PRODUCT",
      requirements: "LISTING_OFFER_ONLY",
      attributes: {
        merchant_suggested_asin: [
          { value: "B012345678", marketplace_id: config.marketplaceId },
        ],
        condition_type: [
          { value: "new_new", marketplace_id: config.marketplaceId },
        ],
        purchasable_offer: [
          {
            marketplace_id: config.marketplaceId,
            currency: "GBP",
            our_price: [{ schedule: [{ value_with_tax: 4 }] }],
          },
        ],
        fulfillment_availability: [
          { fulfillment_channel_code: "DEFAULT", quantity: 3 },
        ],
      },
    },
  });
  it("accepts offer-only payloads but rejects product-content edits and zero-stock creation", () => {
    const e = offer();
    const validate = () =>
      validateRequest({
        ...config,
        creator: "test",
        mode: "preview",
        entries: [e],
      });
    expect(validate).not.toThrow();
    (e.body.attributes as any).item_name = [{ value: "overwrite" }];
    expect(validate).toThrow("offer fields only");
    delete (e.body.attributes as any).item_name;
    e.body.attributes.fulfillment_availability[0].quantity = 0;
    expect(validate).toThrow();
  });
  it("previews an absent offer without publishing and refuses to replace an existing SKU", async () => {
    const s = setup();
    s.setRemote({ status: 404, data: {} });
    await s.request("new-offer", { mode: "preview", entries: [offer()] });
    await s.w.tick();
    expect(s.jobs()[0].status).toBe("ready");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].preview).toBe(true);
    const existing = setup();
    await existing.request("existing-offer", {
      mode: "preview",
      entries: [offer()],
    });
    await existing.w.tick();
    expect(existing.jobs()[0].status).toBe("blocked");
    expect(existing.calls).toHaveLength(0);
  });
});

function familyEntries() {
  const attrs = (role: string) => ({
    brand: [{ value: "Amifa", marketplace_id: config.marketplaceId }],
    parentage_level: [{ value: role, marketplace_id: config.marketplaceId }],
    variation_theme: [{ name: "COLOR", marketplace_id: config.marketplaceId }],
  });
  const family = {
    handle: "letters",
    parentSku: "P-letters",
    theme: "COLOR",
    attribute: "color",
  };
  return [
    {
      itemKey: "@family:letters",
      sku: "P-letters",
      method: "PUT",
      family: { ...family, role: "parent" },
      body: {
        productType: "STICKER_DECAL",
        requirements: "LISTING",
        attributes: { ...attrs("parent"), skip_offer: [{ value: true }] },
      },
    },
    ...["Blue", "Green"].map((value, i) => ({
      itemKey: value,
      sku: value,
      method: "PUT",
      family: { ...family, role: "child" },
      body: {
        productType: "STICKER_DECAL",
        requirements: "LISTING",
        attributes: {
          ...attrs("child"),
          child_parent_sku_relationship: [
            {
              parent_sku: "P-letters",
              child_relationship_type: "variation",
              marketplace_id: config.marketplaceId,
            },
          ],
          color: [{ value, marketplace_id: config.marketplaceId }],
          externally_assigned_product_identifier: [
            {
              type: "ean",
              value: String(4542804151466 + i),
              marketplace_id: config.marketplaceId,
            },
          ],
          fulfillment_availability: [
            { fulfillment_channel_code: "DEFAULT", quantity: 4 },
          ],
          purchasable_offer: [
            {
              currency: "GBP",
              marketplace_id: config.marketplaceId,
              our_price: [{ schedule: [{ value_with_tax: 4 }] }],
            },
          ],
        },
      },
    })),
  ];
}
function observedParent(entries: any[]) {
  return ok({
    attributes: entries[0].body.attributes,
    summaries: [{ productType: "STICKER_DECAL" }],
    issues: [],
  });
}
describe("Amazon parent-first family publication", () => {
  it("waits for the submitted parent to be observed before sending a child, and records relationship readback", async () => {
    const entries = familyEntries(),
      remote = new Map();
    const s = setup();
    s.setRemote((sku: string) => remote.get(sku) || { status: 404, data: {} });
    await s.request("family-preview", { mode: "preview", entries });
    await s.w.tick();
    expect(s.jobs().every((j) => j.status === "ready")).toBe(true);
    await expect(
      s.request("orphan-publish", {
        mode: "publish",
        stockConfirmed: true,
        jobIds: [s.jobs().find((j) => j.entry.sku === "Blue").id],
      }),
    ).rejects.toThrow("parent");
    await s.request("family-publish", {
      mode: "publish",
      stockConfirmed: true,
      jobIds: s.jobs().map((j) => j.id),
    });
    const parent = s.jobs().find((j) => j.entry.family.role === "parent"),
      blue = s.jobs().find((j) => j.entry.sku === "Blue");
    await s.w.step(blue.ref);
    expect(s.calls.filter((c) => !c.preview)).toHaveLength(0);
    await s.w.step(parent.ref);
    expect(s.calls.filter((c) => !c.preview).map((c) => c.entry.sku)).toEqual([
      "P-letters",
    ]);
    s.setTime(12000);
    await s.w.step(blue.ref);
    expect(s.calls.filter((c) => !c.preview)).toHaveLength(1);
    remote.set("P-letters", observedParent(entries));
    s.setTime(23000);
    await s.w.step(blue.ref);
    expect(s.calls.filter((c) => !c.preview).map((c) => c.entry.sku)).toEqual([
      "P-letters",
      "Blue",
    ]);
    await s.w.step(blue.ref);
    expect(s.readbacks[0][3]).toMatchObject({
      parentage: "child",
      parentSku: "P-letters",
      variationTheme: "COLOR",
      quantity: 4,
      priceGBP: 4,
    });
    expect(
      [...s.docs.values()].some((d) => d.eventType === "amazon/sync_requested"),
    ).toBe(true);
    expect(
      [...s.docs.values()].some((d) => d.eventType === "amazon/sync_claimed"),
    ).toBe(true);
  });
  it("reuses an observed matching parent without overwriting it and blocks unrelated existing SKUs", async () => {
    const entries = familyEntries(),
      s = setup();
    s.setRemote((sku: string) =>
      sku === "P-letters" ? observedParent(entries) : { status: 404, data: {} },
    );
    await s.request("reuse-preview", { mode: "preview", entries });
    await s.w.tick();
    expect(
      s.jobs().find((j) => j.entry.family.role === "parent").reuseParent,
    ).toBe(true);
    await s.request("reuse-publish", {
      mode: "publish",
      stockConfirmed: true,
      jobIds: s.jobs().map((j) => j.id),
    });
    await s.w.tick();
    expect(
      s.calls
        .filter((c) => !c.preview)
        .map((c) => c.entry.sku)
        .sort(),
    ).toEqual(["Blue", "Green"]);
    const unrelated = setup();
    unrelated.setRemote(
      ok({ attributes: { parentage_level: [{ value: "child" }] } }),
    );
    await unrelated.request("unrelated", { mode: "preview", entries });
    await unrelated.w.tick();
    expect(unrelated.jobs().every((j) => j.status === "blocked")).toBe(true);
    expect(unrelated.calls).toHaveLength(0);
  });
});

it("stops every child if Amazon rejects the parent publication", async () => {
  const entries = familyEntries();
  const s = setup(({ entry, preview }: any) =>
    ok(
      !preview && entry.family.role === "parent"
        ? {
            status: "INVALID",
            issues: [
              {
                severity: "ERROR",
                code: "parent-rejected",
                message: "Parent rejected",
              },
            ],
          }
        : { status: preview ? "VALID" : "ACCEPTED" },
    ),
  );
  s.setRemote({ status: 404, data: {} });
  await s.request("reject-parent-preview", { mode: "preview", entries });
  await s.w.tick();
  await s.request("reject-parent-publish", {
    mode: "publish",
    stockConfirmed: true,
    jobIds: s.jobs().map((j) => j.id),
  });
  await s.w.tick();
  expect(s.calls.filter((c) => !c.preview).map((c) => c.entry.sku)).toEqual([
    "P-letters",
  ]);
  expect(
    s
      .jobs()
      .filter((j) => j.entry.family.role === "child")
      .every(
        (j) =>
          j.status === "blocked" && j.error.includes("No child was submitted"),
      ),
  ).toBe(true);
});
