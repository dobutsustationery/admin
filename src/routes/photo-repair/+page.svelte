<script lang="ts">
  import {
    stockedPhotoTasks,
    taskAssessment,
    photoNeedsWork,
    taskForEntry,
    preferredStockEntry,
    type PhotoAudit,
    type StockPhotoTask,
  } from "$lib/photo-repair-scope";
  import { onMount, onDestroy } from "svelte";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import SecureImage from "$lib/components/SecureImage.svelte";
  import ProcessingConfigModal from "$lib/components/ProcessingConfigModal.svelte";
  import type { ProcessingConfig } from "$lib/photos-slice";
  import ManualCropModal from "$lib/components/ManualCropModal.svelte";
  import { getStoredToken as getDriveToken } from "$lib/google-drive";
  import {
    createPickerSession,
    pollPickerSession,
    listSessionMediaItems,
    initiateOAuthFlow,
    type MediaItem,
  } from "$lib/google-photos";
  import {
    seedRepairQueue,
    loadPhotoAudit,
    useExistingRepairSource,
    reviewStockPhoto,
    importRepairOriginal,
    repairEvent,
    startRepairAttempt,
    queueNextStep,
    approveRepair,
    publishRepair,
    saveManualRepair,
  } from "$lib/photo-repair-client";
  import {
    initialPhotoRepair,
    repairStatus,
    originalFor,
    candidateFor,
    entryDetails,
    allImageTargets,
    imageKey,
    stepOutput,
    type EntryRecord,
    type PhotoRepairState,
    type Step,
  } from "$lib/photo-repair";
  let busy = false,
    error = "",
    message = "",
    query = "",
    filter = "All",
    activeId = "";
  let mode = "Needs photos";
  let audit: PhotoAudit | undefined;
  let selected = new Set<string>(),
    picked: MediaItem[] = [],
    selecting = false;
  let pickerHref = "";
  let configureOpen = false;
  let order = ["color_correct", "remove_bg", "smart_crop"];
  $: processingConfig = {
    steps: order.map((kind) => ({
      type:
        kind === "remove_bg"
          ? "remove_background"
          : kind === "smart_crop"
            ? "crop"
            : "color_correct",
      enabled:
        kind === "remove_bg"
          ? background
          : kind === "smart_crop"
            ? smartCrop
            : color,
    })),
  } as ProcessingConfig;
  function configure(event: CustomEvent<ProcessingConfig>) {
    order = event.detail.steps.map((s) =>
      s.type === "remove_background"
        ? "remove_bg"
        : s.type === "crop"
          ? "smart_crop"
          : s.type,
    );
    color = event.detail.steps.some(
      (s) => s.type === "color_correct" && s.enabled,
    );
    background = event.detail.steps.some(
      (s) => s.type === "remove_background" && s.enabled,
    );
    smartCrop = event.detail.steps.some((s) => s.type === "crop" && s.enabled);
  }
  let color = true,
    background = true,
    smartCrop = false,
    startAt = "original";
  let cropOpen = false,
    cropUrl = "",
    cropParent: string | undefined,
    cropIndex: number | undefined;
  let stopPicker = () => {};
  let stopped = false,
    ticking = false;
  $: repair = ($store.photoRepair || initialPhotoRepair) as PhotoRepairState;
  $: entries = Object.values(repair.entriesById) as EntryRecord[];
  $: tasks = $store.inventory.initialized
    ? stockedPhotoTasks($store, audit)
    : [];
  $: assessed = tasks.map((task) => ({
    task,
    assessment: taskAssessment($store, task),
  }));
  $: stockedItems = new Set(tasks.flatMap((t) => t.itemKeys)).size;
  $: skipped = assessed.filter((r) =>
    ["Repaired", "Photo is good", "Good size"].includes(r.assessment),
  ).length;
  $: notChecked = assessed.filter((r) => r.assessment === "Not checked").length;
  $: rows = entries
    .flatMap((e) => {
      if (mode === "Other stocked photos") return [];
      const task = taskForEntry($store, e, tasks, audit);
      const assessment = task
        ? taskAssessment($store, task)
        : "Not currently used by a stocked item";
      const status = repairStatus(repair, e);
      const keep =
        mode === "Saved work"
          ? e.attemptIds.length > 0 ||
            originalFor(repair, e) ||
            e.approvalId ||
            e.later ||
            status === "Photo is good"
          : task &&
            photoNeedsWork(assessment) &&
            !e.approvalId &&
            status !== "Photo is good";
      if (!keep) return [];
      if (
        mode !== "Saved work" &&
        task &&
        preferredStockEntry($store, task, audit)?.entryId !== e.entryId
      )
        return [];
      const details = task
        ? {
            ...task,
            filename:
              $store.photos.registry[e.existingPhotoId || ""]?.filename || "",
          }
        : entryDetails($store, e);
      return [{ e, task, assessment, details, status }];
    })
    .sort(
      (a, b) =>
        b.details.stock - a.details.stock ||
        a.details.title.localeCompare(b.details.title),
    );
  $: visible = rows.filter(
    (r) =>
      (filter === "All" || r.status === filter) &&
      `${r.details.title} ${r.details.jans} ${r.details.filename}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  $: otherPhotos = assessed.filter((r) =>
    `${r.task.title} ${r.task.jans}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  $: active = repair.entriesById[activeId] as EntryRecord | undefined;
  $: activeTask = active
    ? taskForEntry($store, active, tasks, audit)
    : undefined;
  $: details = active
    ? activeTask
      ? { ...entryDetails($store, active), ...activeTask }
      : entryDetails($store, active)
    : undefined;
  $: existingPhotos = activeTask
    ? [
        ...new Map(
          Object.entries($store.photos.janCodeToPhotos)
            .filter(([groupKey]) =>
              activeTask.itemKeys.some((key) => {
                const item = $store.inventory.idToItem[key];
                return (
                  groupKey === key ||
                  groupKey === item.janCode ||
                  groupKey.startsWith(item.janCode + ":")
                );
              }),
            )
            .flatMap(([, photos]) => photos as MediaItem[])
            .filter(
              (photo) =>
                photo.baseUrl &&
                (!photo.baseUrl.includes("googleusercontent.com") ||
                  photo.baseUrl.includes("/d/")),
            )
            .map((photo) => [photo.baseUrl, photo]),
        ).values(),
      ]
    : [];
  $: original = active ? originalFor(repair, active) : undefined;
  $: candidate = active ? candidateFor(repair, active) : undefined;
  $: attempt = active
    ? repair.attemptsById[active.selectedAttemptId || ""]
    : undefined;
  $: historyAttempts = active
    ? active.attemptIds
        .map((id) => repair.attemptsById[id])
        .filter((a) => a.importId === original?.importId)
    : [];
  $: uses = active
    ? [...new Set(active.targets.map(useLabel).filter(Boolean))]
    : [];
  function useLabel(t: any): string {
    const r = t.ref;
    if (r.kind === "listing_image" || r.kind === "listing_new_image") {
      const listing = $store.listings.handleToListing[r.handle];
      const image = listing?.images.find((i: any) => i.id === r.imageId);
      if (r.kind === "listing_new_image")
        return `${listing?.title || r.handle} — new gallery image`;
      return `${listing?.title || r.handle} — gallery image ${image?.position || ""}`;
    }
    if (r.kind === "inventory") {
      const item = $store.inventory.idToItem[r.itemKey];
      return `${item?.description || r.itemKey}${item?.subtype ? ` (${item.subtype})` : ""} — variant image`;
    }
    if (r.kind === "proposal_image" || r.kind === "proposal_variant") {
      const proposal = $store.listingCreation.proposals[r.proposalKey];
      return `${proposal?.title || r.proposalKey} — draft ${r.kind === "proposal_image" ? "gallery" : "variant"} image`;
    }
    if (r.kind === "photo_group") return `Photo group ${r.groupKey}`;
    return "";
  }
  $: state = active ? repairStatus(repair, active) : "";
  $: failures = attempt
    ? Object.values(attempt.runsByStep)
        .map((r) => r.requestsById[r.currentRequestId]?.result?.message)
        .filter(Boolean)
    : [];
  $: activeApprovals = active
    ? Object.values(repair.approvalsById).filter(
        (a) => a.entryId === active.entryId,
      )
    : [];
  onDestroy(() => {
    stopped = true;
    stopPicker();
    if (cropUrl) URL.revokeObjectURL(cropUrl);
  });
  onMount(() => {
    void loadPhotoAudit()
      .then((value) => (audit = value))
      .catch((e: Error) => (error = e.message));
    const timer = setInterval(() => {
      void advance();
    }, 2000);
    return () => clearInterval(timer);
  });
  async function work(fn: () => Promise<any>) {
    busy = true;
    error = "";
    try {
      await fn();
    } catch (e: any) {
      error = e.message || String(e);
    } finally {
      busy = false;
    }
  }
  async function advance() {
    if (ticking || busy || !$user?.uid || stopped) return;
    ticking = true;
    try {
      for (const e of Object.values(repair.entriesById) as EntryRecord[]) {
        const a = repair.attemptsById[e.selectedAttemptId || ""];
        if (
          !e.approvalId &&
          !e.later &&
          (activeId === e.entryId ||
            (() => {
              const task = taskForEntry($store, e, tasks, audit);
              return task && photoNeedsWork(taskAssessment($store, task));
            })()) &&
          a &&
          a.importId === originalFor(repair, e)?.importId
        )
          await queueNextStep(a.attemptId);
        if (e.approvalId) await publishRepair(e.approvalId);
      }
    } catch (e: any) {
      error = e.message;
    } finally {
      ticking = false;
    }
  }
  function changeMode(value: string) {
    mode = value;
    activeId = "";
    filter = "All";
    selected = new Set();
  }
  async function decidePhoto(task: StockPhotoTask, good: boolean) {
    const lookup = audit || (await loadPhotoAudit());
    const entryId = await reviewStockPhoto(task, good, lookup);
    if (good) {
      activeId = "";
      message = "Marked good. This image will stay out of the repair queue.";
    } else {
      mode = "Needs photos";
      activeId = entryId || "";
    }
  }
  function openEntry(e: EntryRecord) {
    activeId = e.entryId;
    startAt = "original";
    error = "";
    const previous = repair.attemptsById[e.selectedAttemptId || ""]?.steps.map(
      (s) => s.kind,
    );
    const history = $store.photos.edits[e.existingPhotoId || ""]?.history
      .filter((h: any) => h.status === "success")
      .map((h: any) => h.operation);
    const configured = $store.photos.processingConfig.steps
      .filter((s: any) => s.enabled)
      .map((s: any) => s.type);
    const ops =
      previous !== undefined
        ? previous
        : history?.length
          ? history
          : configured;
    order = [
      ...new Set([
        ...ops
          .map((k: string) =>
            k === "remove_background"
              ? "remove_bg"
              : k === "crop"
                ? "smart_crop"
                : k,
          )
          .filter((k: string) =>
            ["color_correct", "remove_bg", "smart_crop"].includes(k),
          ),
        "color_correct",
        "remove_bg",
        "smart_crop",
      ]),
    ];
    color = ops.includes("color_correct");
    background = ops.includes("remove_bg") || ops.includes("remove_background");
    smartCrop = ops.includes("smart_crop") || ops.includes("crop");
  }
  function activeEntry(): EntryRecord {
    if (!active) throw Error("Choose a photo first.");
    return active;
  }
  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selected = next;
  }
  const stepName = (kind: string) =>
    ({
      color_correct: "Colour correction",
      remove_bg: "Background removal",
      smart_crop: "Automatic crop",
      manual_crop: "Manual crop",
    })[kind] || kind;
  function steps(): Step[] {
    return order
      .filter((k) =>
        k === "color_correct"
          ? color
          : k === "remove_bg"
            ? background
            : smartCrop,
      )
      .map((kind) => ({ kind })) as Step[];
  }
  function parent() {
    if (startAt === "original") return undefined;
    const [id, index] = startAt.split(":");
    return repair.attemptsById[id] ? { id, index: Number(index) } : undefined;
  }
  async function process(entry: EntryRecord) {
    const p = entry.entryId === activeId ? parent() : undefined;
    await startRepairAttempt(entry, steps(), p?.id, p?.index);
  }
  async function selectOriginals() {
    const session = await createPickerSession();
    pickerHref = session.pickerUri.endsWith("/")
      ? session.pickerUri.slice(0, -1)
      : session.pickerUri;
    if (!pickerHref.endsWith("/autoclose")) pickerHref += "/autoclose";
    window.open(pickerHref, "_blank", "width=900,height=700");
    selecting = true;
    let polling = false,
      tries = 0;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        if (++tries > 150)
          throw Error("Photo selection timed out. Select originals again.");
        const result = await pollPickerSession(session.id);
        if (result.mediaItemsSet) {
          stopPicker();
          picked = await listSessionMediaItems(session.id);
        }
      } catch (e: any) {
        error = e.message;
        stopPicker();
      } finally {
        polling = false;
      }
    }, 2000);
    stopPicker = () => {
      clearInterval(timer);
      selecting = false;
    };
  }
  async function upload(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file && active)
      await work(() => importRepairOriginal(active!, undefined, file));
    (event.target as HTMLInputElement).value = "";
  }
  async function manualCrop() {
    const p = parent();
    const input = p
      ? stepOutput(repair.attemptsById[p.id], p.index)
      : original?.result?.artifact;
    if (!input)
      throw Error(
        "Choose an imported original or a completed processing step.",
      );
    const token = getDriveToken();
    const response = input.driveFileId
      ? await fetch(
          `https://www.googleapis.com/drive/v3/files/${input.driveFileId}?alt=media`,
          { headers: { Authorization: `Bearer ${token?.access_token || ""}` } },
        )
      : await fetch(input.url);
    if (!response.ok)
      throw Error(
        "Could not open the image for cropping. Connect Google and retry.",
      );
    if (cropUrl) URL.revokeObjectURL(cropUrl);
    cropUrl = URL.createObjectURL(await response.blob());
    cropParent = p?.id;
    cropIndex = p?.index;
    cropOpen = true;
  }
  async function refreshTargets() {
    if (!active) return;
    if (!activeTask)
      throw Error(
        "This photo is no longer used by a stocked item. Its saved work is still available.",
      );
    await repairEvent("targetsChanged", {
      entryId: active.entryId,
      targets: activeTask.targets,
    });
  }
</script>

<svelte:head><title>Repair imported photos</title></svelte:head>
<ProcessingConfigModal
  bind:open={configureOpen}
  config={processingConfig}
  on:save={configure}
/>
<ManualCropModal
  bind:open={cropOpen}
  imageUrl={cropUrl}
  on:save={(event) => {
    if (active)
      void work(() =>
        saveManualRepair(
          activeEntry(),
          event.detail.blob,
          event.detail.cropData,
          cropParent,
          cropIndex,
        ),
      );
  }}
/>
<main>
  <h1>Repair imported photos</h1>
  <p>
    Fix missing or poor current photos for items with stock. Photos already
    repaired or marked good stay out of the queue.
  </p>
  <div class="actions">
    <a href="/photos">Photos</a><button on:click={() => initiateOAuthFlow()}
      >Connect Google</button
    >
    <button
      disabled={busy || !$store.inventory.initialized}
      on:click={() =>
        work(async () => {
          const result = await seedRepairQueue((text) => (message = text));
          message = `Checked ${result.checked} current photos. ${result.attention} need attention.`;
        })}>Check stocked item photos</button
    >
  </div>
  <div class="actions">
    {#each ["Needs photos", "Other stocked photos", "Saved work"] as value}<button
        class:primary={mode === value}
        on:click={() => changeMode(value)}>{value}</button
      >{/each}
  </div>
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if !$store.inventory.initialized}<p role="status">
      Loading inventory and saved repair progress…
    </p>{/if}
  <div class="actions">
    <label>Search <input type="search" bind:value={query} /></label>
    <label
      >Show <select bind:value={filter}
        >{#each ["All", "Needs original", "Importing", "Ready to process", "Processing", "Processing failed", "Needs review", "Updating", "Sync failed", "Done", "Photo is good", "Later"] as value}<option
            >{value}</option
          >{/each}</select
      ></label
    >
    <span
      >{stockedItems} stocked items · {skipped} current photos skipped · {mode ===
      "Saved work"
        ? `${visible.length} saved repairs`
        : mode === "Other stocked photos"
          ? `${otherPhotos.length} current photos`
          : `${visible.length} queued for review`}</span
    >
  </div>
  {#if notChecked && mode === "Needs photos"}<p role="status">
      {notChecked} current photos have not been checked yet. Choose Check stocked
      item photos to find small or missing images.
    </p>{/if}
  {#if mode === "Other stocked photos"}
    <p>
      Large files are excluded from the repair queue automatically. If a photo
      still looks poor, choose Needs a better photo.
    </p>
    <table>
      <thead
        ><tr
          ><th>Current photo</th><th>Stocked item</th><th>Result</th><th
            >Decision</th
          ></tr
        ></thead
      ><tbody
        >{#each otherPhotos.slice(0, 150) as row}<tr
            ><td
              >{#if row.task.url}<SecureImage
                  src={row.task.url}
                  alt={row.task.title}
                  size="thumbnail"
                  style="max-width:100px;max-height:100px"
                />{:else}No photo{/if}</td
            ><td
              >{row.task.title}<small
                >{row.task.jans} · {row.task.stock} in stock</small
              ></td
            ><td>{row.assessment}</td><td
              ><button
                disabled={busy}
                on:click={() => work(() => decidePhoto(row.task, false))}
                >Needs a better photo</button
              >{#if row.task.url}<button
                  disabled={busy}
                  on:click={() => work(() => decidePhoto(row.task, true))}
                  >Photo is good</button
                >{/if}</td
            ></tr
          >{/each}</tbody
      >
    </table>
  {/if}
  {#if mode === "Other stocked photos" && otherPhotos.length > 150}<p>
      Showing the first 150 current photos. Search by product name or JAN to
      find another item.
    </p>{/if}
  {#if active && details}
    <section class="review" aria-label="Photo repair review">
      <h2>{details.title}</h2>
      <p>
        JAN {details.jans || "unassigned"} · {details.filename} · {details.stock}
        in stock · <strong>{state}</strong>
      </p>
      <div class="comparison">
        <div>
          <h3>{active.approvalId ? "Previous image" : "Current image"}</h3>
          {#if activeTask?.url || active.oldImageUrl}<SecureImage
              src={activeTask?.url || active.oldImageUrl}
              alt="Current product image"
            />{:else}<p>
              {active.approvalId
                ? "No previous photo."
                : "This stocked item has no photo."}
            </p>{/if}
        </div>
        <div>
          <h3>New original</h3>
          {#if original?.result?.artifact}<SecureImage
              src={original.result.artifact.url}
              alt="New original"
            />{:else}<p>Import an original below.</p>{/if}
        </div>
        <div>
          <h3>New candidate</h3>
          {#if candidate}<SecureImage
              src={candidate.url}
              alt="New candidate"
            />{:else}<p>Process the original to make a candidate.</p>{/if}
        </div>
      </div>
      <p>
        Open any image in a new tab for a larger view: {#each [["Current", active.oldImageUrl], ["Original", original?.result?.artifact?.url], ["Candidate", candidate?.url]] as link}{#if link[1]}<a
              href={link[1]}
              target="_blank"
              rel="noreferrer">{link[0]}</a
            >
          {/if}{/each}
      </p>
      <details>
        <summary>Where this image is used ({uses.length || 1})</summary>
        <ul>
          {#each uses as use}<li>{use}</li>{:else}<li>Photo library</li>{/each}
        </ul>
      </details>
      {#if !active.approvalId}
        {#if activeTask?.url}<button
            disabled={busy}
            on:click={() => work(() => decidePhoto(activeTask, true))}
            >Photo is good — no repair needed</button
          >{/if}
        <h3>1. Get the original</h3>
        <div class="actions">
          <button
            disabled={busy}
            on:click={() => work(() => importRepairOriginal(activeEntry()))}
            >Re-import original</button
          >
          <button
            disabled={busy || selecting}
            on:click={() => work(selectOriginals)}
            >{selecting
              ? "Selecting in Google Photos…"
              : "Select originals in Google Photos"}</button
          >
          <label class="upload"
            >Upload original <input
              type="file"
              accept="image/*,.heic,.heif"
              disabled={busy}
              on:change={upload}
            /></label
          >
        </div>
        {#if selecting}<p>
            <a href={pickerHref} target="_blank" rel="noreferrer"
              >Open Google Photos selection</a
            > then return here after choosing originals.
          </p>{/if}
        {#if original?.result?.message}<p role="alert" class="error">
            {original.result.message}
          </p>{/if}
        {#if picked.length}<p>
            Choose the original for this image. Select another queue entry to
            assign the remaining photos.
          </p>
          <div class="picked">
            {#each picked as photo}<button
                disabled={busy}
                on:click={() =>
                  work(async () => {
                    await importRepairOriginal(activeEntry(), photo);
                    picked = picked.filter((p) => p.id !== photo.id);
                  })}
                ><SecureImage
                  src={photo.baseUrl}
                  alt={photo.filename}
                  size="thumbnail"
                />{photo.filename}</button
              >{/each}
          </div>{/if}
        {#if existingPhotos.length}<details>
            <summary>Choose a photo already in the system</summary>
            <div class="picked">
              {#each existingPhotos as photo}<button
                  disabled={busy}
                  on:click={() =>
                    work(() => useExistingRepairSource(activeEntry(), photo))}
                  ><SecureImage
                    src={photo.baseUrl}
                    alt={photo.filename}
                    size="thumbnail"
                  />{photo.filename}</button
                >{/each}
            </div>
          </details>{/if}
        <h3>2. Process</h3>
        <button disabled={busy} on:click={() => (configureOpen = true)}
          >Change processing order</button
        >
        <p>
          Order: {steps()
            .map((s) => stepName(s.kind))
            .join(" → ") || "Use the original without processing"}
        </p>
        <div class="actions">
          <label
            ><input type="checkbox" bind:checked={color} />Colour correction</label
          >
          <label
            ><input type="checkbox" bind:checked={background} />Remove
            background</label
          >
          <label
            ><input type="checkbox" bind:checked={smartCrop} />Crop
            automatically</label
          >
          <label
            >Start from <select bind:value={startAt}
              ><option value="original">New original</option
              >{#each historyAttempts as prior, attemptIndex}
                {#each prior.steps as step, i}
                  {#if stepOutput(prior, i)}<option
                      value={`${prior.attemptId}:${i}`}
                      >Attempt {attemptIndex + 1}: {i + 1}. {step.kind.replace(
                        /_/g,
                        " ",
                      )}</option
                    >{/if}
                {/each}
              {/each}</select
            ></label
          >
          <button
            disabled={busy || !original?.result?.artifact}
            on:click={() => work(() => process(activeEntry()))}
            >{candidate ? "Redo processing" : "Process original"}</button
          >
          <button
            disabled={busy || !original?.result?.artifact}
            on:click={() => work(manualCrop)}>Crop manually</button
          >
          {#if state === "Processing failed"}<button
              disabled={busy}
              on:click={() =>
                work(() =>
                  queueNextStep(activeEntry().selectedAttemptId || "", true),
                )}>Retry failed step</button
            >{/if}
        </div>
        <button
          disabled={busy || !original?.result?.artifact}
          on:click={() => work(() => startRepairAttempt(activeEntry(), []))}
          >Use original as candidate</button
        >
        {#each failures as failure}<p role="alert" class="error">
            {failure}
          </p>{/each}
        <h3>3. Review and update</h3>
        <div class="actions">
          <button
            class="primary"
            disabled={busy || !candidate}
            on:click={() => work(() => approveRepair(activeEntry()))}
            >Approve and update</button
          ><button
            disabled={busy}
            on:click={() =>
              work(() =>
                repairEvent("laterChanged", {
                  entryId: activeEntry().entryId,
                  later: !activeEntry().later,
                }),
              )}>{active.later ? "Resume" : "Later"}</button
          >
        </div>
        {#if activeApprovals.some((a) => a.result === "references_changed")}<p
            role="alert"
          >
            An image reference changed since this entry was created. Refresh its
            uses and review again.
          </p>
          <button disabled={busy} on:click={() => work(refreshTargets)}
            >Refresh uses</button
          >{/if}
      {:else}
        <p role="status">
          {state === "Done"
            ? "Approved and updated."
            : state === "Sync failed"
              ? "Approved locally. Shopify update failed."
              : "Approved locally. Updating Shopify…"}
        </p>
        {#if state === "Sync failed"}<button
            disabled={busy}
            on:click={() =>
              work(() => publishRepair(activeEntry().approvalId || "", true))}
            >Retry Shopify update</button
          >{/if}
      {/if}
    </section>
  {/if}
  {#if mode !== "Other stocked photos"}
    {#if selected.size}<div class="actions">
        <span>{selected.size} selected</span><button
          disabled={busy}
          on:click={() =>
            work(async () => {
              for (const key of selected) {
                const e = repair.entriesById[key];
                if (e && !e.approvalId) await importRepairOriginal(e);
              }
              message = "Original imports requested.";
            })}>Re-import selected originals</button
        ><button
          disabled={busy}
          on:click={() =>
            work(async () => {
              for (const key of selected) {
                const e = repair.entriesById[key];
                if (e && !e.approvalId) await process(e);
              }
              message =
                "Processing requested. Review each result individually.";
            })}>Process selected originals</button
        >
      </div>{/if}
    <table>
      <thead
        ><tr
          ><th>Select</th><th>Product</th><th>Stock</th><th>Photo issue</th><th
            >Progress</th
          ><th>Review</th></tr
        ></thead
      ><tbody
        >{#each visible.slice(0, 150) as row}<tr
            class:active={activeId === row.e.entryId}
            ><td
              ><input
                type="checkbox"
                aria-label={`Select ${row.details.title}`}
                checked={selected.has(row.e.entryId)}
                on:change={() => toggle(row.e.entryId)}
              /></td
            ><td
              >{row.details.title}<small
                >{row.details.jans} · {row.details.filename}</small
              ></td
            ><td>{row.details.stock}</td><td>{row.assessment}</td><td
              >{row.status}</td
            ><td><button on:click={() => openEntry(row.e)}>Review</button></td
            ></tr
          >{/each}</tbody
      >
    </table>
    {#if visible.length > 150}<p>
        Showing the first 150 matches. Narrow the search or progress filter to
        see more.
      </p>{/if}
  {/if}
</main>

<style>
  main {
    max-width: 1400px;
    margin: auto;
    padding: 1.5rem;
  }
  h1 {
    font-size: 1.8rem;
  }
  h2 {
    font-size: 1.4rem;
  }
  h3 {
    font-size: 1.1rem;
    margin: 1rem 0 0.6rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.8rem;
    align-items: center;
    margin: 1rem 0;
  }
  button,
  .upload {
    border: 1px solid #aaa;
    padding: 0.5rem 0.8rem;
    border-radius: 6px;
    background: #fff;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .primary {
    background: #155e45;
    color: white;
  }
  .review {
    border: 1px solid #cbd5d1;
    border-radius: 10px;
    padding: 1rem;
    margin: 1rem 0;
  }
  .comparison {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1rem;
  }
  .comparison > div {
    min-height: 260px;
    overflow: hidden;
  }
  .comparison :global(img) {
    max-height: 420px;
    object-fit: contain;
  }
  a {
    color: #155e45;
    text-decoration: underline;
    margin-right: 0.5rem;
  }
  .error {
    color: #a32424;
    overflow-wrap: anywhere;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    text-align: left;
    padding: 0.6rem;
    border-bottom: 1px solid #ddd;
  }
  small {
    display: block;
    color: #666;
  }
  .active {
    background: #edf7f1;
  }
  .picked {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }
  .picked button {
    width: 150px;
  }
  .picked :global(img) {
    height: 110px;
    object-fit: contain;
  }
  input[type="search"] {
    border: 1px solid #aaa;
    padding: 0.5rem;
  }
  select {
    padding: 0.4rem;
    border: 1px solid #aaa;
  }
  @media (max-width: 700px) {
    .comparison {
      grid-template-columns: 1fr;
    }
  }
</style>
