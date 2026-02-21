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
      // Use 'image/png' for transparency support
      // options: { fillColor: 'transparent' } is default, but ensuring it helps
      cropperInstance
        .getCroppedCanvas({ fillColor: "transparent" })
        .toBlob((blob: Blob | null) => {
          if (blob) {
            dispatch("save", blob);
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
        <h3 class="font-bold text-lg">Manual Crop</h3>
        <button
          class="text-gray-500 hover:text-gray-700"
          on:click={handleCancel}>✕</button
        >
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
        <div class="flex items-center gap-4">
          <span class="text-sm font-bold text-gray-500 w-16">Rotate</span>
          <input
            type="range"
            class="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
            min="-45"
            max="45"
            step="0.1"
            bind:value={rotation}
            on:input={handleRotationChange}
          />
          <span class="text-xs font-mono w-12 text-right"
            >{rotation.toFixed(1)}°</span
          >
        </div>

        <div class="flex justify-end gap-2">
          <button
            class="px-4 py-2 text-gray-700 font-medium hover:bg-gray-200 rounded"
            on:click={handleCancel}>Cancel</button
          >
          <button
            class="px-6 py-2 bg-indigo-600 text-white font-bold rounded hover:bg-indigo-700 shadow-sm"
            on:click={handleSave}>Apply Crop</button
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
</style>
