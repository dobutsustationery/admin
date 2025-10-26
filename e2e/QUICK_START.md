# Quick Start: E2E Tests with Auth Emulator

This guide gets you running E2E tests with Firebase Auth Emulator authentication in 5 minutes.

## Prerequisites

- Node.js 18+ installed
- Firebase emulators configured (already set up in this repo)

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Start Firebase Emulators

In one terminal:
```bash
npm run emulators
```

Wait for:
```
✔ All emulators ready! It is now safe to connect your app.
┌─────────────────────────────────────────────────────────────┐
│ ✔  All emulators ready! View status and logs at           │
│    http://127.0.0.1:4000                                   │
└─────────────────────────────────────────────────────────────┘

┌───────────┬────────────────┬─────────────────────────────────┐
│ Emulator  │ Host:Port      │ View in Emulator UI             │
├───────────┼────────────────┼─────────────────────────────────┤
│ Auth      │ 127.0.0.1:9099 │ http://127.0.0.1:4000/auth      │
│ Firestore │ 127.0.0.1:8080 │ http://127.0.0.1:4000/firestore │
└───────────┴────────────────┴─────────────────────────────────┘
```

### 3. Run Tests

In another terminal:
```bash
npm run test:e2e:simple
```

This will:
1. Load test data into Firestore emulator
2. Build the app for emulator mode
3. Run Playwright tests
4. Create numbered screenshots in `e2e/screenshots/`

### 4. View Results

```bash
# View HTML report
npm run test:e2e:report

# Or check screenshots
ls -la e2e/screenshots/
```

## What You'll See

The tests will create numbered screenshots showing the user journey:

```
e2e/screenshots/
├── 000-signed-out-loading.png          # Initial state (not logged in)
├── 001-signed-in-inventory-loading.png # After auth, loading data
├── 002-inventory-displayed.png         # Data loaded and shown
├── 003-inventory-table-detail.png      # Close-up of inventory table
├── 004-inventory-scrolled.png          # After scrolling
└── 005-final-state.png                 # Final application state
```

## Writing Your First Test

Create a new test file `e2e/my-test.spec.ts`:

```typescript
import { expect, test } from "@playwright/test";
import { authenticateUser, clearAuthEmulator } from "./helpers/auth-emulator.ts";

test.describe("My Feature", () => {
  // Clean up before each test
  test.beforeEach(async () => {
    await clearAuthEmulator();
  });

  test("complete user journey", async ({ page }) => {
    // Step 0: Start signed out
    await page.goto("/my-page");
    await page.screenshot({ 
      path: "e2e/screenshots/my-test-000-signed-out.png",
      fullPage: true 
    });

    // Step 1: Authenticate
    const user = await authenticateUser(page, "test@example.com", "password123");
    console.log(`Authenticated as: ${user.email}`);

    // Step 2: Navigate to protected page
    await page.goto("/my-page");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000); // Wait for Firebase to load data

    await page.screenshot({ 
      path: "e2e/screenshots/my-test-001-authenticated.png",
      fullPage: true 
    });

    // Step 3: Verify content
    await expect(page.locator("h1")).toContainText("My Feature");

    await page.screenshot({ 
      path: "e2e/screenshots/my-test-002-content-loaded.png",
      fullPage: true 
    });
  });
});
```

Run your test:
```bash
npx playwright test e2e/my-test.spec.ts
```

## Common Patterns

### Authenticate with Custom User

```typescript
const user = await authenticateUser(
  page, 
  "custom@example.com",    // email
  "custompassword123",     // password
  "Custom User Name"       // display name (optional)
);
```

### Multiple Users in One Test

```typescript
// User 1
await authenticateUser(page, "user1@example.com", "pass1");
await page.goto("/inventory");
// ... test as user 1 ...

// Switch to User 2
await clearAuthEmulator();
await authenticateUser(page, "user2@example.com", "pass2");
await page.goto("/inventory");
// ... test as user 2 ...
```

### Debug Auth Issues

```typescript
// Enable console logging
page.on('console', msg => console.log('Browser:', msg.text()));

// Check auth state
const authState = await page.evaluate(() => {
  return localStorage.getItem('firebase:authUser:demo-api-key:[DEFAULT]');
});
console.log('Auth state:', authState);
```

## Troubleshooting

### Tests Fail with "Auth Emulator Not Running"

Make sure emulators are running:
```bash
curl http://localhost:9099
curl http://localhost:8080
```

If not running, start them:
```bash
npm run emulators
```

### Screenshots Not Created

Check that directory exists:
```bash
mkdir -p e2e/screenshots
```

### Tests Timeout

Increase wait times if data loading is slow:
```typescript
await page.waitForTimeout(5000); // Increase from 3000 to 5000
```

### Browser Not Authenticated

Check the auth helper is being called:
```typescript
// Make sure this is called BEFORE navigating
await authenticateUser(page);

// Then navigate
await page.goto("/protected-page");
```

## Next Steps

- Read `e2e/AUTH_EMULATOR_GUIDE.md` for comprehensive documentation
- Check `e2e/inventory-story.spec.ts` for a complete example
- See `e2e/screenshots/README.md` for screenshot best practices

## Commands Reference

```bash
# Development
npm run emulators                 # Start Firebase emulators

# Testing
npm run test:e2e                  # Full test (manages emulators)
npm run test:e2e:simple          # Simple test (emulators must be running)
npm run test:e2e:ui              # Interactive UI mode
npm run test:e2e:headed          # Run with visible browser
npm run test:e2e:report          # View HTML report

# Building
npm run build:local              # Build for emulator mode
```

## Tips

1. **Use descriptive screenshot names**: `000-feature-initial.png` not just `000.png`
2. **Take screenshots at key points**: Before/after major actions
3. **Use fullPage for complete view**: `{ fullPage: true }`
4. **Clean up between tests**: Call `clearAuthEmulator()` in `beforeEach`
5. **Wait for Firebase**: Always wait 3-5 seconds after navigation for Firebase to load

Happy testing! 🧪
