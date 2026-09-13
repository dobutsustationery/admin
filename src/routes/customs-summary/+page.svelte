<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import { firestore } from "$lib/firebase";
  import { broadcast } from "$lib/redux-firestore";
  import { initiateOAuthFlow, isAuthenticated } from "$lib/google-auth-unified";
  import {
    listCustomsSheets,
    getCustomsSheet,
    sheetIdFromUrl,
    readCustomsInput,
    assertCustomsSourcesCurrent,
    createCustomsWorkbook,
    findCustomsExport,
    writeCustomsWorkbook,
  } from "$lib/google-sheets";
  import {
    customsCreated,
    customsSourceChunk,
    customsSourceReceived,
    customsDecision,
    customsSettings,
    customsExportStarted,
    customsExportResponse,
    customsExportReadback,
  } from "$lib/customs-summary-slice";
  import type {
    CustomsReport,
    CustomsSettings,
  } from "$lib/customs-summary-model";
  import CustomsHsReview from "$lib/components/CustomsHsReview.svelte";
  let active = "";
  let name = "Kanegen customs summary";
  let files: { id: string; name: string }[] = [];
  let orderId = "",
    shippingId = "",
    orderTab = "Product List",
    shippingTab = "出荷明細書";
  let orderTabs: string[] = [],
    shippingTabs: string[] = [];
  let busy = false,
    error = "",
    message = "";
  let settings: CustomsSettings = {
    grossKg: "",
    grossSource: "",
    packagePolicy: "",
    cartonGross: {},
    grossMethod: "shipment",
  };
  let settingsFor = "";
  $: reports = Object.values(
    $store.customsSummary?.reports || {},
  ) as CustomsReport[];
  $: report = reports.find((r) => r.id === active);
  $: projection = report?.projection;
  $: if (report && settingsFor !== `${report.id}:${report.revision}`) {
    settings = {
      ...report.settings,
      cartonGross: { ...report.settings.cartonGross },
    };
    settingsFor = `${report.id}:${report.revision}`;
  }
  $: unsavedSettings =
    report && JSON.stringify(settings) !== JSON.stringify(report.settings);
  async function send(action: any) {
    if (!$user?.uid) throw new Error("Sign in first.");
    const ref = await broadcast(firestore, $user.uid, action);
    // Wait for the broadcast listener, never dispatch a second local copy.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(
          new Error(
            "Your changes are saved, but the report is still loading. Wait before continuing.",
          ),
        );
      }, 20000);
      const unsubscribe = store.subscribe(() => {
        // Wait for this exact event to be reduced before continuing.
        if (
          store.getState().customsSummary?.appliedEventIds.includes(ref!.id)
        ) {
          clearTimeout(timer);
          queueMicrotask(() => unsubscribe());
          resolve();
        }
      });
      if (!ref) {
        clearTimeout(timer);
        unsubscribe();
        reject(new Error("Could not save event"));
      }
    });
  }
  async function work(fn: () => Promise<void>) {
    busy = true;
    error = "";
    message = "";
    try {
      await fn();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
  async function loadFiles() {
    await work(async () => {
      files = await listCustomsSheets();
    });
  }
  async function tabs(role: "order" | "shipping") {
    await work(async () => {
      const id = sheetIdFromUrl(role === "order" ? orderId : shippingId);
      const book = await getCustomsSheet(id);
      const names: string[] = book.sheets.map((s: any) => s.properties.title);
      if (role === "order") {
        orderId = id;
        orderTabs = names;
        orderTab = names.includes("Product List") ? "Product List" : names[0];
      } else {
        shippingId = id;
        shippingTabs = names;
        shippingTab = names.includes("出荷明細書")
          ? "出荷明細書"
          : names.includes("箱番順")
            ? "箱番順"
            : names[0];
      }
    });
  }
  async function create() {
    await work(async () => {
      active = crypto.randomUUID();
      await send(customsCreated({ reportId: active, name }));
    });
  }
  async function read() {
    await work(async () => {
      if (!report) return;
      const input = await readCustomsInput(
        sheetIdFromUrl(orderId),
        orderTab,
        sheetIdFromUrl(shippingId),
        shippingTab,
      );
      const json = JSON.stringify(input),
        readId = crypto.randomUUID();
      // JSON text avoids Firestore's nested-array restriction. UTF-8 encoded
      // payload remains comfortably below broadcast's 900 KB limit.
      const size = 60000,
        chunks = Math.ceil(json.length / size);
      for (let i = 0; i < chunks; i++)
        await send(
          customsSourceChunk({
            reportId: active,
            readId,
            index: i,
            json: json.slice(i * size, (i + 1) * size),
          }),
        );
      await send(customsSourceReceived({ reportId: active, readId, chunks }));
      message =
        "Source data saved. Review the classifications and summary below.";
    });
  }
  async function exportReport(runId?: string) {
    await work(async () => {
      if (!report?.input || !report.projection.ready) return;
      const snapshot = report;
      await assertCustomsSourcesCurrent(snapshot.input!);
      const id = runId || crypto.randomUUID();
      if (!runId)
        await send(customsExportStarted({ reportId: active, runId: id }));
      const prior = snapshot.exports[id];
      if (prior && prior.revision !== snapshot.revision)
        throw new Error(
          "This export belongs to an older preview. Create a new workbook for the current report.",
        );
      let response = prior?.response ? JSON.parse(prior.response) : null;
      if (!response && runId) {
        response = await findCustomsExport(id);
        if (!response)
          throw new Error(
            `The create result is uncertain. Check Drive for ${id}; do not retry creation until any pending request has completed. You can then start a new export deliberately.`,
          );
      }
      if (!response) response = await createCustomsWorkbook(snapshot, id);
      await send(
        customsExportResponse({
          reportId: active,
          runId: id,
          json: JSON.stringify(response),
        }),
      );
      if (
        store.getState().customsSummary.reports[active].revision !==
        snapshot.revision
      )
        throw new Error(
          "Report changed during export. Review the current preview and start a new export.",
        );
      const readback = await writeCustomsWorkbook(
        response.spreadsheetId,
        snapshot,
      );
      await send(
        customsExportReadback({
          reportId: active,
          runId: id,
          json: JSON.stringify(readback),
        }),
      );
      message = "Workbook written. See its verification status below.";
    });
  }
  function resume(r: CustomsReport) {
    active = r.id;
    if (r.input) {
      orderId = r.input.order.id;
      orderTab = r.input.order.tab;
      shippingId = r.input.shipping.id;
      shippingTab = r.input.shipping.tab;
      orderTabs = [orderTab];
      shippingTabs = [shippingTab];
    }
  }
  onMount(() => {
    if (isAuthenticated()) void loadFiles();
  });
</script>

<svelte:head><title>Customs Summary · Dobutsu</title></svelte:head>
<main>
  <h1>Customs Summary</h1>
  <p>
    Prepare shipment paperwork from the supplier order and packing spreadsheets.
    Your sources and decisions are saved; returning here resumes the report
    without importing stock.
  </p>
  {#if !$store.inventory.initialized}<p role="status">
      Waiting for inventory and saved reports to finish loading…
    </p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  <fieldset disabled={busy || !$store.inventory.initialized}>
    <legend>Saved reports</legend>
    {#each reports as r}<button
        class:active={active === r.id}
        on:click={() => resume(r)}
        >{r.name} — {r.projection.invoice || "sources needed"}</button
      >{/each}
    <label>New report name <input bind:value={name} /></label><button
      disabled={!name.trim()}
      on:click={create}>Start new report</button
    >
  </fieldset>
  {#if report}
    <h2>{report.name}</h2>
    <fieldset disabled={busy || !$store.inventory.initialized}>
      <legend>1. Choose source Google Sheets</legend>
      <button on:click={() => initiateOAuthFlow(false, window.location.href)}
        >Connect Google</button
      ><button on:click={loadFiles}>Refresh spreadsheet list</button>
      <p>
        Choose two native Google Sheets. For Excel files, first use “Save as
        Google Sheets” in Google. Only one shipping tab is used.
      </p>
      <div class="sources">
        <div>
          <label
            >Order spreadsheet <select
              bind:value={orderId}
              on:change={() => tabs("order")}
              ><option value="">Choose…</option>{#each files as f}<option
                  value={f.id}>{f.name}</option
                >{/each}</select
            ></label
          ><label>Or order URL / ID <input bind:value={orderId} /></label
          ><button on:click={() => tabs("order")}>Load order tabs</button><label
            >Order tab <select bind:value={orderTab}
              >{#each orderTabs as tab}<option>{tab}</option>{/each}</select
            ></label
          >
        </div>
        <div>
          <label
            >Shipping spreadsheet <select
              bind:value={shippingId}
              on:change={() => tabs("shipping")}
              ><option value="">Choose…</option>{#each files as f}<option
                  value={f.id}>{f.name}</option
                >{/each}</select
            ></label
          ><label>Or shipping URL / ID <input bind:value={shippingId} /></label
          ><button on:click={() => tabs("shipping")}>Load shipping tabs</button
          ><label
            >Shipping tab <select bind:value={shippingTab}
              >{#each shippingTabs as tab}<option>{tab}</option>{/each}</select
            ></label
          >
        </div>
      </div>
      <button
        disabled={!orderId || !shippingId || !orderTab || !shippingTab}
        on:click={read}
        >{report.input
          ? "Read sources again (resets HS decisions if changed)"
          : "Read and reconcile sources"}</button
      >
      {#if report.input}<p>
          <a
            href={`https://docs.google.com/spreadsheets/d/${report.input.order.id}/edit#gid=${report.input.order.sheetId}`}
            >Order source</a
          >
          ·
          <a
            href={`https://docs.google.com/spreadsheets/d/${report.input.shipping.id}/edit#gid=${report.input.shipping.sheetId}`}
            >Shipping source</a
          >
        </p>{/if}
    </fieldset>
    {#if projection && report.input}
      {#key report.id}
        <CustomsHsReview
          products={projection.products}
          disabled={busy || !$store.inventory.initialized}
          on:decision={(e) =>
            work(async () => {
              await send(customsDecision({ reportId: active, ...e.detail }));
            })}
        />
      {/key}
      <fieldset disabled={busy || !$store.inventory.initialized}>
        <legend>2. Measurements and packages</legend>
        <label
          >Gross allocation <select bind:value={settings.grossMethod}
            ><option value="shipment"
              >Proportional to net, whole shipment</option
            ><option value="carton">Measured gross for each carton</option
            ></select
          ></label
        >
        {#if settings.grossMethod === "shipment"}<label
            >Measured shipment gross (kg)<input
              bind:value={settings.grossKg}
              inputmode="decimal"
            /></label
          >{:else}{#each projection.cartons as c}<label
              >Carton {c.id} gross kg (net {c.netKg.toFixed(3)})<input
                bind:value={settings.cartonGross[c.id]}
                inputmode="decimal"
              /></label
            >{/each}{/if}
        <label
          >Measurement source <input
            bind:value={settings.grossSource}
            placeholder="e.g. carrier packing certificate"
          /></label
        >
        <label
          >Package convention <select bind:value={settings.packagePolicy}
            ><option value="">Choose / confirm…</option><option value="cartons"
              >Cartons containing each commodity (non-additive)</option
            ></select
          ></label
        >
        <button
          on:click={() =>
            work(async () => {
              await send(customsSettings({ reportId: active, settings }));
            })}>Save measurements and convention</button
        >
      </fieldset>
      <section>
        <h2>3. Preview before export</h2>
        {#if unsavedSettings}<p>
            Save your measurements and convention to update this preview before
            exporting.
          </p>{/if}
        <p>
          <strong
            >{projection.ready
              ? "Ready"
              : "Draft — resolve the issues below"}</strong
          >
          · {projection.totals.pieces} pieces · ¥{projection.totals.yen.toLocaleString()}
          · {projection.totals.netKg.toFixed(3)} kg net · {projection.totals.grossKg?.toFixed(
            3,
          ) ?? "Required"} kg gross · {projection.cartons.length} unique cartons
        </p>
        {#if projection.issues.length}<details open>
            <summary>{projection.issues.length} items need attention</summary>
            <ul>
              {#each projection.issues as issue}<li>{issue}</li>{/each}
            </ul>
          </details>{/if}
        <p>
          Package counts are cartons containing each commodity. A shared carton
          appears in several groups; do not add this column.
        </p>
        <div class="scroll">
          <table>
            <thead
              ><tr
                ><th>HS</th><th>English</th><th>Bulgarian</th><th>Origin</th><th
                  >Pieces</th
                ><th>Packages</th><th>Net kg</th><th>Gross kg</th><th>JPY</th
                ></tr
              ></thead
            ><tbody
              >{#each projection.groups as g}<tr
                  ><td>{g.code || "Unclassified — action required"}</td><td
                    >{g.en}</td
                  ><td>{g.bg}</td><td>{g.origin}</td><td>{g.pieces}</td><td
                    >{report.settings.packagePolicy
                      ? g.cartons.length
                      : "Required"}</td
                  ><td>{g.netKg.toFixed(3)}</td><td
                    >{g.grossKg?.toFixed(3) ?? "Required"}</td
                  ><td>{g.yen}</td></tr
                >{/each}</tbody
            >
          </table>
        </div>
        <h3>Carton membership</h3>
        <div class="scroll">
          <table>
            <thead
              ><tr
                ><th>HS</th><th>English</th><th>Bulgarian</th><th>Origin</th><th
                  >Cartons</th
                ></tr
              ></thead
            ><tbody
              >{#each projection.groups as g}<tr
                  ><td>{g.code || "Unclassified"}</td><td>{g.en}</td><td
                    >{g.bg}</td
                  ><td>{g.origin}</td><td>{g.cartons.join(", ")}</td></tr
                >{/each}</tbody
            >
          </table>
        </div>
        <details>
          <summary>Contributing product allocations / carton totals</summary>
          <div class="scroll">
            <table>
              <thead
                ><tr
                  ><th>JAN</th><th>Order row</th><th>Shipping row</th><th
                    >Carton</th
                  ><th>Pieces</th><th>JPY</th><th>Net kg</th></tr
                ></thead
              ><tbody
                >{#each projection.allocations as a}<tr
                    ><td>{a.jan}</td><td>{a.orderRow}</td><td
                      >{a.shippingRow}</td
                    ><td>{a.carton}</td><td>{a.qty}</td><td>{a.yen}</td><td
                      >{a.netKg.toFixed(3)}</td
                    ></tr
                  >{/each}</tbody
              >
            </table>
          </div>
          {#each projection.cartons as c}<p>
              Carton {c.id}: {c.pieces} pieces, ¥{c.yen}, {c.netKg.toFixed(3)} kg
              net
            </p>{/each}
        </details>
        <details>
          <summary>Excluded source rows ({projection.excluded.length})</summary>
          <ul>
            {#each projection.excluded as row}<li>{row}</li>{/each}
          </ul>
        </details>
        <button
          disabled={busy ||
            !$store.inventory.initialized ||
            !projection.ready ||
            unsavedSettings}
          on:click={() => exportReport()}>Export to new Google workbook</button
        >
        {#each Object.entries(report.exports) as [runId, run]}
          <p>
            Export {runId}: {run.revision !== report.revision
              ? "Older preview"
              : run.verified
                ? "Verified against preview"
                : "Incomplete / awaiting verification"}
            {#if run.response}<a
                href={`https://docs.google.com/spreadsheets/d/${JSON.parse(run.response).spreadsheetId}/edit`}
                >Open workbook</a
              >{/if}
            {#if !run.verified && run.revision === report.revision}<button
                disabled={busy || !projection.ready || unsavedSettings}
                on:click={() => exportReport(runId)}
                >Recover / retry this export</button
              >{/if}
          </p>
        {/each}
      </section>
    {/if}
  {/if}
  {#if busy}<p role="status">Working…</p>{/if}
</main>

<style>
  main {
    max-width: 1500px;
    padding: 1.5rem;
    margin: auto;
  }
  fieldset {
    border: 1px solid #bbb;
    margin: 1rem 0;
    padding: 1rem;
  }
  label {
    display: inline-flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0.4rem;
    max-width: 100%;
  }
  input,
  select {
    padding: 0.5rem;
    max-width: 100%;
  }
  button {
    padding: 0.5rem 0.8rem;
    margin: 0.3rem;
    cursor: pointer;
  }
  button:disabled {
    cursor: default;
    opacity: 0.5;
  }
  .active {
    border: 2px solid #245344;
  }
  .sources {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 1rem;
  }
  .sources label {
    display: flex;
  }
  .scroll {
    overflow-x: auto;
  }
  table {
    border-collapse: collapse;
    width: 100%;
  }
  th,
  td {
    text-align: left;
    vertical-align: top;
    padding: 0.6rem;
    border-bottom: 1px solid #ddd;
  }
  .error {
    padding: 1rem;
    color: #8a1616;
    background: #fff0ed;
  }
  details {
    margin: 1rem 0;
  }
  h2 {
    margin-top: 1.5rem;
  }
</style>
