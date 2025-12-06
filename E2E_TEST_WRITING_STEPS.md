# How to Write E2E Tests

This document provides step-by-step instructions and best practices for writing E2E tests that conform to the repository's strict verification standards.

## 1. Test Structure

Create a new directory `e2e/###-<name>/`:
- `###-<name>.spec.ts`: The Playwright test.
- `README.md`: The Verification Document (see guidelines).
- `screenshots/`: Directory for baseline images.

## 2. Writing the Test

### Use `createScreenshotHelper`
**Always** use the helper to ensure programmatic verification runs before capture.

```typescript
import { createScreenshotHelper } from "../helpers/screenshot-helper";

test("example workflow", async ({ page }) => {
  const screenshots = createScreenshotHelper();
  
  // Navigate
  await page.goto("/page");
  
  // Capture
  await screenshots.capture(page, "initial-state", {
    programmaticCheck: async () => {
      await expect(page.locator("h1")).toBeVisible();
    }
  });
});
```

### DOs and DON'Ts

#### Waiting
✅ **DO** wait for specific properties:
```typescript
await expect(page.locator("button")).toBeVisible();
await page.locator("table").waitFor({ state: "visible" });
```

❌ **DON'T** use arbitrary delays:
```typescript
await page.waitForTimeout(1000); // FORBIDDEN
```

#### Programmatic Verification
✅ **DO** verify state logic code:
```typescript
programmaticCheck: async () => {
    const count = await page.locator("tr").count();
    expect(count).toBeGreaterThan(0);
}
```

❌ **DON'T** rely on the screenshot alone.

## 3. Generating Baselines

Baselines must be generated with strict data matching.

1.  **Start Emulators**: `npm run emulators`
2.  **Load Data**: `node e2e/helpers/load-test-data.js --match-jancodes=10` (**CRITICAL**)
3.  **Run Test**: `npx playwright test e2e/path/to/test.spec.ts --update-snapshots`

## 4. Checklist

- [ ] Directory follows `###-name` format.
- [ ] Screenshot links in `README.md` work locally and on GitHub.
- [ ] No `waitForTimeout` usage.
- [ ] Every screenshot has a `programmaticCheck`.
