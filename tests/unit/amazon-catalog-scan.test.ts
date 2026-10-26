import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const { createWorker, eligible, outcome, validate, RUNS, CACHE, REQUESTS } =
  createRequire(import.meta.url)(
    "../../functions/shared/amazon-catalog-scan.cjs",
  );
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
      where: (field: string, op: string, value: any) => ({
        get: async () => ({
          docs: [...docs.entries()]
            .filter(
              ([p, d]) =>
                p.startsWith(name + "/") &&
                (op === "==" ? d[field] === value : d[field] <= value),
            )
            .map(([p]) => snap(p)),
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
const jans = ["4542804044355", "4542804061659", "4542804151480"];
const ok = (items: any[] = []) => ({
  ok: true,
  status: 200,
  data: { numberOfResults: items.length, items },
});
function setup(search: any = async () => ok()) {
  const mem = database();
  let time = 1000;
  const calls: string[] = [];
  const w = createWorker({
    db: mem.db,
    getConfig: () => config,
    getToken: async () => "token",
    search: async ({ jan }: any) => {
      calls.push(jan);
      return search(jan);
    },
    pause: async (ms: number) => {
      time += ms;
    },
    now: () => time,
  });
  const request = async (id: string, extra: any = {}) => {
    const d = {
      creator: "test",
      marketplaceId: config.marketplaceId,
      jans,
      limit: null,
      negativeBefore: null,
      ...extra,
    };
    mem.docs.set(`${REQUESTS}/${id}`, d);
    await w.enqueue(id, d);
  };
  return {
    ...mem,
    w,
    calls,
    request,
    advance: (ms = 400000) => (time += ms),
    run: (id = "run") => mem.docs.get(`${RUNS}/${id}`),
  };
}
describe("durable inventory ASIN scanner", () => {
  it("deduplicates and finishes without a browser, recording authoritative negatives", async () => {
    const s = setup();
    await s.request("run", { jans: [...jans, jans[0]] });
    await s.w.tick();
    expect(s.run().status).toBe("complete");
    expect(s.calls).toEqual([...jans].sort());
    expect(s.run().noMatch).toBe(3);
    expect(
      [...s.docs.keys()].filter((k) => k.startsWith("broadcast/")),
    ).toHaveLength(3);
  });
  it("next N skips checked barcodes and later runs continue", async () => {
    const s = setup();
    await s.request("one", { limit: 1 });
    await s.w.tick();
    expect(s.run("one").status).toBe("limited");
    await s.request("two", { limit: 1 });
    await s.w.tick();
    expect(s.calls).toHaveLength(2);
    expect(new Set(s.calls).size).toBe(2);
    expect(s.run("two").skipped).toBe(1);
  });
  it("only rechecks old verified negatives when a cutoff is supplied", () => {
    expect(eligible({ status: "no_match", checkedAt: 10 }, 20)).toBe(true);
    expect(eligible({ status: "no_match", checkedAt: 30 }, 20)).toBe(false);
    expect(eligible({ status: "matched", checkedAt: 10 }, 20)).toBe(false);
    expect(eligible({ status: "failed" }, null)).toBe(true);
  });
  it("never classifies failed or incomplete reads as no ASIN", () => {
    expect(() =>
      outcome({ ok: false, status: 429, data: { items: [] } }),
    ).toThrow();
    expect(() =>
      outcome({ ok: true, status: 200, data: { items: [] } }),
    ).toThrow();
    expect(() =>
      outcome({
        ok: true,
        status: 200,
        data: {
          items: [],
          numberOfResults: 1,
          pagination: { nextToken: "next" },
        },
      }),
    ).toThrow();
  });
  it("retries transient failures after restart and commits results only once", async () => {
    let n = 0;
    const s = setup(async () =>
      ++n === 1 ? { ok: false, status: 429 } : ok([{ asin: "B012345678" }]),
    );
    await s.request("run", { jans: [jans[0]] });
    await s.w.tick();
    expect(s.run().cursor).toBe(0);
    expect(s.run().attempt).toBe(1);
    s.advance();
    await s.w.tick();
    await s.w.tick();
    expect(s.run().matched).toBe(1);
    expect(s.run().noMatch).toBe(0);
    expect(s.calls).toHaveLength(2);
  });
  it("coalesces concurrent start requests and overlapping workers", async () => {
    const s = setup();
    await s.request("run");
    await s.request("other");
    expect(s.docs.get(`${REQUESTS}/other`).runId).toBe("run");
    await Promise.all([s.w.tick(), s.w.tick()]);
    await s.w.tick();
    expect(s.calls).toHaveLength(3);
    expect(s.run().searched).toBe(3);
  });
  it("bounds repeated failures without poisoning the no-match cache", async () => {
    const s = setup(async () => ({ ok: false, status: 503 }));
    await s.request("run", { jans: [jans[0]] });
    for (let n = 0; n < 5; n++) {
      s.advance(4000000);
      await s.w.tick();
    }
    expect(s.run().failed).toBe(1);
    expect(s.run().noMatch).toBe(0);
    expect(
      [...s.docs.entries()].find(([k]) => k.startsWith(CACHE + "/"))?.[1]
        .status,
    ).toBe("failed");
  });
  it("recovers an expired worker lease without losing its place", async () => {
    const s = setup();
    await s.request("run", { jans: [jans[0]] });
    Object.assign(s.run(), { lease: "dead-worker", leaseUntil: 200000 });
    await s.w.tick();
    expect(s.calls).toHaveLength(0);
    s.advance();
    await s.w.tick();
    expect(s.run().status).toBe("complete");
    expect(s.run().searched).toBe(1);
  });
  it("retries a failed result commit without advancing or duplicating results", async () => {
    let first = true;
    const s = setup(async () => {
      if (first) {
        first = false;
        s.failNextCommit();
      }
      return ok();
    });
    await s.request("run", { jans: [jans[0]] });
    await s.w.tick();
    expect(s.run().cursor).toBe(0);
    expect(
      [...s.docs.keys()].filter((k) => k.startsWith("broadcast/")),
    ).toHaveLength(0);
    s.advance();
    await s.w.tick();
    expect(s.run().status).toBe("complete");
    expect(s.run().noMatch).toBe(1);
    expect(
      [...s.docs.keys()].filter((k) => k.startsWith("broadcast/")),
    ).toHaveLength(1);
  });
  it("validates limits instead of silently truncating the requested scan", () => {
    expect(() =>
      validate({
        creator: "u",
        marketplaceId: config.marketplaceId,
        jans,
        limit: 0,
        negativeBefore: null,
      }),
    ).toThrow();
  });
});
