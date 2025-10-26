# End-to-End Tests

This directory contains Playwright-based E2E tests for the Dobutsu Admin application.

## Overview

The E2E tests verify that the application works correctly when integrated with Firebase emulators. They test:

- **Inventory Page**: Loads and displays inventory data from Firestore
- **Authentication**: Mocks Firebase Auth to bypass login
- **Data Loading**: Verifies test data from `test-data/firestore-export.json` is properly loaded

## Prerequisites

1. **Node.js 18+** or **Bun 1.0+**
2. **Firebase CLI**: `npm install -g firebase-tools`
3. **Playwright**: Installed via `npm install`

## Running Tests

### Quick Run (Recommended)

The easiest way to run E2E tests is using the helper script:

```bash
npm run test:e2e
```

This script will:
1. Start Firebase emulators if not already running
2. Load test data into the emulator
3. Build the application for emulator mode
4. Run Playwright tests
5. Clean up emulators afterwards

### Manual Run

If you prefer to run tests manually:

```bash
# Terminal 1: Start Firebase emulators
npm run emulators

# Terminal 2: Load test data
node e2e/helpers/load-test-data.js

# Terminal 2: Build and run tests
npm run build:local
npx playwright test
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
├── fixtures/          # Custom Playwright fixtures
│   └── auth.ts       # Authentication mocking fixture
├── helpers/          # Helper scripts
│   └── load-test-data.js  # Loads test data into emulator
├── screenshots/      # Test screenshots (gitignored)
├── reports/          # Test reports (gitignored)
├── inventory.spec.ts # Inventory page tests
└── run-tests.sh      # Test runner script
```

## Writing Tests

### Basic Test Structure

```typescript
import { test, expect } from '@playwright/test';

test('my test', async ({ page }) => {
  await page.goto('/my-route');
  
  // Your test assertions
  await expect(page.locator('h1')).toBeVisible();
});
```

### Authentication

Tests automatically mock Firebase authentication. No need to handle login manually.

### Test Data

Test data is loaded from `test-data/firestore-export.json` before tests run. This includes:
- `broadcast` collection: Action history for state reconstruction
- `users` collection: Admin user data
- `dobutsu` collection: Orders and payments

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

1. Place spec files in `e2e/` directory
2. Name files with `.spec.ts` extension
3. Use descriptive test names
4. Take screenshots for visual verification
5. Clean up any test-specific data if needed
