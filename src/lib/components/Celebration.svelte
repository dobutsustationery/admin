<script lang="ts">
  import { onMount } from "svelte";
  import confetti from "canvas-confetti";

  onMount(() => {
    // Fire confetti from the center
    const count = 200;
    const defaults = {
      origin: { y: 0.7 },
    };

    function fire(particleRatio: number, opts: any) {
      confetti(
        Object.assign({}, defaults, opts, {
          particleCount: Math.floor(count * particleRatio),
        }),
      );
    }

    fire(0.25, {
      spread: 26,
      startVelocity: 55,
    });
    fire(0.2, {
      spread: 60,
    });
    fire(0.35, {
      spread: 100,
      decay: 0.91,
      scalar: 0.8,
    });
    fire(0.1, {
      spread: 120,
      startVelocity: 25,
      decay: 0.92,
      scalar: 1.2,
    });
    fire(0.1, {
      spread: 120,
      startVelocity: 45,
    });
  });
</script>

<div class="celebration-overlay">
  <div class="content">
    <h1 class="victory-title">Batch Complete!</h1>
    <p class="victory-message">Great job! All listings have been processed.</p>
  </div>
</div>

<style>
  .celebration-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.9);
    z-index: 9999;
    pointer-events: none; /* Let clicks pass through if needed, or block? */
    animation: fadeOut 3s forwards;
    animation-delay: 2s;
  }

  .content {
    text-align: center;
    background: white;
    padding: 2rem;
    border-radius: 1rem;
    box-shadow:
      0 20px 25px -5px rgba(0, 0, 0, 0.1),
      0 10px 10px -5px rgba(0, 0, 0, 0.04);
    border: 2px solid #3b82f6;
  }

  .victory-title {
    font-size: 2.25rem; /* text-4xl */
    font-weight: 700; /* font-bold */
    color: #2563eb; /* text-blue-600 */
    margin-bottom: 1rem; /* mb-4 */
    animation: bounce 1s infinite;
  }

  .victory-message {
    font-size: 1.25rem; /* text-xl */
    color: #374151; /* text-gray-700 */
  }

  @keyframes bounce {
    0%,
    100% {
      transform: translateY(-25%);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    50% {
      transform: translateY(0);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
  }

  @keyframes fadeOut {
    from {
      opacity: 1;
    }
    to {
      opacity: 0;
      visibility: hidden;
    }
  }
</style>
