# Subtypes Page E2E Test

This directory contains documentation for the subtypes page E2E test user story.

## User Story

**As an** admin user  
**I want to** view items organized by subtypes  
**So that** I can see how inventory items are categorized

## Test Flow

The test follows a complete user journey from signed-out state through viewing the subtypes listing page.

### Screenshots

Screenshots are numbered sequentially to tell the story.

#### 000-signed-out-state.png

![Screenshot 000](screenshots/000-signed-out-state-chromium-linux.png)

**What this shows:**
- User navigates to `/subtypes` while signed out
- Application displays the sign-in screen
- Page heading shows "Items with Subtypes"

**Programmatic verification:**
- ✅ Sign-in button is visible
- ✅ Page heading is correct

**Manual verification checklist:**
- [ ] Sign-in button is clearly visible
- [ ] Page heading shows "Items with Subtypes"

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
- [ ] Page shows subtypes interface

---

#### 002-subtypes-loaded.png

![Screenshot 002](screenshots/002-subtypes-loaded-chromium-linux.png)

**What this shows:**
- Subtypes page is fully loaded
- Items are organized by JAN code with their subtypes
- Tables display item groupings (may be empty if no subtypes exist)

**Programmatic verification:**
- ✅ Page heading shows "Items with Subtypes"
- ✅ Table count is logged
- ✅ Redux store has inventory state

**Manual verification checklist:**
- [ ] Heading is correct
- [ ] Tables display grouped items (if any exist)
- [ ] Page layout is correct
- [ ] Subtypes are clearly categorized

---

## Running This Test

```bash
# Run only this test
npx playwright test e2e/008-subtypes

# Interactive UI mode
npx playwright test e2e/008-subtypes --ui
```

## Related Documentation

- [E2E Test Overview](../README.md)
- [E2E Test Guidelines](../../E2E_TEST_GUIDELINES.md)
