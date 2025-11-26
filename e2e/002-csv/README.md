# CSV Export Page E2E Test

This directory contains documentation for the CSV export page E2E test user story.

## User Story

**As an** admin user  
**I want to** view inventory data as CSV  
**So that** I can export and analyze it in spreadsheet applications

## Test Flow

The test follows a complete user journey from signed-out state through viewing the CSV export page.

### Screenshots

Screenshots are numbered sequentially to tell the story.

**Note:** Screenshot filenames include the browser and platform (e.g., `-chromium-linux.png`) as part of Playwright's naming convention.

#### 000-signed-out-state.png

![Screenshot 000](screenshots/000-signed-out-state-chromium-linux.png)

**What this shows:**
- User navigates to `/csv` while signed out
- Application displays the sign-in screen
- CSV content area is empty

**Programmatic verification:**
- ✅ Sign-in button is visible
- ✅ CSV content area exists but is empty

**Manual verification checklist:**
- [ ] Sign-in button is clearly visible
- [ ] Page layout looks correct
- [ ] No CSV data is shown

---

#### 001-signed-in-state.png

![Screenshot 001](screenshots/001-signed-in-state-chromium-linux.png)

**What this shows:**
- User has successfully signed in
- Page has reloaded with authentication applied
- CSV export page is preparing to load data

**Programmatic verification:**
- ✅ Sign-in button is no longer visible
- ✅ User is authenticated

**Manual verification checklist:**
- [ ] Sign-in button is gone
- [ ] Page shows CSV export interface

---

## Test Data

The test uses data loaded from `test-data/firestore-export.json` into the Firebase emulator. The CSV export reflects the current inventory state.

## Running This Test

```bash
# Run only this test
npx playwright test e2e/002-csv

# Interactive UI mode
npx playwright test e2e/002-csv --ui

# Headed mode (see browser)
npx playwright test e2e/002-csv --headed
```

## Related Documentation

- [E2E Test Overview](../README.md)
- [E2E Test Guidelines](../../E2E_TEST_GUIDELINES.md)
