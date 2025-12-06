import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for E2E tests
 *
 * These tests run against a production build with Firebase emulators.
 * Prerequisites:
 * - Firebase emulators must be running (npm run emulators)
 * - Test data must be loaded into emulator (node e2e/helpers/load-test-data.js --match-jancodes=10)
 * - App must be built for emulator mode (npm run build:local)
 * - Preview server will be started automatically by Playwright (vite preview)
 */
export default defineConfig({
  testDir: "./e2e",
  /* Run tests in files in parallel */
  fullyParallel: false,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* No retries - tests must pass consistently on every run */
  retries: 0,
  /* Opt out of parallel tests on CI. */
  workers: 1,
  /* Global timeout for each test - increased for large datasets */
  timeout: 60000, // 60 seconds per test
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [["html", { outputFolder: "e2e/reports/html" }], ["list"]],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: "http://localhost:4173",
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "on-first-retry",
    screenshot: "on",
    video: "retain-on-failure",
  },

  /* Configure visual regression testing - 0-pixel tolerance required */
  expect: {
    toHaveScreenshot: {
      /* Zero tolerance - screenshots must match exactly */
      maxDiffPixels: 0,
      /* Zero threshold - no color difference allowed */
      threshold: 0,
      /* Increased timeout for large datasets - 50 seconds */
      timeout: 50000,
    },
  },

  /* Custom snapshot path template to support new folder structure */
  /* This places screenshots in e2e/###-testname/screenshots/ alongside the test file */
  /* Format: {testDir}/{testFileDir}/screenshots/{arg}{ext} */
  /* We omit {snapshotSuffix} to avoid platform-specific duplicates since we only test on one platform */
  /* Example: e2e/000-inventory/screenshots/000-initial-state.png */
  snapshotPathTemplate: "{testDir}/{testFileDir}/screenshots/{arg}{ext}",

  /* Configure projects for major browsers */
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Ensure consistent font rendering across environments
        // This prevents column width differences due to font variations
        launchOptions: {
          args: [
            '--font-render-hinting=none',
            '--disable-font-subpixel-positioning',
          ],
        },
      },
    },
  ],

  /* Run preview server with built application */
  webServer: {
    command: "vite preview --port 4173",
    url: "http://localhost:4173",
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
