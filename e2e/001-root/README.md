# Root Page (Inventory Entry) E2E Test

This directory contains documentation for the root page E2E test user story.

## User Story

**As an** admin user  
**I want to** use the inventory entry form  
**So that** I can scan barcodes and add items to inventory

## Test Flow

The test follows a complete user journey from signed-out state through viewing the inventory entry form.

### Screenshots

Screenshots are numbered sequentially to tell the story.

**Note:** Screenshot filenames include the browser and platform (e.g., `-chromium-linux.png`) as part of Playwright's naming convention. These tests run on Chromium on Linux in CI, so all baseline screenshots use this suffix.

#### 000-signed-out-state.png

![Screenshot 000](screenshots/000-signed-out-state-chromium-linux.png)

**What this shows:**
- User navigates to `/` while signed out
- Application displays the sign-in screen
- "Sign In" button is prominently displayed

**Programmatic verification:**
- ✅ Sign-in button is visible
- ✅ Page heading shows "Inventory"
- ✅ Form elements are present

**Manual verification checklist:**
- [ ] Sign-in button is clearly visible
- [ ] Page layout looks correct
- [ ] Heading says "Inventory"

---

####  001-signed-in-state.png

![Screenshot 001](screenshots/001-signed-in-state-chromium-linux.png)

**What this shows:**
- User has successfully signed in
- Page has reloaded with authentication applied
- Application is ready for inventory entry

**Programmatic verification:**
- ✅ Sign-in button is no longer visible
- ✅ User is authenticated
- ✅ Redux store contains user state

**Manual verification checklist:**
- [ ] Sign-in button is gone
- [ ] Page shows inventory entry interface
- [ ] User appears to be authenticated

---

#### 002-form-loaded.png

![Screenshot 002](screenshots/002-form-loaded-chromium-linux.png)

**What this shows:**
- Inventory entry form is fully loaded
- All form fields are visible and ready for input
- Barcode scanner interface is available

**Programmatic verification:**
- ✅ Page heading shows "Inventory"
- ✅ JAN Code input is visible
- ✅ Quantity input is visible
- ✅ Description textarea is visible
- ✅ Add to Inventory button is present
- ✅ Redux store has inventory state

**Manual verification checklist:**
- [ ] All form fields are visible
- [ ] JAN Code input field exists
- [ ] Quantity input field exists
- [ ] Description textarea exists
- [ ] Subtype, Pieces, and HS Code combo boxes exist
- [ ] "Add to Inventory" button is visible
- [ ] No errors displayed
- [ ] Page layout is correct

---

## Test Data

The test uses data loaded from `test-data/firestore-export.json` into the Firebase emulator. The form starts empty and ready for new inventory entries.

## Running This Test

```bash
# Full test with emulator management
npm run test:e2e

# Run only this test
npx playwright test e2e/001-root

# Interactive UI mode
npm run test:e2e:ui

# Headed mode (see browser)
npx playwright test e2e/001-root --headed
```

## Updating Screenshots

**⚠️ IMPORTANT:** Baseline screenshots must be committed by test authors and PRs. CI will NOT regenerate baselines.

### When to update baselines:

1. **UI changes:** Regenerate baselines when your PR changes the visual appearance
2. **Test changes:** Regenerate if the test flow changes

### How to update:

```bash
# Generate/update baselines locally
npx playwright test e2e/001-root --update-snapshots

# Verify the screenshots look correct
# Then commit them with your PR
git add e2e/001-root/screenshots/
git commit -m "Update root page baseline screenshots"
```

## Related Documentation

- [E2E Test Overview](../README.md)
- [E2E Test Guidelines](../../E2E_TEST_GUIDELINES.md)
- [Playwright Configuration](../../playwright.config.ts)
