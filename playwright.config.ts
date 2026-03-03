import { defineConfig, devices } from "@playwright/test";

const previewPort = Number(process.env.E2E_PREVIEW_PORT || "4173");
const firestoreEmulatorPort = process.env.E2E_FIRESTORE_EMULATOR_PORT || "8080";
const authEmulatorPort = process.env.E2E_AUTH_EMULATOR_PORT || "9099";
const baseUrl = `http://localhost:${previewPort}`;

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
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.3,
    },
  },
  /* No retries - tests must pass consistently on every run */
  retries: 0,
  /* Opt out of parallel tests on CI. */
  workers: 1,
  /* Global timeout for each test - increased for large datasets */
  timeout: 10000,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [["html", { outputFolder: "e2e/reports/html" }], ["list"]],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: baseUrl,
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "on-first-retry",
    screenshot: "on",
    video: "retain-on-failure",
    /* Disable animations for stable screenshots */
    animations: "disabled",
  },

  /* Configure visual regression testing */
  expect: {
    toHaveScreenshot: {
      /* Small tolerance for antialiasing flakes */
      maxDiffPixelRatio: 0.01,
      /* Small threshold for subtle color differences */
      threshold: 0.1,
      /* Hide blinking caret to prevent visual regression failure */
      caret: "hide",
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
        deviceScaleFactor: 1, // Ensure standard pixel density
        timezoneId: "UTC", // Ensure consistent date rendering across environments
        // Ensure consistent font rendering across environments
        // This prevents column width differences due to font variations
        launchOptions: {
          args: [
            "--font-render-hinting=none",
            "--disable-font-subpixel-positioning",
            "--force-color-profile=srgb",
          ],
        },
      },
    },
  ],

  /* Run preview server with built application */
  webServer: {
    command: `vite preview --port ${previewPort}`,
    url: baseUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: {
      VITE_FIREBASE_ENV: "local",
      VITE_FIREBASE_LOCAL_PROJECT_ID: "demo-test-project",
      VITE_EMULATOR_FIRESTORE_HOST: "localhost",
      VITE_EMULATOR_FIRESTORE_PORT: firestoreEmulatorPort,
      VITE_EMULATOR_AUTH_HOST: "localhost",
      VITE_EMULATOR_AUTH_PORT: authEmulatorPort,
      // Mock Google Drive credentials for E2E testing
      // These show the Drive UI in "configured but not authenticated" state
      // No actual Drive API calls are made in tests
      VITE_GOOGLE_DRIVE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
      VITE_GOOGLE_DRIVE_FOLDER_ID: "test-folder-id-12345",
      VITE_GOOGLE_DRIVE_SCOPES: "https://www.googleapis.com/auth/drive.file",
    },
  },
});
