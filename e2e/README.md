# End-to-End Tests

This directory contains Playwright-based E2E tests for the Dobutsu Admin application.

## Overview

The E2E tests verify that the application works correctly when integrated with Firebase emulators. They test:

- **Inventory Page**: Loads and displays inventory data from Firestore
- **Authentication**: Mocks Firebase Auth to bypass login
- **Data Loading**: Verifies test data from `test-data/firestore-export.json` is properly loaded

## Prerequisites

1. **Node.js 18+** or **Bun 1.0+**
2. **Firebase CLI**: Available via `npx firebase-tools` or `npm install -g firebase-tools`
3. **Playwright**: Installed via `npm install`
4. **Network Access**: Firebase emulators require downloading JAR files on first run

## Running Tests

### In CI/GitHub Actions (Recommended)

The tests are designed to run in GitHub Actions where network access is available for downloading Firebase emulators. Simply push to your branch or create a PR, and the tests will run automatically.

### Locally (If Firebase Emulators Can Be Downloaded)

#### Option 1: All-in-One Script

```bash
npm run test:e2e
```

This script will:
1. Start Firebase emulators if not already running
2. Load test data into the emulator
3. Build the application for emulator mode
4. Run Playwright tests
5. Clean up emulators afterwards

#### Option 2: Manual Control

If you prefer to run tests manually with emulators already running:

```bash
# Terminal 1: Start Firebase emulators
npm run emulators

# Terminal 2: Run tests (simpler script for when emulators are running)
npm run test:e2e:simple
```

### Other Test Commands

```bash
# Run tests in UI mode (interactive)
npm run test:e2e:ui

# Run tests in headed mode (see browser)
npm run test:e2e:headed

# View test report
npm run test:e2e:report
```

## Test Structure

```
e2e/
├── fixtures/                      # Custom Playwright fixtures
│   └── auth.ts                   # Authentication fixture
├── helpers/                       # Helper scripts and utilities
│   ├── load-test-data.js         # Loads test data into emulator
│   └── screenshot-helper.ts      # Helper for numbered screenshots
├── inventory/                     # Inventory test documentation
│   └── README.md                 # User story, screenshots, verification
├── inventory.spec.ts             # Inventory page E2E test
├── inventory.spec.ts-snapshots/  # Baseline screenshots for inventory test
│   ├── 000-signed-out-state-chromium-linux.png
│   ├── 001-signed-in-state-chromium-linux.png
│   ├── 002-inventory-loaded-chromium-linux.png
│   └── README.md                 # Snapshot documentation
├── screenshots/                   # Runtime screenshots (gitignored)
├── reports/                       # Test reports (gitignored)
├── run-tests.sh                   # Full test runner with emulator management
└── run-tests-simple.sh            # Simple test runner (assumes emulators running)
```

Each test follows the pattern:
- `<name>.spec.ts` - The test file with user story
- `<name>/README.md` - Documentation with screenshot gallery
- `<name>.spec.ts-snapshots/` - Baseline screenshots (checked into git)

## Writing Tests

### Test Strategy: User Story with Numbered Screenshots

E2E tests follow a **user story pattern** with numbered screenshots that tell a coherent story:

- Each test represents a complete user journey
- Screenshots are numbered sequentially: `000-description.png`, `001-description.png`, etc.
- Tests start from a signed-out state and progress through realistic user interactions
- Each screenshot has both **programmatic verification** (assertions) and **visual verification**
- Each test has a dedicated README documenting the story and what to verify

**Example: Inventory Page Test**

See [e2e/inventory/README.md](inventory/README.md) for a complete example.

### Writing a User Story Test

```typescript
import { test, expect } from './fixtures/auth';
import { createScreenshotHelper } from './helpers/screenshot-helper';

test('complete user workflow', async ({ page }) => {
  const screenshots = createScreenshotHelper();
  
  // Step 1: Starting state
  await page.goto('/my-route');
  await screenshots.capture(page, 'initial-state', {
    programmaticCheck: async () => {
      await expect(page.locator('h1')).toBeVisible();
    }
  });
  
  // Step 2: User action
  await page.click('button:has-text("Click Me")');
  await screenshots.capture(page, 'after-click', {
    programmaticCheck: async () => {
      await expect(page.locator('.result')).toHaveText('Success');
    }
  });
  
  // Step 3: Final state
  // ... continue the story
});
```

### Screenshot Helper

Use `createScreenshotHelper()` to manage numbered screenshots:

```typescript
const screenshots = createScreenshotHelper();

// Captures 000-description.png
await screenshots.capture(page, 'description');

// Captures 001-next-step.png
await screenshots.capture(page, 'next-step', {
  fullPage: true,  // Optional
  programmaticCheck: async () => {
    // Run assertions before screenshot
    await expect(page.locator('.element')).toBeVisible();
  }
});

screenshots.getCounter(); // Returns 2
screenshots.reset(); // Reset counter to 0
```

### Creating Test Documentation

Each test should have a README in `e2e/<test-name>/README.md` that includes:

1. **User Story**: Who, what, why
2. **Screenshot Gallery**: Each screenshot with:
   - Image preview
   - What it shows
   - Programmatic verification performed
   - Manual verification checklist
3. **Test Data**: What data is used
4. **Running Instructions**: How to run the test
5. **Troubleshooting**: Common issues

See [e2e/inventory/README.md](inventory/README.md) as a template.

### Basic Test Structure

For simple tests that don't need the full user story pattern:

```typescript
import { test, expect } from '@playwright/test';

test('my test', async ({ page }) => {
  await page.goto('/my-route');
  
  // Your test assertions
  await expect(page.locator('h1')).toBeVisible();
});
```

### Authentication

Tests can use the `authenticatedPage` fixture for pre-authenticated tests:

```typescript
test('authenticated test', async ({ authenticatedPage: page }) => {
  // User is already signed in
  await page.goto('/protected-route');
});
```

Or handle authentication manually within the test for user story tests.

### Test Data

Test data is loaded from `test-data/firestore-export.json` before tests run. This includes:
- `broadcast` collection: Action history for state reconstruction
- `users` collection: Admin user data
- `dobutsu` collection: Orders and payments

### Visual Regression Testing

All screenshots use Playwright's visual regression testing with **zero-pixel tolerance**:

**How it works:**
1. Baseline screenshots are stored in `e2e/<test-name>.spec.ts-snapshots/`
2. Tests compare current screenshots against baselines with exact pixel matching
3. Tests fail if **any** visual difference is detected (0-pixel tolerance)
4. Differences require manual review and approval

**⚠️ IMPORTANT: Baseline Screenshot Responsibility**

- **Test authors** are responsible for generating initial baseline screenshots when creating new tests
- **UI change PRs** must regenerate and commit updated baselines when visual changes occur
- **CI will NOT regenerate baselines** - it only compares against existing baselines
- If baselines don't exist, tests will fail in CI

**Generating/Updating baselines:**
```bash
# Generate initial baselines for new tests
npx playwright test --update-snapshots

# Update baselines after intentional UI changes
npx playwright test --update-snapshots

# Commit the baseline screenshots with your PR
git add e2e/<test-name>.spec.ts-snapshots/
git commit -m "Add/Update baseline screenshots"
```

**Reviewing failures:**
- Check `test-results/` for diff images showing what changed
- If intentional, update baseline with `--update-snapshots` and commit
- If a bug, fix the code

See individual test READMEs (e.g., `e2e/inventory/README.md`) for screenshot details.

For comprehensive guidelines, see [E2E_TEST_GUIDELINES.md](../E2E_TEST_GUIDELINES.md).

## CI/CD

Tests run automatically in GitHub Actions on:
- Push to `main` or `develop` branches
- Pull requests to `main` or `develop`
- Manual workflow dispatch

See `.github/workflows/e2e-tests.yml` for the CI configuration.

## Debugging

### View Test Report

After running tests:

```bash
npm run test:e2e:report
```

### Run in UI Mode

```bash
npm run test:e2e:ui
```

### Run with Browser Visible

```bash
npm run test:e2e:headed
```

### Check Screenshots

Screenshots are saved to `e2e/screenshots/` after each test run.

## Configuration

The Playwright configuration is in `playwright.config.ts`. Key settings:

- **Base URL**: `http://localhost:4173` (preview server)
- **Browser**: Chromium (can add Firefox, WebKit)
- **Screenshots**: Taken on every test
- **Videos**: Retained on failure
- **Parallelism**: Disabled (workers: 1)

## Troubleshooting

### Emulators Not Starting

If emulators fail to start:

```bash
# Check if ports are in use
lsof -i :8080  # Firestore
lsof -i :9099  # Auth
lsof -i :4000  # Emulator UI

# Kill processes if needed
kill -9 <PID>
```

### Test Data Not Loading

Verify the test data file exists:

```bash
ls -lh test-data/firestore-export.json
```

### Build Failures

Ensure you're building for emulator mode:

```bash
npm run build:local
```

### Browser Installation Issues

If Playwright browsers aren't installed:

```bash
npx playwright install chromium
```

## Environment Variables

Tests use these environment variables (automatically set):

```
VITE_FIREBASE_ENV=local
VITE_FIREBASE_LOCAL_PROJECT_ID=demo-test-project
VITE_EMULATOR_FIRESTORE_HOST=localhost
VITE_EMULATOR_FIRESTORE_PORT=8080
VITE_EMULATOR_AUTH_HOST=localhost
VITE_EMULATOR_AUTH_PORT=9099
```

## Contributing

When adding new E2E tests:

1. **Follow the user story pattern**
   - Each test should tell a complete story from start to finish
   - Start from a realistic initial state (usually signed out)
   - Progress through meaningful user interactions
   
2. **Use numbered screenshots**
   - Import and use `createScreenshotHelper()` from `e2e/helpers/screenshot-helper`
   - Capture screenshots in sequence: `000-description.png`, `001-next-step.png`, etc.
   - Use descriptive names that explain what the screenshot shows
   
3. **Include both programmatic and visual verification**
   - Use `expect()` assertions for data validation
   - Use `programmaticCheck` option in `screenshots.capture()` to run assertions before screenshots
   - Screenshots provide visual regression testing
   
4. **Create test documentation**
   - Create `e2e/<test-name>/README.md` documenting the user story
   - Include a screenshot gallery with descriptions
   - List what to verify in each screenshot (programmatic + manual)
   - Use `e2e/inventory/README.md` as a template
   
5. **Place files correctly**
   - Test spec: `e2e/<test-name>.spec.ts`
   - Documentation: `e2e/<test-name>/README.md`
   - Snapshots auto-generated in: `e2e/<test-name>.spec.ts-snapshots/`
   
6. **Baseline screenshots are tracked in git**
   - Numbered screenshots in `*-snapshots/` directories are committed
   - These serve as visual regression baselines
   - **⚠️ Test authors must generate and commit initial baselines**
   - **⚠️ UI changes require regenerating and committing updated baselines**
   - **⚠️ CI will NOT regenerate baselines - tests will fail if baselines are missing**
   - Generate/update with `npx playwright test --update-snapshots`
   - Commit baselines: `git add e2e/<test-name>.spec.ts-snapshots/`

Example test structure:
```typescript
import { test, expect } from './fixtures/auth';
import { createScreenshotHelper } from './helpers/screenshot-helper';

test('my user story', async ({ page }) => {
  const screenshots = createScreenshotHelper();
  
  // Step 1
  await page.goto('/route');
  await screenshots.capture(page, 'initial-state', {
    programmaticCheck: async () => {
      await expect(page.locator('.element')).toBeVisible();
    }
  });
  
  // Continue the story...
});
```
