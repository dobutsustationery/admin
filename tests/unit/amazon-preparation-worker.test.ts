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
    remote = ok({
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
    read: async () => remote,
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
