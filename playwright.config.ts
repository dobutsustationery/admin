import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for E2E tests
 *
 * These tests run against a local build with Firebase emulators.
 * Prerequisites:
 * - Firebase emulators must be running (npm run emulators)
 * - Test data must be loaded into emulator (node e2e/helpers/load-test-data.js)
 * - App must be built for emulator mode (npm run build:local)
 */
export default defineConfig({
  testDir: "./e2e",
  /* Run tests in files in parallel */
  fullyParallel: false,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: 1,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [["html", { outputFolder: "e2e/reports/html" }], ["list"]],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: "http://localhost:5173",
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "on-first-retry",
    screenshot: "on",
    video: "retain-on-failure",
  },

  /* Configure visual regression testing */
  expect: {
    toHaveScreenshot: {
      /* Maximum allowed pixel difference ratio (0.0 to 1.0) */
      maxDiffPixelRatio: 0.01,
      /* Threshold for pixel comparison (0-1, higher = more tolerant) */
      threshold: 0.2,
    },
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  /* Run your local dev server before starting the tests */
  webServer: {
    command: "npm run dev:local",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: {
      VITE_FIREBASE_ENV: "local",
      VITE_FIREBASE_LOCAL_PROJECT_ID: "demo-test-project",
      VITE_EMULATOR_FIRESTORE_HOST: "localhost",
      VITE_EMULATOR_FIRESTORE_PORT: "8080",
      VITE_EMULATOR_AUTH_HOST: "localhost",
      VITE_EMULATOR_AUTH_PORT: "9099",
    },
  },
});
