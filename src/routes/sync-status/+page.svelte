<script lang="ts">
  import { page } from "$app/stores";
  import { onDestroy, onMount } from "svelte";
  import {
    collection,
    limit,
    onSnapshot,
    orderBy,
    query,
  } from "firebase/firestore";
  import { firestore } from "$lib/firebase";
  import {
    classifySyncRequestStatusFromEventTypes,
    foldSyncRequests,
    getSyncEventBaseType,
    inferSyncRequestDomainFromEvents,
    sortSyncEventsAsc,
    toMs,
    type ShopifySyncEvent,
    type ShopifySyncRequestView,
  } from "$lib/shopify-sync-model";
  import {
    SYNC_COLLECTION,
    toShopifySyncListenerEvent,
  } from "$lib/sync-events";

  let loading = true;
  let error = "";
  let events: ShopifySyncEvent[] = [];
  let requests: ShopifySyncRequestView[] = [];
  let folded = foldSyncRequests([]);
  let selectedRequestId = "";

  let unsubscribe: (() => void) | null = null;

  const statusColor: Record<string, string> = {
    queued: "#6b7280",
    processing: "#2563eb",
    success: "#059669",
    partial_failed: "#d97706",
    failed: "#dc2626",
  };

  type EffectiveRequestStatus =
    | "queued"
    | "processing"
    | "success"
    | "partial_failed"
    | "failed";

  function inferDomain(
    req: ShopifySyncRequestView | null,
  ): "shopify" | "photos" | "unknown" {
    if (!req) return "unknown";
    return inferSyncRequestDomainFromEvents(req.timeline || []);
  }

  function getEventBaseType(ev: ShopifySyncEvent): string {
    return getSyncEventBaseType(String(ev?.eventType || ""));
  }

  function deriveEffectiveStatus(
    req: ShopifySyncRequestView,
  ): EffectiveRequestStatus {
    const domain = inferDomain(req);
    if (domain !== "photos") return req.status;
    const timeline = sortSyncEventsAsc(req.timeline || []);
    return (
      classifySyncRequestStatusFromEventTypes(
        timeline.map((ev) => String(ev.eventType || "")),
      ) || req.status
    );
  }

  function latestTimelineEventBySuffix(
    req: ShopifySyncRequestView | null,
    suffix: string,
  ): ShopifySyncEvent | null {
    if (!req) return null;
    const timeline = sortSyncEventsAsc(req.timeline || []);
    for (let i = timeline.length - 1; i >= 0; i--) {
      if (getEventBaseType(timeline[i]) === suffix) return timeline[i];
    }
    return null;
  }

  function firstTimelineEventBySuffix(
    req: ShopifySyncRequestView | null,
    suffix: string,
  ): ShopifySyncEvent | null {
    if (!req) return null;
    const timeline = sortSyncEventsAsc(req.timeline || []);
    return timeline.find((ev) => getEventBaseType(ev) === suffix) || null;
  }

  function extractPhotosDetails(req: ShopifySyncRequestView | null) {
    const requested = firstTimelineEventBySuffix(
      req,
      "image_transfer_requested",
    );
    const started = latestTimelineEventBySuffix(req, "image_transfer_started");
    const completed = latestTimelineEventBySuffix(
      req,
      "image_transfer_completed",
    );
    const failed = latestTimelineEventBySuffix(req, "image_transfer_failed");
    const secretRequired = latestTimelineEventBySuffix(
      req,
      "image_transfer_secret_required",
    );
    const secretProvided = latestTimelineEventBySuffix(
      req,
      "image_transfer_secret_provided",
    );

    const reqPayload = (requested?.payload || {}) as any;
    const resultPayload = ((completed || failed)?.payload || {}) as any;
    const current =
      completed || failed || started || secretRequired || requested;
    const photoId =
      String(
        reqPayload?.photoId ||
          reqPayload?.sourceRef?.mediaItemId ||
          resultPayload?.photoId ||
          "",
      ).trim() || "-";
    const filename =
      String(reqPayload?.filename || resultPayload?.filename || "").trim() ||
      "-";
    const mimeType =
      String(reqPayload?.mimeType || resultPayload?.mimeType || "").trim() ||
      "-";
    const sourceType = String(reqPayload?.sourceType || "").trim() || "-";
    const targetFolderId =
      String(reqPayload?.targetFolderId || "").trim() || "-";
    const secretState =
      completed || failed
        ? secretProvided
          ? "provided"
          : secretRequired
            ? "required"
            : "-"
        : secretProvided
          ? "provided"
          : secretRequired
            ? "required"
            : "-";

    return {
      requested,
      started,
      completed,
      failed,
      secretRequired,
      secretProvided,
      current,
      photoId,
      filename,
      mimeType,
      sourceType,
      targetFolderId,
      secretState,
      resultPayload,
    };
  }

  function extractPhotoApiCalls(req: ShopifySyncRequestView | null) {
    if (!req) return [];
    return sortSyncEventsAsc(req.timeline || [])
      .filter((ev) => getEventBaseType(ev) === "image_transfer_api_call")
      .map((ev) => {
        const payload = (ev.payload || {}) as any;
        return {
          eventId: ev.id,
          requestType: String(payload.requestType || "photos_api_call"),
          endpoint: String(payload.endpoint || ""),
          success: !!payload.success,
          response: payload.response || {},
          context: payload.context || {},
          loggedAt: Number(ev.createdAtMs || toMs(ev.timestamp) || 0),
          processor: String(ev.processor || ""),
        };
      })
      .sort((a, b) => b.loggedAt - a.loggedAt);
  }

  function tsToString(value: any): string {
    const ms = toMs(value);
    if (!ms) return "-";
    return new Date(ms).toLocaleString();
  }

  function toIso(value: any): string {
    const ms = toMs(value);
    if (!ms) return "-";
    return new Date(ms).toISOString();
  }

  function tsDebug(value: any): string {
    if (!value) return "-";
    if (typeof value?.seconds === "number") {
      const nanos =
        typeof value?.nanoseconds === "number" ? value.nanoseconds : 0;
      return `${value.seconds}.${String(nanos).padStart(9, "0")}Z`;
    }
    const ms = toMs(value);
    if (!ms) return "-";
    return `${Math.floor(ms / 1000)}.${String(Math.floor((ms % 1000) * 1_000_000)).padStart(9, "0")}Z`;
  }

  function extractRequestError(req: ShopifySyncRequestView | null): string {
    if (!req) return "";
    const resultError = req.result?.error;
    if (typeof resultError === "string" && resultError.trim())
      return resultError;

    const failedApi = [...req.apiCalls]
      .sort((a, b) => b.loggedAt - a.loggedAt)
      .find(
        (call) => !call.success && typeof call.response?.error === "string",
      );

    if (failedApi?.response?.error) return String(failedApi.response.error);
    return "";
  }

  $: folded = foldSyncRequests(events);
  $: requests = folded.requestIds
    .map((requestId) => folded.requestsById[requestId])
    .filter(Boolean);
  $: selected = requests.find((r) => r.requestId === selectedRequestId) || null;
  $: selectedDomain = inferDomain(selected);
  $: selectedEffectiveStatus = selected
    ? deriveEffectiveStatus(selected)
    : "queued";
  $: selectedPhotos = extractPhotosDetails(selected);
  $: selectedCalls = selected
    ? selectedDomain === "photos"
      ? extractPhotoApiCalls(selected)
      : [...selected.apiCalls].sort((a, b) => b.loggedAt - a.loggedAt)
    : [];
  $: selectedError = extractRequestError(selected);
  $: selectedTimeline = selected ? sortSyncEventsAsc(selected.timeline) : [];

  onMount(() => {
    const requestedFromUrl = (
      $page.url.searchParams.get("requestId") || ""
    ).trim();
    const q = query(
      collection(firestore, SYNC_COLLECTION),
      orderBy("timestamp", "desc"),
      limit(1000),
    );

    unsubscribe = onSnapshot(
      q,
      (snap) => {
        const nextEvents = snap.docs.map((doc) =>
          toShopifySyncListenerEvent({
            id: doc.id,
            data: doc.data() as Record<string, any>,
          }),
        ) as ShopifySyncEvent[];
        events = nextEvents;
        const nextFolded = foldSyncRequests(nextEvents);
        const nextRequests = nextFolded.requestIds
          .map((requestId) => nextFolded.requestsById[requestId])
          .filter(Boolean);

        if (!selectedRequestId && requestedFromUrl) {
          const found = nextRequests.find(
            (r) => r.requestId === requestedFromUrl,
          );
          if (found) selectedRequestId = found.requestId;
        }

        if (!selectedRequestId && nextRequests.length > 0) {
          selectedRequestId = nextRequests[0].requestId;
        }
        if (
          selectedRequestId &&
          !nextRequests.some((r) => r.requestId === selectedRequestId) &&
          nextRequests.length > 0
        ) {
          selectedRequestId = nextRequests[0].requestId;
        }

        loading = false;
      },
      (e) => {
        error =
          e.message ||
          `Failed loading Shopify sync events from ${SYNC_COLLECTION}`;
        loading = false;
      },
    );
  });

  onDestroy(() => {
    if (unsubscribe) unsubscribe();
  });
</script>

<div class="page">
  <h1>Sync Status</h1>

  {#if loading}
    <p>Loading sync event log...</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else}
    <div class="layout">
      <section class="list">
        <h2>Requests (Derived from Event Log)</h2>
        {#if requests.length === 0}
          <p class="empty">No requests found in `sync`.</p>
        {:else}
          {#each requests as req}
            <button
              class="request"
              class:selected={selectedRequestId === req.requestId}
              on:click={() => (selectedRequestId = req.requestId)}
            >
              <div class="row">
                <strong>
                  {#if inferDomain(req) === "photos"}
                    {extractPhotosDetails(req).filename !== "-"
                      ? extractPhotosDetails(req).filename
                      : `photo ${extractPhotosDetails(req).photoId}`}
                  {:else}
                    {req.handle || "(missing handle)"}
                  {/if}
                </strong>
                <span
                  class="status"
                  style={`color:${statusColor[deriveEffectiveStatus(req)] || "#111827"}`}
                  >{deriveEffectiveStatus(req)}</span
                >
              </div>
              <div class="meta">domain: {inferDomain(req)}</div>
              <div class="meta">requestId: {req.requestId}</div>
              <div class="meta">
                requested: {tsToString(req.requestedAt || req.createdAtMs)}
              </div>
              <div class="meta">processor: {req.processor || "-"}</div>
            </button>
          {/each}
        {/if}
      </section>

      <section class="detail">
        <h2>Details</h2>
        {#if !selected}
          <p class="empty">Select a request.</p>
        {:else}
          {#if selectedError}
            <div class="error-banner">
              <strong>Error:</strong>
              {selectedError}
            </div>
          {/if}

          <div class="card">
            <div><strong>Domain:</strong> {selectedDomain}</div>
            {#if selectedDomain === "photos"}
              <div><strong>Photo ID:</strong> {selectedPhotos.photoId}</div>
              <div><strong>Filename:</strong> {selectedPhotos.filename}</div>
              <div><strong>MIME Type:</strong> {selectedPhotos.mimeType}</div>
              <div>
                <strong>Source Type:</strong>
                {selectedPhotos.sourceType}
              </div>
              <div>
                <strong>Target Folder ID:</strong>
                {selectedPhotos.targetFolderId}
              </div>
              <div>
                <strong>Secret State:</strong>
                {selectedPhotos.secretState}
              </div>
            {:else}
              <div><strong>Handle:</strong> {selected.handle || "-"}</div>
            {/if}
            <div>
              <strong>Status:</strong>
              <span
                style={`color:${statusColor[selectedEffectiveStatus] || "#111827"}`}
                >{selectedEffectiveStatus}</span
              >
            </div>
            <div><strong>Request ID:</strong> {selected.requestId}</div>
            <div>
              <strong>Request Event ID:</strong>
              {selected.requestEventId ||
                (selectedDomain === "photos"
                  ? selectedPhotos.requested?.id || "-"
                  : "-")}
            </div>
            <div>
              <strong>Requested By:</strong>
              {selected.requestedBy || "-"}
            </div>
            <div><strong>Source:</strong> {selected.source || "-"}</div>
            <div><strong>Processor:</strong> {selected.processor || "-"}</div>
            <div>
              <strong>Requested At:</strong>
              {tsToString(selected.requestedAt || selected.createdAtMs)}
            </div>
            <div>
              <strong>Result:</strong>
              {#if selectedDomain === "photos"}
                {#if selectedPhotos.completed}
                  {JSON.stringify(selectedPhotos.resultPayload)}
                {:else if selectedPhotos.failed}
                  {JSON.stringify(selectedPhotos.resultPayload)}
                {:else}
                  -
                {/if}
              {:else}
                {selected.result ? JSON.stringify(selected.result) : "-"}
              {/if}
            </div>
            {#if selectedDomain === "photos" && selectedPhotos.resultPayload?.permanentUrl}
              <div>
                <strong>Permanent URL:</strong>
                <a
                  href={selectedPhotos.resultPayload.permanentUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {selectedPhotos.resultPayload.permanentUrl}
                </a>
              </div>
            {/if}
          </div>

          <h3>API Debug Events</h3>
          {#if selectedCalls.length === 0}
            <p class="empty">No API call events yet.</p>
          {:else}
            {#each selectedCalls as call}
              <div class="log">
                <div class="row">
                  <strong>{call.requestType}</strong>
                  <span class:ok={call.success} class:fail={!call.success}
                    >{call.success ? "success" : "failure"}</span
                  >
                </div>
                <div class="meta">endpoint: {call.endpoint}</div>
                <div class="meta">processor: {call.processor || "-"}</div>
                <pre>{JSON.stringify(call.context || {}, null, 2)}</pre>
                <pre>{JSON.stringify(call.response || {}, null, 2)}</pre>
              </div>
            {/each}
          {/if}

          <h3>Raw Timeline</h3>
          {#if selectedTimeline.length === 0}
            <p class="empty">No timeline events.</p>
          {:else}
            {#each selectedTimeline as ev, i}
              <div class="timeline-item">
                <div class="row">
                  <strong>{i + 1}. {ev.eventType}</strong>
                  <span class="meta">server: {toIso(ev.timestamp)}</span>
                </div>
                <div class="meta">server raw: {tsDebug(ev.timestamp)}</div>
                <div class="meta">eventId: {ev.id}</div>
                <pre>{JSON.stringify(ev, null, 2)}</pre>
              </div>
            {/each}
          {/if}
        {/if}
      </section>
    </div>
  {/if}
</div>

<style>
  .page {
    max-width: 1500px;
    margin: 0 auto;
    padding: 1rem;
  }
  .layout {
    display: grid;
    grid-template-columns: 360px minmax(0, 1fr);
    gap: 1rem;
    min-width: 0;
  }
  .list,
  .detail {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 0.75rem;
    background: #fff;
    min-width: 0;
  }
  .request {
    display: block;
    width: 100%;
    text-align: left;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 0.5rem;
    margin-bottom: 0.5rem;
    background: #fff;
    cursor: pointer;
  }
  .request.selected {
    border-color: #2563eb;
    background: #eff6ff;
  }
  .row {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: center;
  }
  .status {
    font-weight: 600;
  }
  .meta {
    color: #4b5563;
    font-size: 0.85rem;
    word-break: break-all;
  }
  .card,
  .log,
  .timeline-item {
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 0.65rem;
    margin-bottom: 0.75rem;
    background: #fafafa;
    overflow: hidden;
    min-width: 0;
  }
  .error-banner {
    border: 1px solid #fecaca;
    background: #fef2f2;
    color: #991b1b;
    border-radius: 6px;
    padding: 0.65rem;
    margin-bottom: 0.75rem;
  }
  .ok {
    color: #059669;
    font-weight: 600;
  }
  .fail {
    color: #dc2626;
    font-weight: 600;
  }
  pre {
    margin-top: 0.5rem;
    padding: 0.5rem;
    background: #111827;
    color: #e5e7eb;
    border-radius: 4px;
    font-size: 0.75rem;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    overflow: auto;
    max-height: 320px;
  }
  .empty {
    color: #6b7280;
  }
  .error {
    color: #dc2626;
  }
  @media (max-width: 960px) {
    .layout {
      grid-template-columns: 1fr;
    }
  }
</style>
