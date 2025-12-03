# Archives Page E2E Test

This directory contains documentation for the archives page E2E test user story.

## User Story

**As an** admin user  
**I want to** manage inventory archives  
**So that** I can preserve snapshots of inventory state over time

## Test Flow

The test follows a complete user journey from signed-out state through viewing the archives management page.

### Screenshots

Screenshots are numbered sequentially to tell the story.

#### 000-signed-out-state.png

![Screenshot 000](screenshots/000-signed-out-state-chromium-linux.png)

**What this shows:**
- User navigates to `/archives` while signed out
- Application displays the sign-in screen
- Page heading shows "Archives"

**Programmatic verification:**
- ✅ Sign-in button is visible
- ✅ Page heading is correct

**Manual verification checklist:**
- [ ] Sign-in button is clearly visible
- [ ] Page heading shows "Archives"

---

#### 001-signed-in-state.png

![Screenshot 001](screenshots/001-signed-in-state-chromium-linux.png)

**What this shows:**
- User has successfully signed in
- Page has reloaded with authentication applied

**Programmatic verification:**
- ✅ Sign-in button is no longer visible
- ✅ User is authenticated
- ✅ Redux store contains user state

**Manual verification checklist:**
- [ ] Sign-in button is gone
- [ ] Page shows archives management interface

---

#### 002-archives-loaded.png

![Screenshot 002](screenshots/002-archives-loaded-chromium-linux.png)

**What this shows:**
- Archives management page is fully loaded
- Form for creating new archives is visible
- Archive name input field is ready
- List of existing archives is displayed

**Programmatic verification:**
- ✅ Page heading shows "Archives"
- ✅ Archive name input is visible
- ✅ Add Archive button is visible
- ✅ Archives list element exists
- ✅ Redux store has inventory state with archives

**Manual verification checklist:**
- [ ] Heading is correct
- [ ] Archive name input field exists
- [ ] Add Archive button is visible
- [ ] Archives list is visible (may be empty)
- [ ] Page layout is correct

---

## Running This Test

```bash
# Run only this test
npx playwright test e2e/007-archives

# Interactive UI mode
npx playwright test e2e/007-archives --ui
```

## Related Documentation

- [E2E Test Overview](../README.md)
- [E2E Test Guidelines](../../E2E_TEST_GUIDELINES.md)
