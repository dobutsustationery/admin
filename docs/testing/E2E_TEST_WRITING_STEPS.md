# How to Write E2E Tests

This document provides step-by-step instructions and best practices for writing E2E tests that conform to the repository's strict verification standards.

## 1. Test Structure

Create a new directory `e2e/###-<name>/`:
- `###-<name>.spec.ts`: The Playwright test.
- `README.md`: The Verification Document (see guidelines).
- `screenshots/`: Directory for baseline images.

## 2. Writing the Test

### Use `TestDocumentationHelper`
**Always** use the helper to ensure programmatic verification is documented and runs before capture.

**CRITICAL**: The `screenshots` helper auto-increments from 000. The filename passed to `docHelper.addStep()` must match the auto-generated number.

```typescript
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import { TestDocumentationHelper } from "../helpers/test-documentation-helper";
import * as path from "path";

test("example workflow", async ({ page }, testInfo) => {
  const screenshots = createScreenshotHelper();  // Starts counter at 0
  const docHelper = new TestDocumentationHelper(path.dirname(testInfo.file));
  
  docHelper.setMetadata(
    "Example Verification",
    "**As a** user..."
  );

  // Navigate
  await page.goto("/page");
  
  // Define checks
  const verifications = [
    {
      description: 'Validated header is visible',
      check: async () => {
        await expect(page.locator("h1")).toBeVisible();
      }
    }
  ];

  // Register step with filename 000-* (first screenshot)
  docHelper.addStep("Initial State", "000-initial-state.png", verifications);
  
  // Capture generates 000-initial-state.png (counter starts at 0)
  await screenshots.capture(page, "initial-state", {
    programmaticCheck: async () => {
       for (const v of verifications) await v.check();
    }
  });
  // Counter is now 1
  
  // Next step would use "001-next-step.png" in addStep()
  // and "next-step" in screenshots.capture()
  
  // Generate Documentation (creates README.md)
  docHelper.writeReadme();
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
