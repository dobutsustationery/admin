import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

const includeLive = process.env.VITEST_INCLUDE_LIVE === "1";

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    include: ["tests/**/*.{test,spec}.{js,ts}"],
    exclude: includeLive ? [] : ["tests/live/**"],
    setupFiles: includeLive ? ["tests/live/setup.ts"] : [],
    ...(includeLive
      ? {
          fileParallelism: false,
          hookTimeout: 60000,
          testTimeout: 60000,
        }
      : {}),
  },
});
