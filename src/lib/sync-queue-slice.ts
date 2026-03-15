import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import {
  classifySyncRequestStatusFromEventTypes,
  inferSyncRequestDomainFromEvents,
  toMs,
} from "./shopify-sync-model";

export type SyncEvent = {
  id: string;
  eventType: string;
  requestId?: string;
  creator?: string;
  processor?: string;
  payload?: any;
  timestamp?: any;
  createdAtMs?: number;
};

export type SyncJobStatus = "queued" | "processing" | "completed" | "failed";

export type SyncJobSummary = {
  requestId: string;
  eventType: string;
  domain: "shopify" | "photos" | "google" | "unknown";
  status: SyncJobStatus;
  creator: string;
  processor: string;
  createdAtMs: number;
  updatedAtMs: number;
  latestEventType: string;
};

export type SyncQueueState = {
  eventsById: Record<string, SyncEvent>;
  queuedCount: number;
  processingCount: number;
  completedRecentCount: number;
  failedRecentCount: number;
  totalKnownJobs: number;
  currentJob: SyncJobSummary | null;
  jobsById: Record<string, SyncJobSummary>;
  activeJobIds: string[];
  lastUpdatedAtMs: number;
};

const initialState: SyncQueueState = {
  eventsById: {},
  queuedCount: 0,
  processingCount: 0,
  completedRecentCount: 0,
  failedRecentCount: 0,
  totalKnownJobs: 0,
  currentJob: null,
  jobsById: {},
  activeJobIds: [],
  lastUpdatedAtMs: 0,
};

function eventTimeMs(ev: SyncEvent): number {
  return toMs(ev.timestamp) || Number(ev.createdAtMs || 0);
}

function classifyJobStatus(
  eventTypes: string[],
  lastEventTimeMs?: number,
): SyncJobStatus | null {
  const status = classifySyncRequestStatusFromEventTypes(
    eventTypes,
    lastEventTimeMs,
  );
  if (status === "success") return "completed";
  if (status === "queued" || status === "processing" || status === "failed") {
    return status;
  }
  if (status === "partial_failed") return "failed";
  return null;
}

function buildQueueState(events: SyncEvent[]): Omit<
  SyncQueueState,
  "eventsById"
> & {
  eventsById: Record<string, SyncEvent>;
} {
  const eventsById: Record<string, SyncEvent> = {};
  const sortedAsc = [...events]
    .filter((e) => !!e?.id)
    .sort((a, b) => {
      const d = eventTimeMs(a) - eventTimeMs(b);
      if (d !== 0) return d;
      return String(a.id).localeCompare(String(b.id));
    });

  for (const ev of sortedAsc) eventsById[ev.id] = ev;

  const grouped = new Map<string, SyncEvent[]>();
  for (const ev of sortedAsc) {
    const requestId = String(ev.requestId || "").trim();
    if (!requestId) continue;
    if (!grouped.has(requestId)) grouped.set(requestId, []);
    grouped.get(requestId)!.push(ev);
  }

  const jobsById: Record<string, SyncJobSummary> = {};
  let queuedCount = 0;
  let processingCount = 0;
  let completedRecentCount = 0;
  let failedRecentCount = 0;
  const now =
    sortedAsc.length > 0 ? eventTimeMs(sortedAsc[sortedAsc.length - 1]) : 0;
  const recentWindowMs = 5 * 60_000;

  for (const [requestId, jobEvents] of grouped.entries()) {
    const latest = jobEvents[jobEvents.length - 1];
    const eventTypes = jobEvents.map((e) => String(e.eventType || ""));
    const updatedAtMs = eventTimeMs(latest);
    const status = classifyJobStatus(eventTypes, updatedAtMs);
    if (!status) continue;

    const createdAtMs = eventTimeMs(jobEvents[0]);
    const eventType = String(jobEvents[0]?.eventType || "");
    const domain = inferSyncRequestDomainFromEvents(jobEvents);
    const summary: SyncJobSummary = {
      requestId,
      eventType,
      domain,
      status,
      creator: String(latest.creator || jobEvents[0]?.creator || ""),
      processor: String(latest.processor || ""),
      createdAtMs,
      updatedAtMs,
      latestEventType: String(latest.eventType || ""),
    };

    jobsById[requestId] = summary;

    if (status === "queued") queuedCount += 1;
    if (status === "processing") processingCount += 1;
    if (status === "completed" && now - updatedAtMs <= recentWindowMs) {
      completedRecentCount += 1;
    }
    if (status === "failed" && now - updatedAtMs <= recentWindowMs) {
      failedRecentCount += 1;
    }
  }

  const activeJobs = Object.values(jobsById)
    .filter((j) => j.status === "queued" || j.status === "processing")
    .sort((a, b) => {
      // Prioritize in-flight work, then oldest queued work.
      if (a.status !== b.status) {
        if (a.status === "processing") return -1;
        if (b.status === "processing") return 1;
      }
      return a.createdAtMs - b.createdAtMs;
    });

  return {
    eventsById,
    queuedCount,
    processingCount,
    completedRecentCount,
    failedRecentCount,
    totalKnownJobs: Object.keys(jobsById).length,
    currentJob: activeJobs[0] || null,
    jobsById,
    activeJobIds: activeJobs.map((j) => j.requestId),
    lastUpdatedAtMs: now,
  };
}

const slice = createSlice({
  name: "syncQueue",
  initialState,
  reducers: {
    replace_sync_events(state, action: PayloadAction<SyncEvent[]>) {
      const next = buildQueueState(action.payload || []);
      state.eventsById = next.eventsById;
      state.queuedCount = next.queuedCount;
      state.processingCount = next.processingCount;
      state.completedRecentCount = next.completedRecentCount;
      state.failedRecentCount = next.failedRecentCount;
      state.totalKnownJobs = next.totalKnownJobs;
      state.currentJob = next.currentJob;
      state.jobsById = next.jobsById;
      state.activeJobIds = next.activeJobIds;
      state.lastUpdatedAtMs = next.lastUpdatedAtMs;
    },
    reset_sync_queue_state() {
      return initialState;
    },
  },
});

export const { replace_sync_events, reset_sync_queue_state } = slice.actions;
export const syncQueue = slice.reducer;
