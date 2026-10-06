// Explicit, per-product preview and publication. No unattended inventory writer.
const { createHash, randomUUID } = require("node:crypto");
const REQUESTS = "request_amazon_prepare",
  JOBS = "amazon_prepare_jobs",
  LOCKS = "amazon_prepare_locks";
const UK = "A1F83G8C2ARO7P";
const hash = (v) => createHash("sha256").update(v).digest("hex");
const valid = (r) =>
  r?.status >= 200 &&
  r.status < 300 &&
  r.data?.status === "VALID" &&
  !(r.data?.issues || []).some((i) => i.severity === "ERROR");
const errors = (r) =>
  (r?.data?.issues || r?.data?.errors || [])
    .map((i) => `${i.code || ""}: ${i.message || ""}`)
    .join(" · ");
function validateRequest(d) {
  if (
    !d?.creator ||
    !d.sellerId ||
    d.marketplaceId !== UK ||
    !["preview", "publish"].includes(d.mode)
  )
    throw Error("Choose the configured UK seller and sign in.");
  if (d.mode === "publish") {
    if (
      d.stockConfirmed !== true ||
      !Array.isArray(d.jobIds) ||
      !d.jobIds.length ||
      d.jobIds.length > 100 ||
      d.jobIds.some((id) => !/^[a-f0-9]{64}$/.test(id))
    )
      throw Error(
        "Review 1–100 products and confirm their stock before publishing.",
      );
    return;
  }
  if (
    !Array.isArray(d.entries) ||
    !d.entries.length ||
    d.entries.length > 100 ||
    JSON.stringify(d.entries).length > 600000
  )
    throw Error("Prepare 1–100 products at a time.");
  const seen = new Set();
  for (const e of d.entries) {
    if (
      !e.itemKey ||
      typeof e.sku !== "string" ||
      !e.sku.trim() ||
      e.sku.length > 200 ||
      seen.has(e.sku) ||
      !["PUT", "PATCH"].includes(e.method) ||
      !/^[A-Z][A-Z0-9_]{0,99}$/.test(e.body?.productType)
    )
      throw Error("Invalid or duplicate product in preparation request.");
    seen.add(e.sku);
    const attributes =
      e.method === "PUT"
        ? e.body.attributes
        : Object.fromEntries(
            (e.body.patches || []).map((p) => [
              p.path?.replace("/attributes/", ""),
              p.value,
            ]),
          );
    if (
      e.method === "PATCH" &&
      (!e.body.patches?.length ||
        e.body.patches.some(
          (p) =>
            p.op !== "replace" ||
            ![
              "/attributes/purchasable_offer",
              "/attributes/fulfillment_availability",
            ].includes(p.path),
        ))
    )
      throw Error(
        "Existing listings may update only price and merchant-fulfilled quantity.",
      );
    if (
      e.method === "PUT" &&
      (e.body.requirements !== "LISTING" ||
        attributes?.supplier_declared_has_product_identifier_exemption ||
        attributes?.parentage_level ||
        !/^\d{13}$/.test(
          attributes?.externally_assigned_product_identifier?.[0]?.value || "",
        ))
    )
      throw Error(
        "New products require a distinct manufacturer EAN/JAN; variant exemptions need separate review.",
      );
    const offers = attributes?.purchasable_offer;
    if (
      offers &&
      (offers.length !== 1 ||
        offers[0].currency !== "GBP" ||
        offers[0].marketplace_id !== UK ||
        !(offers[0].our_price?.[0]?.schedule?.[0]?.value_with_tax > 0))
    )
      throw Error("An explicit GBP price is required.");
    const stock = attributes?.fulfillment_availability;
    if (
      stock &&
      (stock.length !== 1 ||
        stock[0].fulfillment_channel_code !== "DEFAULT" ||
        !Number.isInteger(stock[0].quantity) ||
        stock[0].quantity < 0)
    )
      throw Error(
        "Stock must be a non-negative whole number of merchant-fulfilled units.",
      );
    if (e.method === "PUT" && (!stock || !offers))
      throw Error("New products require a price and stock quantity.");
  }
}
function baseline(r) {
  if (r?.status === 404) return "absent";
  return JSON.stringify(
    {
      status: r?.status,
      summaries: (r?.data?.summaries || []).map((s) => ({
        asin: s.asin,
        productType: s.productType,
      })),
      offers: r?.data?.offers || [],
      stock: r?.data?.fulfillmentAvailability || [],
      offerAttributes: r?.data?.attributes?.purchasable_offer || [],
      stockAttributes: r?.data?.attributes?.fulfillment_availability || [],
      issues: (r?.data?.issues || []).filter((i) => i.severity === "ERROR"),
    },
    (_key, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, v[k]]),
          )
        : v,
  );
}
function createWorker({
  db,
  getConfig,
  getToken,
  read,
  write,
  enqueueReadback,
  now = Date.now,
  pause = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  function fact(tx, id, j) {
    // These are observed API request/response bytes and operational state, not
    // cached readiness calculations. The application derives readiness on replay.
    const payload = {
      id,
      sellerId: j.sellerId,
      marketplaceId: UK,
      entry: j.entry,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      revision: j.revision,
      status: j.status,
      error: j.error || "",
      validation: j.validation || null,
      result: j.result || null,
      submittedAt: j.submittedAt || 0,
      before: j.before || null,
    };
    tx.set(
      db.collection("broadcast").doc(`amazon-prepare-${id}-${j.revision}`),
      {
        type: "amazonPrepare/job",
        payload,
        creator: "amazon-preparation-function",
        timestamp: new Date(j.updatedAt),
      },
    );
  }
  async function enqueue(id, data) {
    validateRequest(data);
    const config = getConfig();
    if (config.marketplaceId !== UK || config.sellerId !== data.sellerId)
      throw Error(
        "The configured Amazon seller changed. Refresh the catalogue.",
      );
    const ref = db.collection(REQUESTS).doc(id);
    await db.runTransaction(async (tx) => {
      const request = await tx.get(ref);
      if (request.data()?.queuedAt) return;
      const at = now();
      const jobs =
        data.mode === "publish"
          ? await Promise.all(
              [...new Set(data.jobIds)].map((j) =>
                tx.get(db.collection(JOBS).doc(j)),
              ),
            )
          : [];
      if (data.mode === "preview")
        for (const entry of data.entries) {
          const jobId = hash(`${id}:${entry.sku}`);
          const j = {
            entry,
            sellerId: config.sellerId,
            creator: data.creator,
            createdAt: at,
            updatedAt: at,
            status: "queued",
            dueAt: at,
            leaseUntil: 0,
            lease: "",
            attempts: 0,
            revision: 0,
            error: "",
          };
          tx.create(db.collection(JOBS).doc(jobId), j);
          fact(tx, jobId, j);
        }
      else
        for (const snap of jobs) {
          const old = snap.data();
          // A row that has become ineligible does not prevent its neighbours.
          if (
            !old ||
            old.sellerId !== config.sellerId ||
            old.status !== "ready" ||
            !valid(old.validation)
          )
            continue;
          const expired = at - old.updatedAt > 1800000;
          const j = {
            ...old,
            status: expired ? "blocked" : "publish_queued",
            error: expired ? "Preview expired. Check this product again." : "",
            publishRequestId: id,
            updatedAt: at,
            dueAt: expired ? Number.MAX_SAFE_INTEGER : at,
            revision: old.revision + 1,
          };
          tx.set(snap.ref, j);
          fact(tx, snap.id, j);
        }
      tx.update(ref, { queuedAt: at, error: "" });
    });
  }
  async function finish(ref, lease, changes) {
    await db.runTransaction(async (tx) => {
      const old = (await tx.get(ref)).data();
      if (!old || old.lease !== lease) return;
      const j = {
        ...old,
        ...changes,
        updatedAt: now(),
        lease: "",
        leaseUntil: 0,
        revision: old.revision + 1,
      };
      tx.set(ref, j);
      fact(tx, ref.id, j);
    });
  }
  async function step(ref) {
    const lease = randomUUID();
    const job = await db.runTransaction(async (tx) => {
      const j = (await tx.get(ref)).data();
      if (!j || j.dueAt > now() || j.leaseUntil > now()) return null;
      if (
        ![
          "queued",
          "publish_queued",
          "publishing",
          "readback_pending",
        ].includes(j.status)
      )
        return null;
      tx.update(ref, { lease, leaseUntil: now() + 240000 });
      return j;
    });
    if (!job) return;
    const done = (changes) =>
      finish(ref, lease, { dueAt: Number.MAX_SAFE_INTEGER, ...changes });
    // Never retry a possibly delivered write. Recover by observation only.
    if (["publishing", "readback_pending"].includes(job.status)) {
      const attributes =
        job.entry.method === "PUT"
          ? job.entry.body.attributes
          : Object.fromEntries(
              job.entry.body.patches.map((p) => [
                p.path.replace("/attributes/", ""),
                p.value,
              ]),
            );
      const quantity = attributes.fulfillment_availability?.find(
        (a) => a.fulfillment_channel_code === "DEFAULT",
      )?.quantity;
      const priceGBP = attributes.purchasable_offer?.find(
        (o) => o.currency === "GBP",
      )?.our_price?.[0]?.schedule?.[0]?.value_with_tax;
      await enqueueReadback(ref.id, job.creator, job.entry.sku, {
        ...(quantity !== undefined ? { quantity } : {}),
        ...(priceGBP !== undefined ? { priceGBP } : {}),
      });
      await done({
        status: job.status === "publishing" ? "unknown" : "submitted",
        error:
          job.status === "publishing"
            ? "The write outcome is uncertain. Automatic readback was queued; review Amazon before preparing another update."
            : "",
      });
      return;
    }
    let sending = false,
      lockRef;
    try {
      const config = getConfig();
      if (config.sellerId !== job.sellerId || config.marketplaceId !== UK)
        throw Error("Configured seller changed. Refresh and prepare again.");
      const accessToken = await getToken(config);
      const before = await read({ config, accessToken, sku: job.entry.sku });
      if (before.status !== 200 && before.status !== 404)
        throw Error(`Could not read Amazon SKU (HTTP ${before.status}).`);
      if (job.entry.method === "PUT" && before.status !== 404)
        throw Error(
          "This seller SKU already exists. Refresh the catalogue and prepare it as an update.",
        );
      if (
        job.entry.method === "PATCH" &&
        (before.status !== 200 ||
          (before.data?.issues || []).some((i) => i.severity === "ERROR") ||
          (before.data?.attributes?.parentage_level || []).some(
            (v) => v.value === "parent",
          ))
      )
        throw Error(
          "The existing SKU is missing, is a variation parent, or has an Amazon error. Refresh and resolve this product later.",
        );
      if (job.entry.method === "PATCH") {
        const paths = job.entry.body.patches.map((p) => p.path);
        const offers = before.data?.attributes?.purchasable_offer || [];
        if (
          paths.includes("/attributes/purchasable_offer") &&
          (offers.length > 1 ||
            offers.some(
              (o) =>
                (o.audience && o.audience !== "ALL") ||
                (o.marketplace_id && o.marketplace_id !== UK),
            ))
        )
          throw Error(
            "This SKU has multiple or business offers. Review its pricing separately before syncing.",
          );
        if (
          paths.includes("/attributes/fulfillment_availability") &&
          (before.data?.fulfillmentAvailability || []).some(
            (a) => a.fulfillmentChannelCode !== "DEFAULT",
          )
        )
          throw Error(
            "This SKU uses another fulfilment channel. Review its stock separately before syncing.",
          );
      }
      if (job.status === "queued") {
        const response = await write({
          config,
          accessToken,
          entry: job.entry,
          preview: true,
        });
        if (response.status === 429 || response.status >= 500) {
          await done({
            status: job.attempts >= 4 ? "blocked" : "queued",
            attempts: job.attempts + 1,
            dueAt:
              job.attempts >= 4
                ? Number.MAX_SAFE_INTEGER
                : now() +
                  Math.max(
                    60000 * 2 ** job.attempts,
                    Number(response.retryAfter || 0) * 1000,
                  ),
            validation: response,
            before,
            error: "Amazon is busy. Preview will retry automatically.",
          });
        } else
          await done({
            status: valid(response) ? "ready" : "blocked",
            validation: response,
            validatedAt: now(),
            before,
            error: valid(response)
              ? ""
              : errors(response) ||
                `Amazon did not validate this product (HTTP ${response.status}, ${response.data?.status || "no status"}).`,
          });
        return;
      }
      if (
        now() - (job.validatedAt || job.createdAt) > 1800000 ||
        !valid(job.validation)
      )
        throw Error("Preview expired or is invalid. Check this product again.");
      if (baseline(before) !== baseline(job.before))
        throw Error(
          "Amazon price, stock or identity changed since preview. Refresh and check this product again.",
        );
      lockRef = db
        .collection(LOCKS)
        .doc(hash(`${job.sellerId}:${job.entry.sku}`));
      const claimed = await db.runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data(),
          lock = (await tx.get(lockRef)).data();
        if (current?.lease !== lease) return false;
        if (lock?.until > now() && lock.jobId !== ref.id) return false;
        tx.set(lockRef, { jobId: ref.id, until: now() + 300000 });
        const j = {
          ...current,
          status: "publishing",
          updatedAt: now(),
          revision: current.revision + 1,
        };
        tx.set(ref, j);
        fact(tx, ref.id, j);
        return true;
      });
      if (!claimed)
        throw Error(
          "Another update for this SKU is running. Check it again after that update finishes.",
        );
      sending = true;
      const result = await write({
        config,
        accessToken,
        entry: job.entry,
        preview: false,
      });
      const accepted =
        result.ok &&
        result.data?.status === "ACCEPTED" &&
        !(result.data?.issues || []).some((i) => i.severity === "ERROR");
      const uncertain =
        !accepted &&
        result.data?.status !== "INVALID" &&
        !(result.data?.issues || []).some((i) => i.severity === "ERROR") &&
        !(result.status >= 400 && result.status < 500);
      // Save the response before enqueuing readback, so a queue failure cannot
      // cause resubmission. The scheduler repairs readback_pending jobs.
      await done({
        result,
        submittedAt: now(),
        status: accepted
          ? "readback_pending"
          : uncertain
            ? "publishing"
            : "blocked",
        dueAt: accepted || uncertain ? now() : Number.MAX_SAFE_INTEGER,
        error: accepted
          ? ""
          : errors(result) ||
            `Amazon submission returned HTTP ${result.status}; check again before retrying.`,
      });
    } catch (e) {
      await done({
        ...(sending ? { submittedAt: now() } : {}),
        status: sending ? "publishing" : "blocked",
        dueAt: sending ? now() : Number.MAX_SAFE_INTEGER,
        error: e.message || String(e),
      });
    }
  }
  async function tick() {
    const start = now();
    for (let n = 0; n < 100 && now() - start < 170000; n++) {
      const snap = await db
        .collection(JOBS)
        .where("dueAt", "<=", now())
        .limit(10)
        .get();
      const next = snap.docs.find((d) => d.data().leaseUntil <= now());
      if (!next) break;
      await step(next.ref);
      await pause(1100);
    }
  }
  return { enqueue, step, tick };
}
module.exports = {
  createWorker,
  validateRequest,
  valid,
  baseline,
  REQUESTS,
  JOBS,
};
