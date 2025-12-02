# E2E Test Guidelines

This document outlines how to properly write end-to-end (E2E) tests for the Dobutsu Admin application using Playwright.

## Core Principles

### 1. Tests Must Come with Baseline Screenshots

**Every new E2E test must include committed baseline screenshots.** Tests will fail in CI if baselines are missing.

- Test authors are responsible for generating and committing baseline screenshots
- CI does not regenerate baselines - it only compares against existing ones
- Baseline screenshots serve as the visual "source of truth"

### 2. Zero-Pixel Tolerance

**Screenshots must match exactly - 0-pixel difference tolerance is enforced.**

The `playwright.config.ts` is configured with:

```typescript
expect: {
  toHaveScreenshot: {
    maxDiffPixels: 0,  // No pixels can differ
    threshold: 0,       // No color difference allowed
  },
},
```

This ensures:
- Consistent visual output across test runs
- Any visual regression is immediately caught
- Tests are deterministic and reproducible

### 3. No Arbitrary Delays or Retries

**Tests must not use arbitrary delays or rely on retries.**

❌ **Do NOT use:**
```typescript
await page.waitForTimeout(2000);  // Arbitrary delay
```

✅ **Instead, wait for specific conditions:**
```typescript
await page.locator('table').waitFor({ state: 'visible' });
await expect(page.locator('h1')).toBeVisible();
await page.waitForSelector('[data-testid="inventory-loaded"]');
```

**Retries are disabled in configuration:**
```typescript
retries: 0,  // Tests must pass on first attempt
```

If a test is flaky, fix the underlying issue rather than relying on retries.

### 4. Programmatic Verification is Required

**Every screenshot must be accompanied by programmatic verification of the page content or Redux store state.**

Visual snapshots alone are not sufficient. Each screenshot should verify that the application state matches expectations based on the test scenario.

✅ **Always include programmatic checks:**
```typescript
await screenshots.capture(page, 'inventory-loaded', {
  programmaticCheck: async () => {
    // Verify DOM content
    await expect(page.locator('table')).toBeVisible();
    const rowCount = await page.locator('table > tr').count();
    expect(rowCount).toBeGreaterThan(0);
    
    // Verify specific data
    const headers = await page.locator('table thead th').allTextContents();
    expect(headers).toContain('JAN Code');
    expect(headers).toContain('Quantity');
  }
});
```

**What to verify:**
- DOM elements are visible/hidden as expected
- Content matches expected values (text, counts, etc.)
- Data is correctly displayed (table rows, form values, etc.)
- Redux store state (if applicable, using page.evaluate())
- Network responses completed successfully
- Error states are shown/hidden appropriately

**Example verifying Redux store:**
```typescript
await screenshots.capture(page, 'after-update', {
  programmaticCheck: async () => {
    // Access Redux store from the page context
    const storeState = await page.evaluate(() => {
      return window.__REDUX_STORE__.getState();
    });
    
    expect(storeState.inventory.items.length).toBeGreaterThan(0);
    expect(storeState.inventory.selectedItem).toBeDefined();
  }
});
```

The `programmaticCheck` callback runs **before** the screenshot is captured, ensuring the page is in the correct state before visual verification.

## Writing a New E2E Test

### Step 1: Create the Test Directory and File

Create a new test directory following the naming convention `###-<testname>`:

```
e2e/###-<testname>/
├── ###-<testname>.spec.ts    # Test file
├── README.md                  # Documentation with screenshot gallery
└── screenshots/               # Baseline screenshots (committed)
```

For example:
```
e2e/000-inventory/
├── 000-inventory.spec.ts
├── README.md
└── screenshots/
    ├── 000-signed-out-state-chromium-linux.png
    ├── 001-signed-in-state-chromium-linux.png
    └── 002-inventory-loaded-chromium-linux.png
```

The three-digit prefix (e.g., `000`, `001`) helps organize tests in a specific order.

### Step 2: Use the Screenshot Helper

Import and use the screenshot helper for numbered screenshots. Note the relative path from the test subdirectory:

```typescript
import { test, expect } from '../fixtures/auth';
import { createScreenshotHelper } from '../helpers/screenshot-helper';

test.describe('Feature Name', () => {
  test('complete user workflow', async ({ page }) => {
    const screenshots = createScreenshotHelper();
    
    // Navigate to the page
    await page.goto('/your-route');
    
    // Wait for a specific element (NOT arbitrary timeout)
    await page.locator('h1').waitFor({ state: 'visible' });
    
    // Capture screenshot with programmatic verification
    await screenshots.capture(page, 'initial-state', {
      programmaticCheck: async () => {
        await expect(page.locator('h1')).toBeVisible();
      }
    });
    
    // Continue with user actions...
  });
});
```

### Step 3: Follow the User Story Pattern

Structure tests as complete user journeys:

```typescript
test('admin views and edits inventory item', async ({ page }) => {
  const screenshots = createScreenshotHelper();
  
  // STEP 1: Initial state
  await page.goto('/inventory');
  await page.locator('table').waitFor({ state: 'visible' });
  await screenshots.capture(page, 'inventory-list', {
    programmaticCheck: async () => {
      await expect(page.locator('table')).toBeVisible();
    }
  });
  
  // STEP 2: Select an item
  await page.locator('tr:first-child').click();
  await page.locator('.item-details').waitFor({ state: 'visible' });
  await screenshots.capture(page, 'item-selected', {
    programmaticCheck: async () => {
      await expect(page.locator('.item-details')).toBeVisible();
    }
  });
  
  // STEP 3: Edit the item
  await page.fill('input[name="quantity"]', '10');
  await page.click('button:has-text("Save")');
  await page.locator('.success-message').waitFor({ state: 'visible' });
  await screenshots.capture(page, 'item-saved', {
    programmaticCheck: async () => {
      await expect(page.locator('.success-message')).toBeVisible();
    }
  });
});
```

### Step 4: Generate Baseline Screenshots

After writing your test, generate the baseline screenshots:

```bash
# Start Firebase emulators (if needed)
npm run emulators

# Load test data with the same prefix used in CI (IMPORTANT!)
node e2e/helpers/load-test-data.js --prefix=400

# Build the application
npm run build:local

# Generate baselines for your new test
npx playwright test <test-name>.spec.ts --update-snapshots
```

**⚠️ CRITICAL**: Always use `--prefix=400` when loading test data for baseline generation. This must match the CI configuration to ensure consistent visual comparisons.

### Step 5: Verify and Commit Baselines

1. **Verify** the generated screenshots look correct
2. **Check** that screenshots are in `e2e/###-<testname>/screenshots/`
3. **Commit** the baseline screenshots with your test:

```bash
git add e2e/###-<testname>/
git commit -m "Add E2E test for <feature>"
```

### Step 6: Create Test Documentation

Create `e2e/###-<testname>/README.md` documenting:

- User story description
- Screenshot gallery with **direct links** to images in the `screenshots/` subdirectory
- What each screenshot verifies
- Manual verification checklist

The README should include direct image links like:
```markdown
![Screenshot 000](screenshots/000-initial-state-chromium-linux.png)
```

This allows users to view all screenshots directly in the README without navigating to other files.

See `e2e/000-inventory/README.md` as a template.

## Screenshot Helper API

The `createScreenshotHelper()` function provides:

```typescript
interface ScreenshotHelper {
  // Capture a numbered screenshot
  capture(
    page: Page,
    description: string,
    options?: {
      fullPage?: boolean;
      programmaticCheck?: () => Promise<void>;
    }
  ): Promise<void>;
  
  // Reset counter (for new test)
  reset(): void;
  
  // Get current counter value
  getCounter(): number;
}
```

**Screenshot naming:** `NNN-description.png` (e.g., `000-initial-state.png`, `001-after-login.png`)

## Waiting for Elements

### Correct Patterns

```typescript
// Wait for element to be visible
await page.locator('selector').waitFor({ state: 'visible' });

// Wait for element to be hidden
await page.locator('selector').waitFor({ state: 'hidden' });

// Wait for element to be attached to DOM
await page.locator('selector').waitFor({ state: 'attached' });

// Use expect with auto-waiting
await expect(page.locator('selector')).toBeVisible();
await expect(page.locator('selector')).toHaveText('expected text');

// Wait for network requests to complete
await page.waitForResponse(response => 
  response.url().includes('/api/data') && response.status() === 200
);
```

### Incorrect Patterns

```typescript
// ❌ NEVER use arbitrary delays
await page.waitForTimeout(2000);

// ❌ NEVER use sleep/delay functions
await new Promise(resolve => setTimeout(resolve, 1000));

// ❌ NEVER use polling with arbitrary intervals
while (true) {
  await page.waitForTimeout(500);
  if (await page.locator('.element').isVisible()) break;
}
```

## Updating Existing Tests

When you change the UI and need to update baselines:

1. **Ensure emulators are running and test data is loaded**:
   ```bash
   # Terminal 1: Start emulators
   npm run emulators
   
   # Terminal 2: Load test data with correct prefix
   node e2e/helpers/load-test-data.js --prefix=400
   ```

2. **Build the application**:
   ```bash
   npm run build:local
   ```

3. **Run the test** to see the failure:
   ```bash
   npx playwright test e2e/###-<testname>/###-<testname>.spec.ts
   ```

4. **Review the diff** in `test-results/` directory

5. **If the change is intentional**, update baselines:
   ```bash
   npx playwright test e2e/###-<testname>/###-<testname>.spec.ts --update-snapshots
   ```

6. **Verify and commit** the new baselines:
   ```bash
   git add e2e/###-<testname>/screenshots/
   git commit -m "Update baselines for <reason>"
   ```

**⚠️ IMPORTANT**: Always use `--prefix=400` when loading test data. This matches the CI configuration.

## Test Structure

```
e2e/
├── fixtures/                      # Custom Playwright fixtures
│   └── auth.ts                   # Authentication fixture
├── helpers/                       # Helper utilities
│   ├── load-test-data.js         # Loads test data into emulator
│   └── screenshot-helper.ts      # Numbered screenshot helper
├── ###-<testname>/                # Test directory (e.g., 000-inventory)
│   ├── ###-<testname>.spec.ts    # Test file
│   ├── README.md                 # User story, screenshot gallery (with direct image links)
│   └── screenshots/              # Baseline screenshots (committed)
│       ├── 000-initial-state-chromium-linux.png
│       ├── 001-after-action-chromium-linux.png
│       └── ...
├── screenshots/                   # Runtime screenshots (gitignored)
└── README.md                     # E2E overview documentation
```

## Running Tests

```bash
# Full test run with emulator management
npm run test:e2e

# Simple run (assumes emulators already running)
npm run test:e2e:simple

# Interactive UI mode
npm run test:e2e:ui

# Headed mode (see browser)
npm run test:e2e:headed

# View test report
npm run test:e2e:report

# Update snapshots
npx playwright test --update-snapshots
```

## Debugging Failed Tests

1. **View the HTML report:**
   ```bash
   npm run test:e2e:report
   ```

2. **Check diff images** in `test-results/` for visual differences

3. **Run in headed mode** to see what's happening:
   ```bash
   npm run test:e2e:headed
   ```

4. **Use UI mode** for step-by-step debugging:
   ```bash
   npm run test:e2e:ui
   ```

## Checklist for New Tests

Before submitting a PR with a new E2E test, verify:

- [ ] Test directory created as `e2e/###-<testname>/`
- [ ] Test file named `e2e/###-<testname>/###-<testname>.spec.ts`
- [ ] Test uses `createScreenshotHelper()` for screenshots
- [ ] **Every screenshot includes programmatic verification via `programmaticCheck`**
- [ ] Test waits for specific conditions (no arbitrary delays)
- [ ] Test does not rely on retries
- [ ] Baseline screenshots generated with `--update-snapshots`
- [ ] Baseline screenshots stored in `e2e/###-<testname>/screenshots/`
- [ ] Baseline screenshots committed to git
- [ ] Test documentation created in `e2e/###-<testname>/README.md`
- [ ] **README includes direct links to screenshots** (e.g., `![Screenshot](screenshots/000-example.png)`)
- [ ] Test passes consistently when run multiple times
- [ ] Test passes with zero-pixel tolerance

## Example: Complete Test

See `e2e/000-inventory/000-inventory.spec.ts` for a complete example following these guidelines.

```typescript
import { test, expect } from "../fixtures/auth";
import { createScreenshotHelper } from "../helpers/screenshot-helper";

test.describe("Inventory Page", () => {
  test("complete inventory workflow", async ({ page }) => {
    const screenshots = createScreenshotHelper();
    
    // STEP 1: Navigate (signed out)
    await page.goto("/inventory");
    const signInButton = page.locator('button:has-text("Sign In")');
    await signInButton.waitFor({ state: 'visible' });
    
    await screenshots.capture(page, "signed-out-state", {
      programmaticCheck: async () => {
        await expect(signInButton).toBeVisible();
      }
    });
    
    // STEP 2: Sign in
    // ... authentication logic ...
    
    // STEP 3: View inventory
    const inventoryTable = page.locator('table');
    await inventoryTable.waitFor({ state: 'visible' });
    
    await screenshots.capture(page, "inventory-loaded", {
      programmaticCheck: async () => {
        await expect(inventoryTable).toBeVisible();
        const rowCount = await page.locator('table > tr').count();
        expect(rowCount).toBeGreaterThan(0);
      }
    });
  });
});
```

## Related Documentation

- [E2E Test Overview](e2e/README.md)
- [Inventory Test Example](e2e/inventory/README.md)
- [Playwright Documentation](https://playwright.dev/)
