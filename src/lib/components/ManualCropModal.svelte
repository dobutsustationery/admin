<script lang="ts">
  import Cropper from 'svelte-easy-crop';
  import { createEventDispatcher } from 'svelte';

  export let imageUrl: string;
  export let open = false;

  const dispatch = createEventDispatcher();
  let crop = { x: 0, y: 0 };
  let zoom = 1;
  let aspect = 1; // Default square? Users might want free form or product default. 
                  // For products, usually square (1) or 4:3? Let's defaulting to Free or 1.
                  // User "Manual Crop" -> "Select the crop and apply". Usually arbitrary.
                  // svelte-easy-crop handles aspect. If undefined, it's free.
                  
  let pixelCrop: any;

  function onCropComplete(e: CustomEvent) {
    pixelCrop = e.detail.pixels;
  }

  async function getCroppedImg(imageSrc: string, pixelCrop: any) {
      const image = await createImage(imageSrc);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      canvas.width = pixelCrop.width;
      canvas.height = pixelCrop.height;

      ctx.drawImage(
          image,
          pixelCrop.x,
          pixelCrop.y,
          pixelCrop.width,
          pixelCrop.height,
          0,
          0,
          pixelCrop.width,
          pixelCrop.height
      );

      return new Promise<Blob | null>((resolve) => {
          canvas.toBlob((blob) => {
              resolve(blob);
          }, 'image/jpeg');
      });
  }

  const createImage = (url: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.addEventListener('load', () => resolve(image));
      image.addEventListener('error', (error) => reject(error));
      image.setAttribute('crossOrigin', 'anonymous'); 
      image.src = url;
    });

  async function handleSave() {
      try {
        const blob = await getCroppedImg(imageUrl, pixelCrop);
        if (blob) {
            dispatch('save', blob);
            open = false;
        }
      } catch (e) {
          console.error("Crop failed", e);
      }
  }

  function handleCancel() {
      open = false;
      dispatch('cancel');
  }
</script>

{#if open}
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
        <div class="bg-white rounded-xl shadow-2xl w-full max-w-4xl h-[80vh] flex flex-col overflow-hidden">
            <div class="p-4 border-b flex justify-between items-center bg-gray-50">
                <h3 class="font-bold text-lg">Manual Crop</h3>
                <button class="text-gray-500 hover:text-gray-700" on:click={handleCancel}>✕</button>
            </div>
            
            <div class="flex-1 relative bg-gray-900">
                 <Cropper
                    image={imageUrl}
                    bind:crop
                    bind:zoom
                    aspect={1} 
                    on:cropcomplete={onCropComplete}
                    showGrid={true}
                 />
            </div>
            
            <div class="p-4 border-t bg-gray-50 flex justify-between items-center gap-4">
                <div class="flex items-center gap-2">
                    <span class="text-sm font-bold text-gray-500">Zoom</span>
                    <input type="range" class="w-32" min="1" max="3" step="0.1" bind:value={zoom} />
                </div>
                <div class="flex gap-2">
                    <button class="px-4 py-2 text-gray-700 font-medium hover:bg-gray-200 rounded" on:click={handleCancel}>Cancel</button>
                    <button class="px-6 py-2 bg-indigo-600 text-white font-bold rounded hover:bg-indigo-700 shadow-sm" on:click={handleSave}>Apply Crop</button>
                </div>
            </div>
        </div>
    </div>
{/if}

<style>
    /* Override cropper styles if needed */
</style>
