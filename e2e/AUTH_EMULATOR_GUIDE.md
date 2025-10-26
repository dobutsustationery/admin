# Firebase Auth Emulator Integration for E2E Tests

## Overview

This document explains how the E2E tests now use the Firebase Auth Emulator for real authentication instead of mocking localStorage.

## How It Works

### 1. Firebase Auth Emulator REST API

The Firebase Auth Emulator provides REST endpoints that allow us to:
- Create new users (`signUp`)
- Sign in existing users (`signInWithPassword`)
- Get auth tokens that work with the Firebase SDK

### 2. Auth Helper (`e2e/helpers/auth-emulator.ts`)

We created helper functions that:

1. **Create/Sign In Users** via the emulator's REST API:
   ```typescript
   const user = await signUpWithEmailPassword(
     'test@example.com', 
     'password123',
     'Test User'
   );
   ```

2. **Inject Auth State** into the browser:
   ```typescript
   await injectAuthState(page, user);
   ```
   This sets up localStorage with the auth tokens so the Firebase SDK recognizes the user as authenticated.

3. **Main Helper** combines both steps:
   ```typescript
   const user = await authenticateUser(
     page,
     'test@example.com',
     'password123'
   );
   ```

### 3. Test Flow

The new test flow follows this pattern:

```typescript
test('my test', async ({ page }) => {
  // Step 0: Navigate to app (signed out)
  await page.goto('/inventory');
  await page.screenshot({ 
    path: 'e2e/screenshots/000-signed-out.png' 
  });

  // Step 1: Authenticate via emulator
  const user = await authenticateUser(page);
  
  // Step 2: Navigate to app (now authenticated)
  await page.goto('/inventory');
  await page.screenshot({ 
    path: 'e2e/screenshots/001-authenticated.png' 
  });

  // Step 3+: Continue with test assertions...
});
```

## Benefits Over Mocking

1. **Real Authentication**: Tests use the actual Firebase Auth flow
2. **Accurate Testing**: Catches issues that mocking would miss
3. **Better Coverage**: Tests auth state management, token handling, etc.
4. **Easier Maintenance**: No need to keep mocks in sync with Firebase changes

## Numbered Screenshots

Tests now create numbered screenshots (000-description.png, 001-next.png, etc.) that tell a visual story:

- **000-signed-out.png** - Initial state when user is not authenticated
- **001-authenticated.png** - After signing in
- **002-data-loaded.png** - After app loads data
- **003-interaction.png** - After user interaction
- etc.

This makes it easy to:
- See exactly what the user sees at each step
- Debug test failures by looking at the screenshot sequence
- Document the user journey visually
- Create visual regression tests

## Examples

### Simple Authenticated Test

```typescript
import { authenticateUser } from './helpers/auth-emulator.ts';

test('view inventory', async ({ page }) => {
  await authenticateUser(page);
  await page.goto('/inventory');
  
  const table = page.locator('table');
  await expect(table).toBeVisible();
});
```

### Story-Based Test with Screenshots

```typescript
import { authenticateUser, clearAuthEmulator } from './helpers/auth-emulator.ts';

test.beforeEach(async () => {
  await clearAuthEmulator();
});

test('complete user journey', async ({ page }) => {
  // Start signed out
  await page.goto('/inventory');
  await page.screenshot({ 
    path: 'e2e/screenshots/000-signed-out.png',
    fullPage: true 
  });

  // Authenticate
  await authenticateUser(page, 'user@example.com', 'pass123');
  
  // View authenticated page
  await page.goto('/inventory');
  await page.screenshot({ 
    path: 'e2e/screenshots/001-inventory-loading.png',
    fullPage: true 
  });

  // Wait for data
  await page.waitForSelector('table');
  await page.screenshot({ 
    path: 'e2e/screenshots/002-inventory-loaded.png',
    fullPage: true 
  });
});
```

### Different Users in Same Test

```typescript
test('multiple users', async ({ page }) => {
  // User 1
  await authenticateUser(page, 'user1@example.com', 'pass1');
  await page.goto('/inventory');
  // ... test as user 1 ...

  // Clear and sign in as User 2
  await clearAuthEmulator();
  await authenticateUser(page, 'user2@example.com', 'pass2');
  await page.goto('/inventory');
  // ... test as user 2 ...
});
```

## API Reference

### `authenticateUser(page, email?, password?, displayName?)`

Main helper that creates/signs in a user and injects auth state.

**Parameters:**
- `page` - Playwright Page object
- `email` - User email (default: 'test@example.com')
- `password` - User password (default: 'testpassword123')
- `displayName` - User display name (optional)

**Returns:** `Promise<AuthUser>` with `{ email, uid, idToken, refreshToken, ... }`

### `signUpWithEmailPassword(email, password, displayName?)`

Creates a new user in the auth emulator.

### `signInWithEmailPassword(email, password)`

Signs in an existing user in the auth emulator.

### `injectAuthState(page, user)`

Injects auth tokens into browser storage.

### `clearAuthEmulator()`

Removes all users from the auth emulator (for cleanup).

## Troubleshooting

### Auth Not Working

If authentication doesn't work:

1. Verify emulators are running:
   ```bash
   curl http://localhost:9099
   ```

2. Check browser console for Firebase errors:
   ```typescript
   page.on('console', msg => console.log('Browser:', msg.text()));
   ```

3. Verify auth state injection:
   ```typescript
   const storage = await page.evaluate(() => localStorage);
   console.log('LocalStorage:', storage);
   ```

### Screenshots Not Created

Ensure the screenshots directory exists:
```bash
mkdir -p e2e/screenshots
```

### Tests Failing After Auth

Make sure to wait for Firebase to initialize:
```typescript
await page.waitForLoadState('networkidle');
await page.waitForTimeout(3000); // Wait for Firebase init
```

## Related Files

- `e2e/helpers/auth-emulator.ts` - Auth helper implementation
- `e2e/inventory.spec.ts` - Updated to use auth emulator
- `e2e/inventory-story.spec.ts` - Complete story-based test
- `e2e/screenshots/README.md` - Screenshot documentation
- `e2e/README.md` - General E2E testing documentation
