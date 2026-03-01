<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy, tick } from "svelte";
  // @ts-ignore
  import Cropper from "cropperjs/dist/cropper.js";
  import "cropperjs/dist/cropper.css";

  export let imageUrl: string;
  export let open = false;

  const dispatch = createEventDispatcher();

  let imageElement: HTMLImageElement;
  let cropperInstance: any = null; // Use any to avoid TS type fights if d.ts is missing for UMD
  let rotation = 0;

  onDestroy(() => {
    destroyCropper();
  });

  $: if (open && imageUrl) {
    tick().then(() => {
      if (imageElement) {
        if (imageElement.complete) {
          initCropper();
        }
      }
    });
  } else if (!open) {
    destroyCropper();
  }

  function destroyCropper() {
    if (cropperInstance) {
      cropperInstance.destroy();
      cropperInstance = null;
    }
    if (imageElement && (imageElement as any).cropper) {
      (imageElement as any).cropper.destroy();
    }
  }

  function onImageLoad() {
    initCropper();
  }

  function initCropper() {
    if (!imageElement || !open) return;

    destroyCropper();

    console.log("Initializing Cropper (v1.5.13 UMD)...", imageElement);
    try {
      // Create instance
      const c = new Cropper(imageElement, {
        viewMode: 1,
        dragMode: "crop",
        initialAspectRatio: NaN,
        autoCropArea: 0.8,
        responsive: true,
        restore: false,
        checkCrossOrigin: false,
        ready() {
          console.log("Cropper Ready. Instance:", this.cropper);
          // In UMD/v1, 'this' in ready usually refers to the element, and this.cropper is the instance.
          if (rotation !== 0 && this.cropper) {
            this.cropper.rotateTo(rotation);
          }
        },
      });

      cropperInstance = c;
      console.log("Cropper constructed:", c);
      console.log("Has rotateTo?", typeof c.rotateTo);
    } catch (e) {
      console.error("Cropper Init Error:", e);
    }
  }

  function handleRotationChange() {
    if (cropperInstance && typeof cropperInstance.rotateTo === "function") {
      cropperInstance.rotateTo(rotation);
    } else {
      console.warn("Rotate failed. Instance:", cropperInstance);
    }
  }

  async function handleSave() {
    if (!cropperInstance) return;

    try {
      // Get crop data for derivation key
      const cropData = cropperInstance.getData();

      // Use 'image/png' for transparency support
      cropperInstance
        .getCroppedCanvas({ fillColor: "transparent" })
        .toBlob((blob: Blob | null) => {
          if (blob) {
            dispatch("save", {
              blob,
              cropData: {
                x: Math.round(cropData.x),
                y: Math.round(cropData.y),
                width: Math.round(cropData.width),
                height: Math.round(cropData.height),
                rotate: Math.round(cropData.rotate),
              },
            });
            open = false;
          }
        }, "image/png");
    } catch (e) {
      console.error("Crop save failed", e);
    }
  }

  function handleCancel() {
    open = false;
    dispatch("cancel");
  }
</script>

{#if open}
  <div class="modal-overlay">
    <div class="modal-card">
      <!-- Header (Row 1) -->
      <div class="modal-header">
        <h3 class="modal-title">Manual Crop</h3>
        <button class="close-btn" on:click={handleCancel}>✕</button>
      </div>

      <!-- Body (Row 2) -->
      <div class="modal-body">
        <div class="cropper-wrapper">
          <!-- Cropper replaces this img -->
          <img
            bind:this={imageElement}
            src={imageUrl}
            alt="Crop Target"
            style="display: block; max-width: 100%; max-height: 100%;"
            on:load={onImageLoad}
          />
        </div>
      </div>

      <!-- Footer (Row 3) -->
      <div class="modal-footer">
        <div class="controls-row">
          <span class="label">Rotate</span>
          <input
            type="range"
            class="rotate-slider"
            min="-45"
            max="45"
            step="0.1"
            bind:value={rotation}
            on:input={handleRotationChange}
          />
          <span class="value-display">{rotation.toFixed(1)}°</span>
        </div>

        <div class="actions-row">
          <button class="btn btn-cancel" on:click={handleCancel}>Cancel</button>
          <button class="btn btn-apply" on:click={handleSave}>Apply Crop</button
          >
        </div>
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
    background-color: rgba(0, 0, 0, 0.8);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }

  .modal-card {
    position: relative;
    background-color: white;
    border-radius: 0.75rem;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    width: 80vw;
    height: 80vh;

    /* Grid Layout */
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    overflow: hidden;
  }

  .modal-header {
    padding: 1rem;
    border-bottom: 1px solid #e5e7eb; /* gray-200 */
    background-color: #f9fafb; /* gray-50 */
    display: flex;
    justify-content: space-between;
    align-items: center;
    z-index: 20;
    position: relative;
  }

  .modal-title {
    font-weight: 700; /* font-bold */
    font-size: 1.125rem; /* text-lg */
    margin: 0;
  }

  .close-btn {
    color: #6b7280; /* text-gray-500 */
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1.25rem;
    transition: color 0.2s;
  }

  .close-btn:hover {
    color: #374151; /* text-gray-700 */
  }

  .modal-body {
    position: relative;
    background-color: #111827; /* gray-900 */
    width: 100%;
    overflow: hidden;
    padding: 1rem;
  }

  .cropper-wrapper {
    width: 100%;
    height: 100%;
    position: relative;
  }

  .modal-footer {
    padding: 1rem;
    border-top: 1px solid #e5e7eb; /* gray-200 */
    background-color: #f9fafb; /* gray-50 */
    display: flex;
    flex-direction: column;
    gap: 1rem;
    z-index: 20;
    position: relative;
  }

  .controls-row {
    display: flex;
    align-items: center;
    gap: 1rem; /* gap-4 */
  }

  .label {
    font-size: 0.875rem; /* text-sm */
    font-weight: 700; /* font-bold */
    color: #6b7280; /* text-gray-500 */
    width: 4rem; /* w-16 */
  }

  .rotate-slider {
    flex: 1;
    height: 0.5rem; /* h-2 */
    background-color: #e5e7eb; /* bg-gray-200 */
    border-radius: 0.5rem; /* rounded-lg */
    appearance: none;
    cursor: pointer;
  }

  .value-display {
    font-size: 0.75rem; /* text-xs */
    font-family: ui-monospace, monospace; /* font-mono */
    width: 3rem; /* w-12 */
    text-align: right;
  }

  .actions-row {
    display: flex;
    justify-content: flex-end; /* justify-end */
    gap: 0.5rem; /* gap-2 */
  }

  .btn {
    padding: 0.5rem 1rem;
    border-radius: 0.25rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    border: none;
  }

  .btn-cancel {
    color: #374151; /* text-gray-700 */
    background: transparent;
  }

  .btn-cancel:hover {
    background-color: #e5e7eb; /* hover:bg-gray-200 */
  }

  .btn-apply {
    background-color: #4f46e5; /* bg-indigo-600 */
    color: white;
    font-weight: 700; /* font-bold */
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); /* shadow-sm */
    padding-left: 1.5rem;
    padding-right: 1.5rem;
  }

  .btn-apply:hover {
    background-color: #4338ca; /* hover:bg-indigo-700 */
  }
</style>
