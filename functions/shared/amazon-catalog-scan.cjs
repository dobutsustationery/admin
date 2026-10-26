// Durable read-only barcode scan. The browser submits one inventory snapshot;
// server-owned cursors, leases and cache make all later work independent of it.
const { createHash, randomUUID } = require("node:crypto");
const RUNS = "amazon_catalog_scans",
  CACHE = "amazon_catalog_scan_cache",
  REQUESTS = "request_amazon_catalog_scan",
  CONTROL = "amazon_catalog_scan_control";
const UK = "A1F83G8C2ARO7P";
const hash = (s) => createHash("sha256").update(s).digest("hex");
function validate(d) {
  if (
    !d?.creator ||
    d.marketplaceId !== UK ||
    !Array.isArray(d.jans) ||
    d.jans.length > 20000 ||
    d.jans.some((j) => typeof j !== "string" || !/^\d{13}$/.test(j))
  )
    throw Error(
      "Supply up to 20,000 valid inventory barcodes for the UK marketplace.",
    );
  if (
    d.limit !== null &&
    (!Number.isInteger(d.limit) || d.limit < 1 || d.limit > 20000)
  )
    throw Error(
      "Test limit must be a positive whole number, or blank for all.",
    );
  if (
    d.negativeBefore !== null &&
    (!Number.isFinite(d.negativeBefore) || d.negativeBefore < 0)
  )
    throw Error("Invalid no-match recheck date.");
}
function eligible(c, before) {
  return (
    !c ||
    !["matched", "no_match"].includes(c.status) ||
    (c.status === "no_match" && before !== null && c.checkedAt < before)
  );
}
function outcome(r) {
  if (!r?.ok || r.status !== 200)
    throw Error(`Amazon lookup failed (HTTP ${r?.status || "network"}).`);
  const items = r.data?.items;
  if (!Array.isArray(items))
    throw Error(
      "Amazon returned no item list; this is not a verified no-match.",
    );
  if (items.length) return "matched";
  if (r.data.numberOfResults === 0 && !r.data.pagination?.nextToken)
    return "no_match";
  throw Error("Incomplete Amazon response; cannot confirm no ASIN exists.");
}
function createWorker({
  db,
  getConfig,
  getToken,
  search,
  loadHistory = async () => [],
  now = Date.now,
  pause = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const runRef = (id) => db.collection(RUNS).doc(id),
    cacheRef = (scope, jan) =>
      db.collection(CACHE).doc(hash(scope + ":" + jan));
  async function enqueue(id, d) {
    validate(d);
    const config = getConfig();
    if (config.marketplaceId !== UK)
      throw Error("Configured marketplace is not UK.");
    const scope = hash(config.sellerId + ":" + UK);
    const control = db.collection(CONTROL).doc(scope),
      request = db.collection(REQUESTS).doc(id);
    const oldControl = (await control.get()).data();
    if (!oldControl?.historyImported) {
      const history = await loadHistory(config);
      const latest = new Map();
      for (const record of history) {
        if (
          record.sellerId !== config.sellerId ||
          record.marketplaceId !== UK ||
          record.kind !== "catalog_search_by_jan"
        )
          continue;
        try {
          const status = outcome({
            ok: record.ok,
            status: record.status,
            data: record.raw,
          });
          const old = latest.get(record.key);
          if (!old || record.fetchedAtMs > old.checkedAt)
            latest.set(record.key, {
              sellerId: config.sellerId,
              marketplaceId: UK,
              jan: record.key,
              status,
              checkedAt: record.fetchedAtMs,
            });
        } catch {}
      }
      for (const [jan, value] of latest)
        await db.runTransaction(async (tx) => {
          const ref = cacheRef(scope, jan),
            previous = (await tx.get(ref)).data();
          if (!previous || previous.checkedAt < value.checkedAt)
            tx.set(ref, value);
        });
      await db.runTransaction(async (tx) => {
        const c = (await tx.get(control)).data() || {};
        tx.set(control, { ...c, historyImported: true });
      });
    }
    await db.runTransaction(async (tx) => {
      const req = await tx.get(request);
      if (req.data()?.runId) return;
      const ctrl = await tx.get(control);
      const active = ctrl.data()?.activeRun;
      const previous = active ? await tx.get(runRef(active)) : null;
      if (previous?.exists && previous.data().status === "running") {
        tx.update(request, { runId: active, queuedAt: now(), error: "" });
        return;
      }
      const jans = [...new Set(d.jans)].sort();
      tx.create(runRef(id), {
        sellerId: config.sellerId,
        marketplaceId: UK,
        scope,
        creator: d.creator,
        jans,
        limit: d.limit,
        negativeBefore: d.negativeBefore,
        status: "running",
        cursor: 0,
        searched: 0,
        matched: 0,
        noMatch: 0,
        failed: 0,
        skipped: 0,
        attempt: 0,
        startedAt: now(),
        updatedAt: now(),
        dueAt: now(),
        leaseUntil: 0,
        lease: "",
        lastError: "",
        failures: [],
      });
      tx.set(control, { ...(ctrl.data() || {}), activeRun: id });
      tx.update(request, { runId: id, queuedAt: now(), error: "" });
    });
  }
  async function claim(ref) {
    return db.runTransaction(async (tx) => {
      const s = await tx.get(ref),
        j = s.data();
      if (
        !j ||
        j.status !== "running" ||
        j.dueAt > now() ||
        j.leaseUntil > now()
      )
        return null;
      const lease = randomUUID();
      tx.update(ref, { lease, leaseUntil: now() + 240000 });
      return { ...j, lease };
    });
  }
  async function finish(ref, j, changes, extra) {
    await db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      if (current?.lease !== j.lease) return;
      if (extra) extra(tx);
      tx.update(ref, {
        ...changes,
        updatedAt: now(),
        lease: "",
        leaseUntil: 0,
      });
    });
  }
  async function step(ref) {
    const j = await claim(ref);
    if (!j) return false;
    const config = getConfig();
    if (
      config.sellerId !== j.sellerId ||
      config.marketplaceId !== j.marketplaceId
    ) {
      await finish(ref, j, {
        status: "failed",
        lastError: "Seller configuration changed. Start a new scan.",
      });
      return false;
    }
    if (
      j.cursor >= j.jans.length ||
      (j.limit !== null && j.searched >= j.limit)
    ) {
      await finish(ref, j, {
        status: j.cursor >= j.jans.length ? "complete" : "limited",
        dueAt: Number.MAX_SAFE_INTEGER,
      });
      return false;
    }
    const jan = j.jans[j.cursor],
      cached = (await cacheRef(j.scope, jan).get()).data();
    if (!eligible(cached, j.negativeBefore)) {
      await finish(ref, j, {
        cursor: j.cursor + 1,
        skipped: j.skipped + 1,
        attempt: 0,
        dueAt: now(),
      });
      return true;
    }
    try {
      const token = await getToken(config);
      const response = await search({ config, accessToken: token, jan });
      const status = outcome(response);
      const at = now();
      const record = {
        id: `scan:${ref.id}:${jan}`,
        requestId: ref.id,
        kind: "catalog_search_by_jan",
        key: jan,
        marketplaceId: UK,
        sellerId: j.sellerId,
        endpoint: config.endpoint || "",
        requestUrl: response.url || "",
        status: response.status,
        statusText: response.statusText || "",
        ok: true,
        rateLimit: response.rateLimit || "",
        fetchedAtMs: at,
        raw: response.data,
      };
      if (Buffer.byteLength(JSON.stringify(record)) > 700000)
        throw Error(
          "Amazon response too large to save safely; use a focused lookup.",
        );
      await finish(
        ref,
        j,
        {
          cursor: j.cursor + 1,
          searched: j.searched + 1,
          matched: j.matched + (status === "matched" ? 1 : 0),
          noMatch: j.noMatch + (status === "no_match" ? 1 : 0),
          attempt: 0,
          lastError: "",
          dueAt: now() + 1100,
        },
        (tx) => {
          tx.set(cacheRef(j.scope, jan), {
            sellerId: j.sellerId,
            marketplaceId: UK,
            jan,
            status,
            checkedAt: at,
            runId: ref.id,
          });
          tx.set(
            db
              .collection("broadcast")
              .doc(`amazon-scan-${hash(ref.id + ":" + jan)}`),
            {
              type: "amazonCatalog/apply_probe_chunk",
              payload: {
                requestId: ref.id,
                mode: "jan_probe",
                marketplaceId: UK,
                sellerId: j.sellerId,
                responses: [record],
              },
              creator: "amazon-catalog-scan-worker",
              timestamp: new Date(at),
            },
          );
        },
      );
      await pause(1100);
      return true;
    } catch (e) {
      const error = String(e.message || e).slice(0, 1500),
        attempt = j.attempt + 1;
      if (attempt < 5) {
        await finish(ref, j, {
          attempt,
          lastError: `${jan}: ${error} Retrying automatically.`,
          dueAt: now() + Math.min(3600000, 60000 * 2 ** (attempt - 1)),
        });
        return false;
      }
      await finish(
        ref,
        j,
        {
          cursor: j.cursor + 1,
          searched: j.searched + 1,
          failed: j.failed + 1,
          attempt: 0,
          lastError: `${jan}: ${error}`,
          failures: [...j.failures, { jan, error }].slice(-100),
          dueAt: now(),
        },
        (tx) =>
          tx.set(cacheRef(j.scope, jan), {
            sellerId: j.sellerId,
            marketplaceId: UK,
            jan,
            status: "failed",
            checkedAt: now(),
            error,
          }),
      );
      return true;
    }
  }
  async function tick() {
    const runs = await db
      .collection(RUNS)
      .where("status", "==", "running")
      .get();
    const deadline = now() + 45000;
    for (const r of runs.docs) {
      let steps = 0;
      while (steps++ < 200 && now() < deadline && (await step(r.ref))) {}
    }
  }
  return { enqueue, tick, step };
}
module.exports = {
  createWorker,
  validate,
  eligible,
  outcome,
  RUNS,
  CACHE,
  REQUESTS,
};
