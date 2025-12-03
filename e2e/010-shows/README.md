# Shows Page E2E Test

This directory contains documentation for the shows page E2E test user story.

## User Story

**As an** admin user  
**I want to** create and view event sales from archived inventory snapshots  
**So that** I can track which items were sold at specific events and generate sales reports

## Test Flow

The test follows a complete user journey from signed-out state through viewing the shows management page.

### Screenshots

Screenshots are numbered sequentially to tell the story.

#### 000-signed-out-state.png

![Screenshot 000](screenshots/000-signed-out-state.png)

**What this shows:**
- User navigates to `/shows` while signed out
- Application displays the sign-in screen
- Page heading shows "Create and view event sales"

**Programmatic verification:**
- ✅ Sign-in button is visible
- ✅ Page heading contains "Create and view event sales"

**Manual verification checklist:**
- [ ] Sign-in button is clearly visible
- [ ] Page heading shows "Create and view event sales"

---

#### 001-signed-in-state.png

![Screenshot 001](screenshots/001-signed-in-state.png)

**What this shows:**
- User has successfully signed in
- Page has reloaded with authentication applied

**Programmatic verification:**
- ✅ Sign-in button is no longer visible
- ✅ User is authenticated
- ✅ Redux store contains user state

**Manual verification checklist:**
- [ ] Sign-in button is gone
- [ ] Page shows shows management interface

---

#### 002-shows-loaded.png

![Screenshot 002](screenshots/002-shows-loaded.png)

**What this shows:**
- Shows management page is fully loaded
- "Available Archives" section is displayed
- Table shows archived inventory snapshots with Date, Archive Name, and Actions columns
- Each archive row provides options to create sales or view existing sales
- List may contain archived inventory from test data

**Programmatic verification:**
- ✅ Main heading shows "Create and view event sales"
- ✅ "Available Archives" heading is visible
- ✅ Archives table is visible
- ✅ Table headers show "Date", "Archive Name", and "Actions"
- ✅ Redux store has inventory state with archived state and sales events
- ✅ No error messages displayed

**Manual verification checklist:**
- [ ] Main heading is correct
- [ ] "Available Archives" heading is visible
- [ ] Table structure is correct
- [ ] Table headers are visible
- [ ] Archives are listed (may be empty)
- [ ] Action buttons are present for each archive
- [ ] Page layout is correct
- [ ] No error messages shown

---

## Running This Test

```bash
# Run only this test
npx playwright test e2e/010-shows

# Interactive UI mode
npx playwright test e2e/010-shows --ui
```

## Related Documentation

- [E2E Test Overview](../README.md)
- [E2E Test Guidelines](../../E2E_TEST_GUIDELINES.md)
