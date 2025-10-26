import { defineConfig, devices } from "@playwright/test";

/**
 * Basic Playwright configuration for testing screenshot functionality
 * without needing to start the app server
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/test-playwright-basic.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
