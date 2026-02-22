import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

export default defineConfig({
  ...baseConfig,
  testIgnore: ["e2e/live/**", "e2e/experiments/**"],
  webServer: {
    ...baseConfig.webServer,
    reuseExistingServer: false,
  },
});
