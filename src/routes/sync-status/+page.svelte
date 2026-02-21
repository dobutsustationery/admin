<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
  import { firestore } from "$lib/firebase";

  type SyncEvent = {
    id: string;
    eventType: string;
    requestId: string;
    requestEventId?: string;
    handle?: string;
    processor?: string;
    payload?: any;
    requestedBy?: string;
    requestedAt?: number;
    source?: string;
    timestamp?: any;
    createdAtMs?: number;
    listing?: any;
    variants?: any[];
  };

  type RequestView = {
    requestId: string;
    requestEventId: string;
    handle: string;
    requestedBy: string;
    source: string;
    requestedAt: number;
    createdAtMs: number;
    processor: string;
    status: "queued" | "processing" | "success" | "partial_failed" | "failed";
    result?: any;
    apiCalls: Array<{
      eventId: string;
      requestType: string;
      endpoint: string;
      success: boolean;
      response: any;
      context: any;
      loggedAt: number;
      processor: string;
    }>;
    timeline: SyncEvent[];
  };

  let loading = true;
  let error = "";
  let events: SyncEvent[] = [];
  let requests: RequestView[] = [];
  let selectedRequestId = "";

  let unsubscribe: (() => void) | null = null;

  const statusColor: Record<string, string> = {
    queued: "#6b7280",
    processing: "#2563eb",
    success: "#059669",
    partial_failed: "#d97706",
    failed: "#dc2626",
  };

  function toMs(value: any): number {
    if (!value) return 0;
    if (typeof value === "number") return value;
    if (typeof value?.seconds === "number") return value.seconds * 1000;
    if (value?.toDate) return value.toDate().getTime();
    return 0;
  }

  function tsToString(value: any): string {
    const ms = toMs(value);
    if (!ms) return "-";
    return new Date(ms).toLocaleString();
  }

  function foldRequests(syncEvents: SyncEvent[]): RequestView[] {
    const byRequestId = new Map<string, RequestView>();

    const sortedAsc = [...syncEvents].sort((a, b) => {
      const tA = toMs(a.timestamp) || Number(a.createdAtMs || 0);
      const tB = toMs(b.timestamp) || Number(b.createdAtMs || 0);
      if (tA !== tB) return tA - tB;
      return a.id.localeCompare(b.id);
    });

    for (const ev of sortedAsc) {
      const reqId = String(ev.requestId || "").trim();
      if (!reqId) continue;

      let req = byRequestId.get(reqId);
      if (!req) {
        req = {
          requestId: reqId,
          requestEventId: "",
          handle: String(ev.handle || ""),
          requestedBy: String(ev.requestedBy || ""),
          source: String(ev.source || ""),
          requestedAt: Number(ev.requestedAt || 0),
          createdAtMs: Number(ev.createdAtMs || 0),
          processor: "",
          status: "queued",
          apiCalls: [],
          timeline: [],
        };
        byRequestId.set(reqId, req);
      }

      req.timeline.push(ev);

      if (ev.eventType === "sync_requested") {
        req.requestEventId = ev.id;
        req.handle = String(ev.handle || req.handle || "");
        req.requestedBy = String(ev.requestedBy || req.requestedBy || "");
        req.source = String(ev.source || req.source || "");
        req.requestedAt = Number(ev.requestedAt || req.requestedAt || 0);
        req.createdAtMs = Number(ev.createdAtMs || req.createdAtMs || 0);
        req.status = "queued";
      }

      if (ev.eventType === "sync_claimed") {
        req.processor = String(ev.processor || req.processor || "");
        req.status = "processing";
      }

      if (ev.eventType === "sync_api_call") {
        const payload = ev.payload || {};
        req.processor = String(ev.processor || req.processor || "");
        req.apiCalls.push({
          eventId: ev.id,
          requestType: String(payload.requestType || "api_call"),
          endpoint: String(payload.endpoint || ""),
          success: !!payload.success,
          response: payload.response,
          context: payload.context,
          loggedAt: Number(ev.createdAtMs || 0),
          processor: String(ev.processor || ""),
        });
      }

      if (ev.eventType === "sync_completed") {
        req.processor = String(ev.processor || req.processor || "");
        req.status = "success";
        req.result = ev.payload || {};
      }

      if (ev.eventType === "sync_partial_failed") {
        req.processor = String(ev.processor || req.processor || "");
        req.status = "partial_failed";
        req.result = ev.payload || {};
      }

      if (ev.eventType === "sync_failed") {
        req.processor = String(ev.processor || req.processor || "");
        req.status = "failed";
        req.result = ev.payload || {};
      }
    }

    return Array.from(byRequestId.values()).sort((a, b) => {
      const aTime = a.requestedAt || a.createdAtMs || 0;
      const bTime = b.requestedAt || b.createdAtMs || 0;
      return bTime - aTime;
    });
  }

  $: requests = foldRequests(events);
  $: selected = requests.find((r) => r.requestId === selectedRequestId) || null;
  $: selectedCalls = selected ? [...selected.apiCalls].sort((a, b) => b.loggedAt - a.loggedAt) : [];
  $: selectedTimeline = selected
    ? [...selected.timeline].sort((a, b) => {
        const tA = toMs(a.timestamp) || Number(a.createdAtMs || 0);
        const tB = toMs(b.timestamp) || Number(b.createdAtMs || 0);
        return tB - tA;
      })
    : [];

  onMount(() => {
    const q = query(collection(firestore, "shopify_sync"), orderBy("timestamp", "desc"), limit(1000));
    unsubscribe = onSnapshot(
      q,
      (snap) => {
        const nextEvents = snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as any) })) as SyncEvent[];
        events = nextEvents;
        const nextRequests = foldRequests(nextEvents);

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
            <button class="request" class:selected={selectedRequestId === req.requestId} on:click={() => (selectedRequestId = req.requestId)}>
              <div class="row">
                <strong>{req.handle || "(missing handle)"}</strong>
                <span class="status" style={`color:${statusColor[req.status] || "#111827"}`}>{req.status}</span>
              </div>
              <div class="meta">requestId: {req.requestId}</div>
              <div class="meta">requested: {tsToString(req.requestedAt || req.createdAtMs)}</div>
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
          <div class="card">
            <div><strong>Handle:</strong> {selected.handle || "-"}</div>
            <div><strong>Status:</strong> <span style={`color:${statusColor[selected.status] || "#111827"}`}>{selected.status}</span></div>
            <div><strong>Request ID:</strong> {selected.requestId}</div>
            <div><strong>Request Event ID:</strong> {selected.requestEventId || "-"}</div>
            <div><strong>Requested By:</strong> {selected.requestedBy || "-"}</div>
            <div><strong>Source:</strong> {selected.source || "-"}</div>
            <div><strong>Processor:</strong> {selected.processor || "-"}</div>
            <div><strong>Requested At:</strong> {tsToString(selected.requestedAt || selected.createdAtMs)}</div>
            <div><strong>Result:</strong> {selected.result ? JSON.stringify(selected.result) : "-"}</div>
          </div>

          <h3>API Debug Events</h3>
          {#if selectedCalls.length === 0}
            <p class="empty">No API call events yet.</p>
          {:else}
            {#each selectedCalls as call}
              <div class="log">
                <div class="row">
                  <strong>{call.requestType}</strong>
                  <span class:ok={call.success} class:fail={!call.success}>{call.success ? "success" : "failure"}</span>
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
            {#each selectedTimeline as ev}
              <div class="timeline-item">
                <div class="row">
                  <strong>{ev.eventType}</strong>
                  <span class="meta">{tsToString(ev.timestamp || ev.createdAtMs)}</span>
                </div>
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
  .page { max-width: 1500px; margin: 0 auto; padding: 1rem; }
  .layout { display: grid; grid-template-columns: 360px 1fr; gap: 1rem; }
  .list, .detail { border: 1px solid #e5e7eb; border-radius: 8px; padding: 0.75rem; background: #fff; }
  .request { display: block; width: 100%; text-align: left; border: 1px solid #e5e7eb; border-radius: 6px; padding: 0.5rem; margin-bottom: 0.5rem; background: #fff; cursor: pointer; }
  .request.selected { border-color: #2563eb; background: #eff6ff; }
  .row { display: flex; justify-content: space-between; gap: 1rem; align-items: center; }
  .status { font-weight: 600; }
  .meta { color: #4b5563; font-size: 0.85rem; word-break: break-all; }
  .card, .log, .timeline-item { border: 1px solid #e5e7eb; border-radius: 6px; padding: 0.65rem; margin-bottom: 0.75rem; background: #fafafa; }
  .ok { color: #059669; font-weight: 600; }
  .fail { color: #dc2626; font-weight: 600; }
  pre { margin-top: 0.5rem; padding: 0.5rem; background: #111827; color: #e5e7eb; border-radius: 4px; overflow-x: auto; font-size: 0.75rem; }
  .empty { color: #6b7280; }
  .error { color: #dc2626; }
  @media (max-width: 960px) { .layout { grid-template-columns: 1fr; } }
</style>
