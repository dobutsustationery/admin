# Item History Page E2E Test

This directory contains documentation for the item history page E2E test user story.

## User Story

**As an** admin user  
**I want to** view the history of changes for a specific inventory item  
**So that** I can track all actions and modifications made to that item over time

## Test Flow

The test follows a complete user journey from signed-out state through viewing the item history page.

### Screenshots

Screenshots are numbered sequentially to tell the story.

#### 000-signed-out-state.png

![Screenshot 000](screenshots/000-signed-out-state.png)

**What this shows:**
- User navigates to `/itemhistory?itemKey=test-item-001` while signed out
- Application displays the sign-in screen
- Page heading shows "Item History for test-item-001"

**Programmatic verification:**
- ✅ Sign-in button is visible
- ✅ Page heading contains "Item History"

**Manual verification checklist:**
- [ ] Sign-in button is clearly visible
- [ ] Page heading shows "Item History for test-item-001"

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
- [ ] Page shows item history interface

---

#### 002-itemhistory-loaded.png

![Screenshot 002](screenshots/002-itemhistory-loaded.png)

**What this shows:**
- Item history page is fully loaded
- History table displays with Date and Action columns
- Heading shows the specific item key being viewed
- Table may be empty if no history exists for the test item

**Programmatic verification:**
- ✅ Page heading shows "Item History for test-item-001"
- ✅ History table is visible
- ✅ Table headers show "Date" and "Action"
- ✅ Redux store has inventory state with history tracking
- ✅ No error messages displayed

**Manual verification checklist:**
- [ ] Heading shows correct item key
- [ ] Table structure is correct
- [ ] Table headers are visible
- [ ] Page layout is correct
- [ ] No error messages shown

---

## Running This Test

```bash
# Run only this test
npx playwright test e2e/009-itemhistory

# Interactive UI mode
npx playwright test e2e/009-itemhistory --ui
```

## Related Documentation

- [E2E Test Overview](../README.md)
- [E2E Test Guidelines](../../E2E_TEST_GUIDELINES.md)
