<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type {
    ProcessingStep,
    ProcessingConfig,
    ProcessingStepType,
  } from "$lib/photos-slice";

  export let open = false;
  export let config: ProcessingConfig | undefined = undefined;

  const dispatch = createEventDispatcher();

  let localSteps: ProcessingStep[] = [];
  let wasOpen = false;

  $: if (open && !wasOpen) {
    localSteps = config?.steps
      ? config.steps.map((s) => ({ ...s })) // Deep copy
      : [
          { type: "crop", enabled: false },
          { type: "color_correct", enabled: true },
          { type: "remove_background", enabled: true },
        ];
    wasOpen = true;
  }
  $: if (!open) {
    wasOpen = false;
  }

  function moveUp(index: number) {
    if (index === 0) return;
    const steps = [...localSteps];
    const temp = steps[index];
    steps[index] = steps[index - 1];
    steps[index - 1] = temp;
    localSteps = steps;
  }

  function moveDown(index: number) {
    if (index === localSteps.length - 1) return;
    const steps = [...localSteps];
    const temp = steps[index];
    steps[index] = steps[index + 1];
    steps[index + 1] = temp;
    localSteps = steps;
  }

  function toggleEnabled(index: number) {
    const steps = [...localSteps];
    steps[index].enabled = !steps[index].enabled;
    localSteps = steps;
  }

  function handleSave() {
    dispatch("save", { steps: localSteps });
    open = false;
  }

  const stepLabels: Record<ProcessingStepType, string> = {
    crop: "Auto-Crop (Trim Transparency)",
    color_correct: "Color Correction (Auto-Levels)",
    remove_background: "Background Removal (AI)",
  };
</script>

{#if open}
  <div class="modal-overlay">
    <div class="modal-card">
      <div class="modal-header">
        <h3 class="modal-title">Configure Image Processing</h3>
        <button on:click={() => (open = false)} class="close-button"
          >&times;</button
        >
      </div>

      <div class="modal-body">
        <p class="description">
          Reorder and enable/disable the steps below to customize your
          processing pipeline. The recommended order is Color Correction &rarr;
          Background Removal.
        </p>

        <div class="steps-list">
          {#each localSteps as step, i (step.type)}
            <div class="step-row" class:disabled={!step.enabled}>
              <div class="step-main">
                <label
                  class="switch"
                  title={step.enabled ? "Disable step" : "Enable step"}
                >
                  <input
                    type="checkbox"
                    checked={step.enabled}
                    on:change={() => toggleEnabled(i)}
                  />
                  <span class="slider round"></span>
                </label>
                <span class="step-number">{i + 1}.</span>
                <span class="step-label">{stepLabels[step.type]}</span>
              </div>
              <div class="step-actions">
                <button
                  on:click={() => moveUp(i)}
                  disabled={i === 0}
                  class="move-button"
                  title="Move Up"
                >
                  &uarr;
                </button>
                <button
                  on:click={() => moveDown(i)}
                  disabled={i === localSteps.length - 1}
                  class="move-button"
                  title="Move Down"
                >
                  &darr;
                </button>
              </div>
            </div>
          {/each}
        </div>
      </div>

      <div class="modal-footer">
        <button on:click={() => (open = false)} class="cancel-button">
          Cancel
        </button>
        <button on:click={handleSave} class="save-button">
          Save Configuration
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: 9999;
    background-color: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }

  .modal-card {
    background-color: white;
    border-radius: 0.75rem;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    width: 100%;
    max-width: 32rem;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .modal-header {
    background-color: #f1f5f9;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid #e2e8f0;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .modal-title {
    font-size: 1.125rem;
    font-weight: 700;
    color: #1e293b;
    margin: 0;
  }

  .close-button {
    color: #64748b;
    background: none;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
    line-height: 1;
  }

  .close-button:hover {
    color: #334155;
  }

  .modal-body {
    padding: 1.5rem;
  }

  .description {
    font-size: 0.875rem;
    color: #475569;
    margin-bottom: 1rem;
    line-height: 1.25rem;
  }

  .steps-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .step-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.75rem;
    background-color: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 0.375rem;
    transition: all 0.2s ease;
  }

  .step-row.disabled {
    opacity: 0.6;
    background-color: #f1f5f9;
    border-color: #cbd5e1;
  }

  .step-main {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-grow: 1;
  }

  .step-number {
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    color: #94a3b8;
    width: 1rem;
  }

  .step-label {
    font-weight: 500;
    color: #334155;
  }

  .step-actions {
    display: flex;
    gap: 0.25rem;
  }

  .move-button {
    padding: 0.25rem;
    background: none;
    border: none;
    cursor: pointer;
    border-radius: 0.25rem;
    line-height: 1;
    color: #475569;
  }

  .move-button:hover:not(:disabled) {
    background-color: #e2e8f0;
  }

  .move-button:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  /* Toggle Switch Styles */
  .switch {
    position: relative;
    display: inline-block;
    width: 34px;
    height: 20px;
    flex-shrink: 0;
  }

  .switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .slider {
    position: absolute;
    cursor: pointer;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: #cbd5e1;
    transition: 0.4s;
  }

  .slider:before {
    position: absolute;
    content: "";
    height: 14px;
    width: 14px;
    left: 3px;
    bottom: 3px;
    background-color: white;
    transition: 0.4s;
  }

  input:checked + .slider {
    background-color: #4f46e5;
  }

  input:focus + .slider {
    box-shadow: 0 0 1px #4f46e5;
  }

  input:checked + .slider:before {
    transform: translateX(14px);
  }

  .slider.round {
    border-radius: 34px;
  }

  .slider.round:before {
    border-radius: 50%;
  }

  .modal-footer {
    background-color: #f8fafc;
    padding: 1rem 1.5rem;
    border-top: 1px solid #e2e8f0;
    display: flex;
    justify-content: end;
    gap: 0.75rem;
  }

  .cancel-button {
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: #334155;
    background: none;
    border: none;
    cursor: pointer;
    border-radius: 0.375rem;
  }

  .cancel-button:hover {
    color: #0f172a;
    background-color: #f1f5f9;
  }

  .save-button {
    background-color: #4f46e5;
    color: white;
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    font-weight: 700;
    border: none;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .save-button:hover {
    background-color: #4338ca;
  }
</style>
