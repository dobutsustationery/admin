<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import HedgehogPatrolLane from "$lib/components/HedgehogPatrolLane.svelte";
  import type { SyncQueueState } from "$lib/sync-queue-slice";

  export let syncQueue: SyncQueueState;

  $: queued = syncQueue?.queuedCount || 0;
  $: processing = syncQueue?.processingCount || 0;
  $: failedRecent = syncQueue?.failedRecentCount || 0;
  $: completedRecent = syncQueue?.completedRecentCount || 0;
  $: activeTotal = queued + processing;
  $: hasActiveWork = activeTotal > 0;
  $: currentJob = syncQueue?.currentJob || null;

  $: queueProgress =
    activeTotal === 0 ? 0 : Math.round((processing / activeTotal) * 100);
  $: showBarberPole = processing > 0;
  $: visible = hasActiveWork || celebrationPhase !== "idle";

  type CelebrationPhase = "idle" | "expanding" | "victory";
  let celebrationPhase: CelebrationPhase = "idle";
  let celebrationReason = "";
  let previousHasActiveWork = false;
  let rootEl: HTMLElement;
  let statusCardEl: HTMLDivElement;
  let measuredBarHeightPx = 0;
  let celebrationHeightPx = 0;
  let laneRenderWidthPx: number | null = null;
  let expandTimer: ReturnType<typeof setTimeout> | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  const EXPAND_MS = 3000;
  const VICTORY_MS = 7000;

  function clearCelebrationTimers() {
    if (expandTimer) clearTimeout(expandTimer);
    if (finishTimer) clearTimeout(finishTimer);
    expandTimer = null;
    finishTimer = null;
  }

  function startCelebration() {
    clearCelebrationTimers();
    celebrationHeightPx =
      measuredBarHeightPx || statusCardEl?.offsetHeight || rootEl?.offsetHeight || 96;
    celebrationReason =
      failedRecent > 0
        ? `Queue drained with ${failedRecent} recent failure${failedRecent === 1 ? "" : "s"}`
        : "All Done!";
    celebrationPhase = "expanding";
    expandTimer = setTimeout(() => {
      celebrationPhase = "victory";
      finishTimer = setTimeout(() => {
        celebrationPhase = "idle";
      }, VICTORY_MS);
    }, EXPAND_MS);
  }

  $: {
    if (hasActiveWork && celebrationPhase !== "idle") {
      clearCelebrationTimers();
      celebrationPhase = "idle";
    }
    if (previousHasActiveWork && !hasActiveWork) {
      startCelebration();
    }
    previousHasActiveWork = hasActiveWork;
  }

  onDestroy(() => {
    clearCelebrationTimers();
  });

  onMount(() => {
    const updateMeasuredHeight = () => {
      measuredBarHeightPx = Math.max(
        92,
        statusCardEl?.offsetHeight || rootEl?.offsetHeight || measuredBarHeightPx || 0,
      );
    };
    const updateLaneRenderWidth = () => {
      const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 0;
      laneRenderWidthPx = Math.max(220, viewportWidth - 24);
    };

    updateMeasuredHeight();
    updateLaneRenderWidth();
    const ro = new ResizeObserver(updateMeasuredHeight);
    if (rootEl) ro.observe(rootEl);
    if (statusCardEl) ro.observe(statusCardEl);
    window.addEventListener("resize", updateLaneRenderWidth);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", updateLaneRenderWidth);
    };
  });

  function prettyDomain(domain: string): string {
    if (!domain) return "sync";
    return domain.replace(/_/g, " ");
  }

  function prettyEventType(eventType: string): string {
    if (!eventType) return "working";
    const tail = eventType.includes("/") ? eventType.split("/")[1] : eventType;
    return tail.replace(/_/g, " ");
  }
</script>

{#if visible}
  <section
    bind:this={rootEl}
    class="sync-status-shell"
    class:is-celebrating={celebrationPhase !== "idle"}
    class:phase-expanding={celebrationPhase === "expanding"}
    class:phase-victory={celebrationPhase === "victory"}
    style={`${measuredBarHeightPx ? `--bar-height:${measuredBarHeightPx}px;` : ""}${celebrationPhase !== "idle" && celebrationHeightPx ? `--celebrate-height:${celebrationHeightPx}px;` : ""}`}
    aria-live="polite"
    aria-label="Sync queue status"
  >
    <div class="lane-wrap">
      <HedgehogPatrolLane
        active={visible}
        celebrate={celebrationPhase !== "idle"}
        phase={celebrationPhase}
        lockedRenderWidthPx={celebrationPhase === "idle" ? null : laneRenderWidthPx}
      />

      {#if celebrationPhase === "victory"}
        <div class="victory-overlay" aria-hidden="true">
          <div class="victory-trail">
            <div class="victory-banner">{celebrationReason}</div>
          </div>
        </div>
      {/if}
    </div>

    <div class="status-card" bind:this={statusCardEl}>
      <div class="status-row">
        <div class="title-wrap">
          <div class="eyebrow">Sync Patrol</div>
          <div class="title">
            {#if currentJob}
              {prettyDomain(currentJob.domain)}: {prettyEventType(
                currentJob.latestEventType,
              )}
            {:else}
              Processing sync queue
            {/if}
          </div>
        </div>
        <div class="badge-cluster">
          <a class="open-link" href="/sync-status">Open Queue</a>
          <span class="badge badge-processing">{processing} active</span>
          <span class="badge badge-queued">{queued} queued</span>
          {#if failedRecent > 0}
            <span class="badge badge-failed">{failedRecent} recent failed</span>
          {/if}
        </div>
      </div>

      <div class="meter-wrap">
        <div class="meter-label-row">
          <span>Queue meter</span>
          <span>{processing} processing / {activeTotal} active</span>
        </div>
        <div
          class="meter"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={queueProgress}
          aria-valuetext={`${processing} processing and ${queued} queued jobs`}
        >
          <div
            class="meter-segment meter-processing"
            style={`width:${activeTotal ? (processing / activeTotal) * 100 : 0}%`}
          ></div>
          <div
            class="meter-segment meter-queued"
            style={`width:${activeTotal ? (queued / activeTotal) * 100 : 0}%`}
          ></div>
          {#if showBarberPole}
            <div class="meter-barber"></div>
          {/if}
        </div>
      </div>

      <div class="meta-row">
        <div>
          {#if currentJob}
            <strong>{currentJob.requestId}</strong>
            {#if currentJob.processor}
              <span class="muted"> • {currentJob.processor}</span>
            {/if}
          {:else}
            <span class="muted">Waiting for next claim...</span>
          {/if}
        </div>
        <div class="muted">
          {completedRecent} recent complete / {syncQueue.totalKnownJobs} seen
        </div>
      </div>
    </div>
  </section>
{/if}

<style>
  .sync-status-shell {
    --hedgehog-w: 132px;
    position: relative;
    display: flex;
    gap: 0.5rem;
    align-items: stretch;
    margin: 0 0 0.75rem 0;
    transition:
      max-width 3000ms ease,
      gap 1200ms ease;
  }

  .lane-wrap {
    position: relative;
    min-width: 0;
    flex: 0 0 var(--hedgehog-w);
    transition:
      flex-basis 3000ms cubic-bezier(0.2, 0.9, 0.18, 1),
      max-width 3000ms cubic-bezier(0.2, 0.9, 0.18, 1);
    height: var(--bar-height, auto);
    min-height: var(--bar-height, 92px);
  }

  .status-card {
    min-width: 0;
    flex: 1 1 auto;
    padding: 0.8rem 1rem 0.85rem;
    border-radius: 24px;
    border: 1px solid rgba(255, 255, 255, 0.68);
    background:
      radial-gradient(
        circle at 12% -8%,
        rgba(255, 255, 255, 0.95),
        transparent 55%
      ),
      linear-gradient(
        180deg,
        rgba(255, 255, 255, 0.88) 0%,
        rgba(247, 251, 241, 0.9) 100%
      );
    backdrop-filter: blur(8px);
    box-shadow:
      0 15px 35px rgba(139, 90, 43, 0.12),
      inset 0 1px 0 rgba(255, 255, 255, 0.7);
    transition:
      opacity 700ms ease,
      transform 900ms ease,
      max-width 900ms ease,
      margin 900ms ease,
      padding 900ms ease;
  }

  .status-row {
    display: flex;
    gap: 0.75rem;
    align-items: flex-start;
    justify-content: space-between;
  }

  .title-wrap {
    min-width: 0;
  }

  .eyebrow {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #8b5a2b;
    font-weight: 700;
  }

  .title {
    margin-top: 0.08rem;
    font-size: 1rem;
    font-weight: 700;
    color: #3b2f1d;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .badge-cluster {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.35rem;
    align-items: center;
  }

  .open-link {
    font-size: 0.72rem;
    font-weight: 700;
    color: #92400e;
    background: rgba(255, 255, 255, 0.7);
    border: 1px solid #f3d38b;
    border-radius: 999px;
    padding: 0.18rem 0.5rem;
    text-decoration: none;
    transition: background-color 120ms ease;
  }

  .open-link:hover {
    background: rgba(255, 255, 255, 0.95);
  }

  .badge {
    font-size: 0.72rem;
    font-weight: 700;
    border-radius: 999px;
    padding: 0.18rem 0.45rem;
    border: 1px solid transparent;
    white-space: nowrap;
  }

  .badge-processing {
    background: #dbeafe;
    color: #1e40af;
    border-color: #bfdbfe;
  }

  .badge-queued {
    background: #fef3c7;
    color: #92400e;
    border-color: #fde68a;
  }

  .badge-failed {
    background: #fee2e2;
    color: #991b1b;
    border-color: #fecaca;
  }

  .meter-wrap {
    margin-top: 0.55rem;
  }

  .meter-label-row {
    margin-bottom: 0.2rem;
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    font-size: 0.72rem;
    color: #786353;
    font-weight: 600;
  }

  .meter {
    position: relative;
    height: 12px;
    width: 100%;
    display: flex;
    border-radius: 999px;
    overflow: hidden;
    background: #f4efdc;
    border: 1px solid #eadbb8;
    box-shadow: inset 0 1px 2px rgba(120, 53, 15, 0.08);
  }

  .meter-segment {
    height: 100%;
    transition: width 180ms ease;
    position: relative;
    z-index: 1;
  }

  .meter-processing {
    background: linear-gradient(
      90deg,
      rgba(59, 130, 246, 0.95),
      rgba(37, 99, 235, 0.95)
    );
  }

  .meter-queued {
    background: repeating-linear-gradient(
      120deg,
      rgba(245, 158, 11, 0.9) 0,
      rgba(245, 158, 11, 0.9) 8px,
      rgba(251, 191, 36, 0.9) 8px,
      rgba(251, 191, 36, 0.9) 16px
    );
  }

  .meter-barber {
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
    background: repeating-linear-gradient(
      120deg,
      rgba(255, 255, 255, 0) 0 6px,
      rgba(255, 255, 255, 0.22) 6px 12px,
      rgba(255, 255, 255, 0) 12px 18px
    );
    animation: barber 700ms linear infinite;
  }

  .victory-overlay {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }

  .victory-trail {
    position: absolute;
    left: 2.5rem;
    top: 0.65rem;
    display: flex;
    align-items: center;
    will-change: transform;
  }

  .victory-banner {
    font-weight: 800;
    letter-spacing: 0.02em;
    color: #7c2d12;
    background: rgba(255, 255, 255, 0.86);
    border: 1px solid rgba(255, 255, 255, 0.9);
    border-radius: 999px;
    padding: 0.35rem 0.7rem;
    box-shadow: 0 10px 24px rgba(124, 45, 18, 0.12);
    white-space: nowrap;
    animation: banner-bob 260ms ease-in-out infinite alternate;
  }

  .sync-status-shell.is-celebrating {
    gap: 0.35rem;
    max-width: none;
    min-height: var(--celebrate-height, 96px);
  }

  .sync-status-shell.is-celebrating .status-card {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: max(0px, calc(100% - var(--hedgehog-w) - 0.35rem));
    max-width: 0;
    overflow: hidden;
    height: var(--celebrate-height, var(--bar-height, 96px));
    padding-left: 0;
    padding-right: 0;
    margin-left: 0;
    margin-right: 0;
    border-width: 0;
  }

  .sync-status-shell.phase-expanding .status-card,
  .sync-status-shell.phase-victory .status-card {
    opacity: 0;
    transform: translateX(28px) scale(0.98);
    pointer-events: none;
  }

  .sync-status-shell.phase-expanding .lane-wrap,
  .sync-status-shell.phase-victory .lane-wrap {
    flex-basis: min(calc(100vw - 2.5rem), 100%);
    max-width: min(calc(100vw - 2.5rem), 100%);
    height: var(--celebrate-height, var(--bar-height, 96px));
  }

  .lane-wrap :global(.patrol-lane),
  .lane-wrap :global(.canvas-wrap) {
    height: 100% !important;
    min-height: 100% !important;
  }

  .sync-status-shell.phase-victory .victory-trail {
    animation: victory-banner-runoff 7s cubic-bezier(0.2, 0.85, 0.15, 1) both;
  }

  .meta-row {
    margin-top: 0.52rem;
    display: flex;
    gap: 0.75rem;
    justify-content: space-between;
    align-items: center;
    font-size: 0.78rem;
    color: #4b5563;
  }

  .meta-row > div {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .muted {
    color: #64748b;
  }

  @keyframes barber {
    from {
      background-position: 0 0;
    }
    to {
      background-position: 18px 0;
    }
  }

  @keyframes victory-banner-runoff {
    0% {
      transform: translateX(0) translateY(0);
    }
    32% {
      transform: translateX(34vw) translateY(-2px);
    }
    55% {
      transform: translateX(56vw) translateY(-9px);
    }
    72% {
      transform: translateX(76vw) translateY(1px);
    }
    100% {
      transform: translateX(112vw) translateY(-7px);
    }
  }

  @keyframes banner-bob {
    from {
      transform: translateY(0);
    }
    to {
      transform: translateY(-2px);
    }
  }

  @media (max-width: 768px) {
    .sync-status-shell {
      flex-direction: column;
    }

    .status-card {
      border-radius: 20px;
      padding: 0.75rem 0.85rem 0.8rem;
    }

    .lane-wrap {
      flex-basis: auto;
      max-width: none;
      height: auto;
      min-height: 70px;
    }

    .sync-status-shell.phase-expanding .lane-wrap,
    .sync-status-shell.phase-victory .lane-wrap {
      flex-basis: auto;
      max-width: none;
      height: auto;
    }

    .victory-banner {
      font-size: 0.84rem;
      padding: 0.3rem 0.55rem;
    }

    .status-row,
    .meta-row {
      flex-direction: column;
      align-items: flex-start;
    }

    .badge-cluster {
      justify-content: flex-start;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .meter-barber {
      animation: none;
    }

    .victory-trail,
    .victory-banner {
      animation: none !important;
    }
  }
</style>
