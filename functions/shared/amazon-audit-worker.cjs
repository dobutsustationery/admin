// Read-only, restartable Amazon catalogue audit. Operational jobs carry cursors;
// raw API bytes and operator intent are the durable replay inputs.
const { createHash, randomUUID } = require("node:crypto");
const JOBS = "amazon_audit_jobs";
const REQUESTS = "request_amazon_audit";
const UK = "A1F83G8C2ARO7P";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const delays = [60_000, 180_000, 600_000, 1_800_000, 3_600_000];
const array = (v) => (Array.isArray(v) ? v : []);
function needsReadback(raw, status) {
  if (status === 404) return true;
  if (status !== 200) return false;
  if (array(raw?.issues).some((i) => i.severity === "ERROR")) return false;
  if (array(raw?.attributes?.parentage_level).some((v) => v.value === "parent"))
    return false;
  if (array(raw?.summaries).some((s) => array(s.status).includes("BUYABLE")))
    return false;
  if (
    array(raw?.fulfillmentAvailability).some(
      (a) => a.fulfillmentChannelCode === "DEFAULT" && a.quantity === 0,
    )
  )
    return false;
  return true;
}
function validateRequest(data) {
  if (
    !data ||
    typeof data.creator !== "string" ||
    !data.creator ||
    data.marketplaceId !== UK
  )
    throw Error("Sign in and select the UK marketplace.");
  if (!["catalogue", "selected"].includes(data.mode))
    throw Error("Choose a catalogue or selected-SKU audit.");
  if (
    data.mode === "selected" &&
    (!Array.isArray(data.skus) ||
      !data.skus.length ||
      data.skus.length > 100 ||
      data.skus.some(
        (s) => typeof s !== "string" || !s.trim() || s.length > 200,
      ))
  )
    throw Error("Select 1–100 valid seller SKUs.");
  return data.mode === "selected"
    ? [...new Set(data.skus.map((s) => s.trim()))]
    : [];
}
function jobFact(id, j, status, at, error = "") {
  return {
    id,
    sellerId: j.sellerId,
    marketplaceId: j.marketplaceId,
    mode: j.sku ? `sku:${j.sku}` : "catalogue",
    startedAt: j.startedAt,
    updatedAt: at,
    status,
    error,
    pages: j.page || 0,
    count: j.count || 0,
    nextCheckAt: status === "waiting" ? j.dueAt : 0,
  };
}
function addEvent(batch, db, id, type, payload, at) {
  batch.set(db.collection("broadcast").doc(`amazon-audit-${digest(id)}`), {
    type,
    payload,
    creator: "amazon-audit-function",
    timestamp: new Date(at),
  });
}
function newJob(config, creator, sku, now) {
  return {
    sellerId: config.sellerId,
    marketplaceId: config.marketplaceId,
    creator,
    sku,
    startedAt: now,
    deadline: now + 86_400_000,
    dueAt: now,
    leaseUntil: 0,
    lease: "",
    page: 0,
    count: 0,
    failures: 0,
    checks: 0,
    sequence: 0,
    cursor: "",
    status: "waiting",
  };
}
function createWorker({ db, getConfig, getToken, read, now = Date.now }) {
  async function enqueueSku(sourceId, creator, sku) {
    const config = getConfig();
    if (!config.sellerId || config.marketplaceId !== UK)
      throw Error("Amazon audit requires a configured UK seller.");
    const id = digest(`${sourceId}:${sku}`),
      ref = db.collection(JOBS).doc(id);
    await db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).exists) return;
      const at = now(),
        job = newJob(config, creator, sku, at);
      tx.create(ref, job);
      addEvent(
        tx,
        db,
        `${id}:queued`,
        "amazonAudit/job",
        jobFact(id, job, "waiting", at),
        at,
      );
    });
  }
  async function enqueue(requestId, data) {
    const skus = validateRequest(data);
    const config = getConfig();
    if (!config.sellerId || config.marketplaceId !== UK)
      throw Error("Amazon audit requires a configured UK seller.");
    const requestRef = db.collection(REQUESTS).doc(requestId);
    await db.runTransaction(async (tx) => {
      const request = await tx.get(requestRef);
      if (request.data()?.queuedAt) return;
      const at = now();
      for (const sku of skus.length ? skus : [""]) {
        const id = digest(`${requestId}:${sku}`),
          job = newJob(config, data.creator, sku, at);
        tx.create(db.collection(JOBS).doc(id), job);
        addEvent(
          tx,
          db,
          `${id}:queued`,
          "amazonAudit/job",
          jobFact(id, job, "waiting", at),
          at,
        );
      }
      tx.update(requestRef, { queuedAt: at, error: "" });
    });
  }
  async function step(ref) {
    const lease = randomUUID();
    const job = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref),
        j = snap.data(),
        at = now();
      if (!j || j.status !== "waiting" || j.dueAt > at || j.leaseUntil > at)
        return null;
      tx.update(ref, { lease, leaseUntil: at + 240_000 });
      return j;
    });
    if (!job) return;
    let response,
      problem = "";
    try {
      const config = getConfig();
      if (
        config.sellerId !== job.sellerId ||
        config.marketplaceId !== job.marketplaceId
      )
        throw Error(
          "Configured seller changed. Start a new audit for the correct account.",
        );
      const accessToken = await getToken(config);
      response = await read({
        config,
        accessToken,
        sku: job.sku,
        cursor: job.cursor,
      });
    } catch (e) {
      problem = e.message || String(e);
    }
    const at = now();
    // Commit raw input, progress and cursor together. A crash before this commit
    // can repeat a GET, but cannot lose a page or duplicate a marketplace write.
    await db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      if (!current || current.lease !== lease) return;
      const j = {
        ...current,
        lease: "",
        leaseUntil: 0,
        sequence: current.sequence + 1,
      };
      const id = `${ref.id}:${current.sequence}`;
      let status = "waiting";
      if (response) {
        const json = JSON.stringify(response.data ?? {});
        if (Buffer.byteLength(json) > 4_000_000) {
          problem =
            "Amazon response exceeds the audit limit; use a targeted SKU refresh.";
          response = undefined;
        } else {
          const parts = json.match(/[\s\S]{1,16000}/gu) || ["{}"];
          parts.forEach((part, i) =>
            addEvent(
              tx,
              db,
              `${id}:chunk:${i}`,
              "amazonAudit/chunk",
              { responseId: id, index: i, json: part },
              at,
            ),
          );
          addEvent(
            tx,
            db,
            `${id}:response`,
            "amazonAudit/response",
            {
              responseId: id,
              chunks: parts.length,
              sellerId: j.sellerId,
              marketplaceId: j.marketplaceId,
              sku: j.sku,
              status: response.status,
              at,
              requestId: response.requestId || "",
              url: response.url || "",
            },
            at,
          );
        }
      }
      const retryable =
        !response || response.status === 429 || response.status >= 500;
      if (retryable) {
        j.failures++;
        problem = problem || `Amazon HTTP ${response.status}.`;
        status = j.failures >= 6 || at >= j.deadline ? "failed" : "waiting";
        const retryAfter = Math.min(
          3_600_000,
          Math.max(0, Number(response?.retryAfter || 0) * 1000),
        );
        j.dueAt =
          at +
          Math.max(retryAfter, Math.min(3_600_000, 60_000 * 2 ** j.failures));
      } else if (!response.ok && !(j.sku && response.status === 404)) {
        status = "failed";
        problem = `Amazon HTTP ${response.status}. ${array(
          response.data?.errors,
        )
          .map((e) => e.message)
          .join(" ")}`;
      } else if (!j.sku && !Array.isArray(response.data?.items)) {
        status = "failed";
        problem =
          "Amazon returned no listing-items array. Coverage is incomplete.";
      } else if (j.sku) {
        j.checks++;
        j.failures = 0;
        status = needsReadback(response.data, response.status)
          ? at >= j.deadline
            ? "expired"
            : "waiting"
          : "complete";
        j.dueAt = at + delays[Math.min(j.checks - 1, delays.length - 1)];
      } else {
        j.page++;
        j.count += array(response.data?.items).length;
        j.failures = 0;
        const next = response.data?.pagination?.nextToken || "";
        j.cursor = next;
        status = next ? "waiting" : "complete";
        if (
          (next && (j.count >= 1000 || j.page >= 50)) ||
          (!next && Number(response.data?.numberOfResults) > j.count) ||
          (next && next === current.cursor)
        ) {
          status = "partial";
          problem =
            "Amazon search coverage limit reached. Missing SKUs are not treated as absent; use selected-SKU refresh.";
        }
        j.dueAt = at + 1000;
        for (const item of array(response.data?.items)) {
          if (!item.sku || !needsReadback(item, 200)) continue;
          const childId = digest(`${ref.id}:${item.sku}`),
            child = newJob(
              { sellerId: j.sellerId, marketplaceId: j.marketplaceId },
              j.creator,
              item.sku,
              at,
            );
          tx.set(db.collection(JOBS).doc(childId), child);
          addEvent(
            tx,
            db,
            `${childId}:queued`,
            "amazonAudit/job",
            jobFact(childId, child, "waiting", at),
            at,
          );
        }
      }
      j.status = status;
      if (status !== "waiting") j.dueAt = Number.MAX_SAFE_INTEGER;
      tx.set(ref, j);
      addEvent(
        tx,
        db,
        `${id}:job`,
        "amazonAudit/job",
        jobFact(ref.id, j, status, at, problem),
        at,
      );
    });
  }
  async function tick() {
    const due = await db
      .collection(JOBS)
      .where("dueAt", "<=", now())
      .limit(10)
      .get();
    const start = now();
    for (const doc of due.docs) {
      if (now() - start > 180_000) break;
      await step(doc.ref);
    }
  }
  return { enqueue, enqueueSku, step, tick };
}
module.exports = {
  createWorker,
  needsReadback,
  validateRequest,
  JOBS,
  REQUESTS,
};
