import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const { createWorker, needsReadback, validateRequest, JOBS, REQUESTS } =
  createRequire(import.meta.url)(
    "../../functions/shared/amazon-audit-worker.cjs",
  );
// Transactional in-memory adapter: writes commit together, and transaction reads
// are serialized. This permits deterministic crash and overlapping-worker tests.
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
const accepted = { sku: "sku", summaries: [{ status: ["BUYABLE"] }] };
const ok = (data: any) => ({ ok: true, status: 200, data });
function setup(read: any) {
  const mem = database();
  let time = 1000;
  const w = createWorker({
    db: mem.db,
    getConfig: () => config,
    getToken: async () => "token",
    read,
    now: () => time,
  });
  return { ...mem, w, setTime: (t: number) => (time = t) };
}
describe("durable Amazon audit worker", () => {
  it("validates scope and bounded read requests", () => {
    expect(() =>
      validateRequest({ creator: "x", marketplaceId: "US", mode: "catalogue" }),
    ).toThrow();
    expect(() =>
      validateRequest({
        creator: "x",
        marketplaceId: config.marketplaceId,
        mode: "selected",
        skus: Array(101).fill("x"),
      }),
    ).toThrow();
    expect(
      validateRequest({
        creator: "x",
        marketplaceId: config.marketplaceId,
        mode: "selected",
        skus: ["x", "x"],
      }),
    ).toEqual(["x"]);
  });
  it("continues pagination after restart, and duplicate triggers do not restart work", async () => {
    const cursors: string[] = [];
    const s = setup(async ({ cursor }: any) => {
      cursors.push(cursor);
      return cursor
        ? ok({ items: [{ ...accepted, sku: "second" }] })
        : ok({ items: [accepted], pagination: { nextToken: "next" } });
    });
    const request = {
      creator: "u",
      marketplaceId: config.marketplaceId,
      mode: "catalogue",
      skus: [],
    };
    s.docs.set(`${REQUESTS}/req`, request);
    await s.w.enqueue("req", request);
    await s.w.tick();
    await s.w.enqueue("req", request);
    s.setTime(3000);
    await s.w.tick();
    expect(cursors).toEqual(["", "next"]);
    const job = [...s.docs.entries()].find(([p]) =>
      p.startsWith(JOBS + "/"),
    )![1];
    expect(job).toMatchObject({ status: "complete", page: 2, count: 2 });
    expect(
      [...s.docs.values()].filter((d) => d.type === "amazonAudit/response"),
    ).toHaveLength(2);
  });
  it("leases prevent concurrent duplicate reads, and retries recover an interrupted atomic commit", async () => {
    let calls = 0;
    let finish: any;
    const s = setup(async () => {
      calls++;
      await new Promise((r) => (finish = r));
      return ok(accepted);
    });
    await s.w.enqueueSku("write", "u", "sku");
    const path = [...s.docs.keys()].find((p) => p.startsWith(JOBS + "/"))!;
    const first = s.w.step(s.ref(path));
    while (!finish) await new Promise((r) => setTimeout(r, 0));
    await s.w.step(s.ref(path));
    expect(calls).toBe(1);
    s.failNextCommit();
    finish();
    await expect(first).rejects.toThrow("crash");
    expect(
      [...s.docs.values()].filter((d) => d.type === "amazonAudit/response"),
    ).toHaveLength(0);
    s.setTime(250000);
    const second = s.w.step(s.ref(path));
    finish = undefined;
    while (!finish) await new Promise((r) => setTimeout(r, 0));
    finish();
    await second;
    expect(calls).toBe(2);
    expect(s.docs.get(path).status).toBe("complete");
  });
  it("backs off 429 and stops after persistent errors without marking coverage complete", async () => {
    const s = setup(async () => ({
      status: 429,
      ok: false,
      data: { errors: [] },
      retryAfter: "300",
    }));
    await s.w.enqueueSku("write", "u", "sku");
    await s.w.tick();
    let j = [...s.docs.entries()].find(([p]) => p.startsWith(JOBS + "/"))![1];
    expect(j.dueAt).toBe(301000);
    for (let n = 0; n < 5; n++) {
      s.setTime(j.dueAt);
      await s.w.tick();
      j = [...s.docs.entries()].find(([p]) => p.startsWith(JOBS + "/"))![1];
    }
    expect(j.status).toBe("failed");
  });
  it("keeps partial coverage explicit at the search limit", async () => {
    const s = setup(async () =>
      ok({ items: [accepted], numberOfResults: 1001 }),
    );
    const r = {
      creator: "u",
      marketplaceId: config.marketplaceId,
      mode: "catalogue",
      skus: [],
    };
    s.docs.set(`${REQUESTS}/r`, r);
    await s.w.enqueue("r", r);
    await s.w.tick();
    expect(
      [...s.docs.values()].find((d) => d.status === "partial"),
    ).toBeTruthy();
  });
  it("checks processing and 404 but stops for blocking errors, parents, buyable or zero-stock offers", () => {
    expect(needsReadback({}, 404)).toBe(true);
    expect(needsReadback({}, 200)).toBe(true);
    expect(needsReadback(accepted, 200)).toBe(false);
    expect(needsReadback({ issues: [{ severity: "ERROR" }] }, 200)).toBe(false);
    expect(
      needsReadback(
        { attributes: { parentage_level: [{ value: "parent" }] } },
        200,
      ),
    ).toBe(false);
    expect(
      needsReadback(
        {
          fulfillmentAvailability: [
            { fulfillmentChannelCode: "DEFAULT", quantity: 0 },
          ],
        },
        200,
      ),
    ).toBe(false);
  });
  it("expires unresolved processing after 24 hours without resubmitting", async () => {
    let calls = 0;
    const s = setup(async () => {
      calls++;
      return ok({ sku: "sku", summaries: [] });
    });
    await s.w.enqueueSku("write", "u", "sku");
    await s.w.tick();
    s.setTime(86_402_000);
    await s.w.tick();
    expect(
      [...s.docs.values()].find((d) => d.status === "expired"),
    ).toBeTruthy();
    await s.w.tick();
    expect(calls).toBe(2);
  });
  it("does not mark malformed successful catalogue responses complete", async () => {
    const s = setup(async () => ok({ raw: "unexpected body" }));
    const request = {
      creator: "u",
      marketplaceId: config.marketplaceId,
      mode: "catalogue",
      skus: [],
    };
    s.docs.set(`${REQUESTS}/malformed`, request);
    await s.w.enqueue("malformed", request);
    await s.w.tick();
    expect(
      [...s.docs.values()].find((d) => d.status === "failed"),
    ).toBeTruthy();
  });
});

it("keeps reading a buyable offer until the explicitly submitted stock and GBP price appear", () => {
  const raw = {
    summaries: [{ status: ["BUYABLE"] }],
    offers: [{ price: { currencyCode: "GBP", amount: 4 } }],
    fulfillmentAvailability: [
      { fulfillmentChannelCode: "DEFAULT", quantity: 2 },
    ],
  };
  expect(needsReadback(raw, 200, { quantity: 3 })).toBe(true);
  expect(needsReadback(raw, 200, { priceGBP: 5 })).toBe(true);
  expect(needsReadback(raw, 200, { quantity: 2, priceGBP: 4 })).toBe(false);
});
