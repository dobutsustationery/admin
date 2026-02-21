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
    foldSyncRequests,
    sortSyncEventsAsc,
    toMs,
    type ShopifySyncEvent,
    type ShopifySyncRequestView,
  } from "$lib/shopify-sync-model";

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
  $: selectedCalls = selected
    ? [...selected.apiCalls].sort((a, b) => b.loggedAt - a.loggedAt)
    : [];
  $: selectedError = extractRequestError(selected);
  $: selectedTimeline = selected ? sortSyncEventsAsc(selected.timeline) : [];

  onMount(() => {
    const requestedFromUrl = (
      $page.url.searchParams.get("requestId") || ""
    ).trim();
    const q = query(
      collection(firestore, "shopify_sync"),
      orderBy("timestamp", "desc"),
      limit(1000),
    );
    unsubscribe = onSnapshot(
      q,
      (snap) => {
        const nextEvents = snap.docs.map((doc) => ({
          id: doc.id,
          ...(doc.data() as any),
        })) as ShopifySyncEvent[];
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
        error = e.message || "Failed loading Shopify sync events";
        loading = false;
      },
    );
  });

  onDestroy(() => {
    if (unsubscribe) unsubscribe();
  });
</script>

<div class="page">
  <h1>Shopify Sync Status</h1>

  {#if loading}
    <p>Loading sync event log...</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else}
    <div class="layout">
      <section class="list">
        <h2>Requests (Derived from Event Log)</h2>
        {#if requests.length === 0}
          <p class="empty">No requests found in `shopify_sync`.</p>
        {:else}
          {#each requests as req}
            <button
              class="request"
              class:selected={selectedRequestId === req.requestId}
              on:click={() => (selectedRequestId = req.requestId)}
            >
              <div class="row">
                <strong>{req.handle || "(missing handle)"}</strong>
                <span
                  class="status"
                  style={`color:${statusColor[req.status] || "#111827"}`}
                  >{req.status}</span
                >
              </div>
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
            <div><strong>Handle:</strong> {selected.handle || "-"}</div>
            <div>
              <strong>Status:</strong>
              <span style={`color:${statusColor[selected.status] || "#111827"}`}
                >{selected.status}</span
              >
            </div>
            <div><strong>Request ID:</strong> {selected.requestId}</div>
            <div>
              <strong>Request Event ID:</strong>
              {selected.requestEventId || "-"}
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
              {selected.result ? JSON.stringify(selected.result) : "-"}
            </div>
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
