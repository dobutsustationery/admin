const { fetchEtsyApi } = require("./etsy-order-logic.cjs");

const API = "https://openapi.etsy.com/v3/application/";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const money = (value) =>
  typeof value === "number"
    ? value
    : Number(value?.amount) / Number(value?.divisor || 100);
const liveProducts = (inventory) =>
  (inventory?.products || []).filter((p) => !p.is_deleted);
// Etsy can replace product IDs on an inventory PUT. Identify the variation by
// its SKU and named option values when checking the returned matrix.
const variationKey = (p) =>
  JSON.stringify([
    p.sku || "",
    (p.property_values || [])
      .map((v) => [v.property_id, v.values || []])
      .sort((a, b) => a[0] - b[0]),
  ]);

// Etsy replaces the complete inventory matrix, even for a quantity-only edit.
// Preserve every other product, price, variation and processing profile.
function inventoryUpdate(inventory, targets, field) {
  if (!["quantity", "price"].includes(field))
    throw Error("Unsupported inventory field");
  const targetById = new Map(targets.map((t) => [String(t.productId), t]));
  const found = new Set();
  const products = liveProducts(inventory).map((p) => {
    const target = targetById.get(String(p.product_id));
    if (target) found.add(String(p.product_id));
    if (target && String(p.sku || "") !== target.sku)
      throw Error("Etsy SKU changed. Refresh and review again.");
    const offerings = (p.offerings || [])
      .filter((o) => !o.is_deleted)
      .map((o) => {
        if (
          target &&
          (field === "quantity"
            ? Number(o.quantity) !== target.beforeQuantity
            : money(o.price) !== target.beforePrice)
        ) {
          throw Error("Etsy price or stock changed. Refresh and review again.");
        }
        const value = target?.value;
        if (
          target &&
          (!Number.isFinite(value) ||
            (field === "quantity"
              ? !Number.isInteger(value) || value < 0
              : value <= 0))
        )
          throw Error("Invalid stock or price");
        return {
          price: field === "price" && target ? value : money(o.price),
          quantity: field === "quantity" && target ? value : Number(o.quantity),
          is_enabled: o.is_enabled,
          ...(o.readiness_state_id
            ? { readiness_state_id: o.readiness_state_id }
            : {}),
        };
      });
    return {
      sku: p.sku || "",
      property_values: (p.property_values || []).map((v) => ({
        property_id: v.property_id,
        property_name: v.property_name,
        ...(v.scale_id != null ? { scale_id: v.scale_id } : {}),
        value_ids: v.value_ids || [],
        values: v.values || [],
      })),
      offerings,
    };
  });
  if (found.size !== targetById.size)
    throw Error("Etsy variation disappeared. Refresh and review again.");
  const properties = inventory[`${field}_on_property`] || [];
  const groups = new Map();
  for (const product of products) {
    const key = JSON.stringify(
      properties.map(
        (id) =>
          product.property_values.find((v) => v.property_id === id)?.values ||
          [],
      ),
    );
    for (const o of product.offerings) {
      const value = o[field];
      if (groups.has(key) && groups.get(key) !== value)
        throw Error(
          `Etsy shares ${field} across these variations. Adjust the variation settings on Etsy before syncing different values.`,
        );
      groups.set(key, value);
    }
  }
  return {
    products,
    price_on_property: inventory.price_on_property || [],
    quantity_on_property: inventory.quantity_on_property || [],
    sku_on_property: inventory.sku_on_property || [],
    ...(inventory.readiness_state_on_property
      ? { readiness_state_on_property: inventory.readiness_state_on_property }
      : {}),
  };
}

function createWorker({ db, getConfig, now = Date.now, delay = sleep }) {
  async function client() {
    const config = getConfig();
    const ref = db.collection("etsy_order_sync_state").doc("default");
    const state = (await ref.get()).data() || {};
    if (state.accessToken) config.accessToken = state.accessToken;
    if (state.refreshToken) config.refreshToken = state.refreshToken;
    if (!config.shopId || !config.apiKey || !config.accessToken)
      throw Error("Etsy connection is not configured");
    return {
      config,
      async call(path, options = {}) {
        for (let attempt = 0; ; attempt++) {
          const response = await fetchEtsyApi(
            config,
            API + path,
            { ...options, signal: AbortSignal.timeout(30000) },
            async (tokens) => {
              await ref.set(
                {
                  accessToken: tokens.accessToken,
                  refreshToken: tokens.refreshToken,
                  tokensRefreshedAt: now(),
                },
                { merge: true },
              );
            },
          );
          if (response.status === 429 && attempt < 3) {
            await delay(
              Math.min(
                30000,
                Number(response.headers.get("retry-after") || 2) * 1000,
              ),
            );
            continue;
          }
          const json = await response.json();
          if (!response.ok) {
            const detail =
              json.error_description || json.error || JSON.stringify(json);
            throw Error(
              response.status === 403
                ? `Etsy permission denied. Listing edits require listings_w authorization. ${detail}`
                : `Etsy ${response.status}: ${detail}`,
            );
          }
          return json;
        }
      },
    };
  }
  async function observe(api, listing) {
    let inventory = null,
      inventoryError = "";
    try {
      inventory = await api.call(
        `listings/${listing.listing_id}/inventory?max_variations_supported=3`,
      );
    } catch (error) {
      inventoryError = error.message;
    }
    return {
      listingId: String(listing.listing_id),
      shopId: String(api.config.shopId),
      title: listing.title || "",
      description: listing.description || "",
      state: listing.state,
      url: listing.url || `https://www.etsy.com/listing/${listing.listing_id}`,
      currency: listing.price?.currency_code || "",
      images: (listing.images || []).map((i) => ({
        id: String(i.listing_image_id),
        url: i.url_fullxfull || i.url_570xN || "",
        rank: i.rank,
      })),
      inventory,
      inventoryError,
      observedAtMs: now(),
    };
  }
  async function saveObservation(listing) {
    await db
      .collection("etsy_listing_catalog")
      .doc(listing.listingId)
      .set(listing);
  }
  async function refresh(api, resultRef, requestId, progress) {
    const listings = new Map();
    const meta = db.collection("etsy_listing_sync").doc("state");
    await meta.set(
      { activeRequestId: requestId, startedAtMs: now(), error: "" },
      { merge: true },
    );
    const shop = await api.call(`shops/${api.config.shopId}`);
    for (const state of [
      "active",
      "inactive",
      "sold_out",
      "draft",
      "expired",
    ]) {
      for (let offset = 0; ; offset += 100) {
        const page = await api.call(
          `shops/${api.config.shopId}/listings?state=${state}&limit=100&offset=${offset}&includes=Images&sort_on=created&sort_order=asc`,
        );
        for (const listing of page.results || [])
          listings.set(String(listing.listing_id), listing);
        if ((page.results || []).length < 100) break;
      }
    }
    let completed = 0;
    for (const listing of listings.values()) {
      const observed = await observe(api, listing);
      await saveObservation(observed);
      completed++;
      await resultRef.set({ completed, total: listings.size }, { merge: true });
      if (completed % 10 === 0 || completed === listings.size)
        await progress("api_call", {
          completed,
          total: listings.size,
          success: true,
          requestType: "refresh_listings",
        });
      await delay(150);
    }
    await meta.set(
      {
        activeRequestId: "",
        listingIds: [...listings.keys()],
        currency: shop.currency_code || "",
        shopId: String(api.config.shopId),
        completedAtMs: now(),
        error: "",
      },
      { merge: true },
    );
  }
  async function sync(api, entry, field) {
    const id = String(entry.listingId);
    if (!/^\d+$/.test(id)) throw Error("Invalid Etsy listing ID");
    const listing = await api.call(`listings/${id}?includes=Images`);
    if (String(listing.shop_id) !== String(api.config.shopId))
      throw Error("Listing belongs to a different Etsy shop");
    let deactivated = false;
    const targetKeys = new Map();
    if (["quantity", "price"].includes(field)) {
      if (
        !Array.isArray(entry.targets) ||
        !entry.targets.length ||
        entry.targets.length > 400
      )
        throw Error("Missing variation changes");
      if (field === "price" && listing.price?.currency_code !== "EUR")
        throw Error("Local prices are EUR; currency differs");
      const inventory = await api.call(
        `listings/${id}/inventory?max_variations_supported=3`,
      );
      const body = inventoryUpdate(inventory, entry.targets, field);
      for (const t of entry.targets)
        targetKeys.set(
          String(t.productId),
          variationKey(
            liveProducts(inventory).find(
              (p) => String(p.product_id) === String(t.productId),
            ),
          ),
        );
      const offerings = body.products.flatMap((p) => p.offerings);
      deactivated =
        field === "quantity" &&
        offerings.length > 0 &&
        offerings.every((o) => o.quantity === 0);
      if (deactivated) {
        // Etsy rejects an all-zero inventory matrix, even for an inactive
        // listing. Remove it from sale and retain Etsy's saved quantities.
        if (listing.state === "active")
          await api.call(`shops/${api.config.shopId}/listings/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ state: "inactive" }).toString(),
          });
      } else
        await api.call(`listings/${id}/inventory?max_variations_supported=3`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
    } else if (["title", "description"].includes(field)) {
      if (listing[field] !== entry.before)
        throw Error("Etsy content changed. Refresh and review again.");
      const value = String(entry.value || "").trim();
      if (!value || (field === "title" && value.length > 140))
        throw Error(
          "Etsy title must contain 1–140 characters; description must not be empty",
        );
      await api.call(`shops/${api.config.shopId}/listings/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ [field]: value }).toString(),
      });
    } else throw Error("Unsupported Etsy sync field");
    const updated = await api.call(`listings/${id}?includes=Images`);
    const observed = await observe(api, updated);
    await saveObservation(observed);
    if (observed.inventoryError)
      throw Error(
        `Update submitted; verification failed: ${observed.inventoryError}`,
      );
    if (
      ["title", "description"].includes(field) &&
      updated[field] !== entry.value
    )
      throw Error(
        "Etsy has not returned the requested content; review the refreshed listing",
      );
    if (deactivated) {
      if (updated.state === "active")
        throw Error(
          "Etsy still reports this zero-stock listing as active; review the refreshed listing",
        );
      return {
        action: "deactivated",
        message:
          "Out of stock: listing is not for sale. Etsy retains its saved quantities; activate manually after restocking.",
      };
    }
    if (["quantity", "price"].includes(field))
      for (const t of entry.targets) {
        const matches = liveProducts(observed.inventory).filter(
          (p) => variationKey(p) === targetKeys.get(String(t.productId)),
        );
        const product = matches.length === 1 ? matches[0] : null;
        if (
          !product ||
          !product.offerings?.filter((o) => !o.is_deleted).length ||
          !product.offerings
            ?.filter((o) => !o.is_deleted)
            .every(
              (o) =>
                (field === "quantity" ? Number(o.quantity) : money(o.price)) ===
                t.value,
            )
        )
          throw Error(
            "Etsy has not returned the requested inventory; review the refreshed listing",
          );
      }
  }
  async function run(requestId, request) {
    const resultRef = db.collection("etsy_listing_results").doc(requestId);
    const progress = async (phase, payload = {}) => {
      const at = now();
      const ref = db
        .collection("sync")
        .doc(
          `etsy-listings-${requestId}-${phase}${payload.completed == null ? "" : `-${payload.completed}`}`,
        );
      const event = {
        eventType: `etsy/sync_${phase}`,
        requestId,
        creator: request.creator,
        processor: "etsy-listing-worker",
        timestamp: new Date(at),
        createdAtMs: at,
        payload: {
          mode: request.mode,
          field: request.field || "",
          ...payload,
        },
      };
      if (phase === "requested") {
        try {
          await ref.create(event);
        } catch (error) {
          if (error.code !== 6) throw error;
        }
      } else await ref.set(event);
    };
    try {
      await resultRef.create({
        creator: request.creator,
        mode: request.mode,
        field: request.field || "",
        status: "running",
        startedAtMs: now(),
        completed: 0,
      });
    } catch (error) {
      if (error.code === 6) return;
      throw error;
    }
    try {
      await progress("requested");
      await progress("claimed");
      const api = await client();
      let status = "completed";
      let finalResults = [];
      if (request.mode === "refresh")
        await refresh(api, resultRef, requestId, progress);
      else if (
        request.mode === "sync" &&
        ["quantity", "price", "title", "description"].includes(request.field) &&
        Array.isArray(request.entries) &&
        request.entries.length > 0 &&
        request.entries.length <= 100
      ) {
        const results = [];
        for (const entry of request.entries) {
          let result;
          try {
            const outcome = await sync(api, entry, request.field);
            result = { listingId: entry.listingId, success: true, ...outcome };
          } catch (error) {
            result = {
              listingId: entry.listingId,
              success: false,
              error: error.message,
            };
          }
          results.push(result);
          await resultRef.set(
            {
              completed: results.length,
              total: request.entries.length,
              results,
            },
            { merge: true },
          );
          await progress("api_call", {
            completed: results.length,
            total: request.entries.length,
            success: result.success,
            requestType: `listing_${request.field}`,
            context: { listingId: entry.listingId },
            response: result,
          });
          await delay(200);
        }
        const failures = results.filter((r) => !r.success).length;
        finalResults = results;
        status =
          failures === 0
            ? "completed"
            : failures === results.length
              ? "failed"
              : "partial_failed";
      } else throw Error("Invalid Etsy listing request");
      await resultRef.set({ status, finishedAtMs: now() }, { merge: true });
      await progress(
        status === "completed"
          ? "completed"
          : status === "partial_failed"
            ? "partial_failed"
            : "failed",
        {
          results: finalResults,
          error: finalResults
            .filter((r) => !r.success)
            .map((r) => `Etsy ${r.listingId}: ${r.error}`)
            .join("; "),
        },
      );
    } catch (error) {
      await resultRef.set(
        { status: "failed", error: error.message, finishedAtMs: now() },
        { merge: true },
      );
      await progress("failed", { error: error.message });
      if (request.mode === "refresh")
        await db
          .collection("etsy_listing_sync")
          .doc("state")
          .set({ activeRequestId: "", error: error.message }, { merge: true });
    }
  }
  return { run };
}
module.exports = { inventoryUpdate, createWorker, money };
