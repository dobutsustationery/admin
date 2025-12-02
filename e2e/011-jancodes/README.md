# JAN Codes Page E2E Test

This directory contains documentation for the JAN codes page E2E test user story.

## User Story

**As an** admin user  
**I want to** view items that have blank subtypes organized by JAN code  
**So that** I can identify and fix items that need subtype categorization

## Test Flow

The test follows a complete user journey from signed-out state through viewing the JAN codes page.

### Screenshots

Screenshots are numbered sequentially to tell the story.

#### 000-signed-out-state.png

![Screenshot 000](screenshots/000-signed-out-state-chromium-linux.png)

**What this shows:**
- User navigates to `/jancodes` while signed out
- Application displays the sign-in screen
- Page heading shows "Items with a blank subtype"

**Programmatic verification:**
- ✅ Sign-in button is visible
- ✅ Page heading is correct

**Manual verification checklist:**
- [ ] Sign-in button is clearly visible
- [ ] Page heading shows "Items with a blank subtype"

---

#### 001-signed-in-state.png

![Screenshot 001](screenshots/001-signed-in-state-chromium-linux.png)

**What this shows:**
- User has successfully signed in
- Page has reloaded with authentication applied

**Programmatic verification:**
- ✅ Sign-in button is no longer visible
- ✅ User is authenticated

**Manual verification checklist:**
- [ ] Sign-in button is gone
- [ ] Page shows JAN codes interface

---

#### 002-jancodes-loaded.png

![Screenshot 002](screenshots/002-jancodes-loaded-chromium-linux.png)

**What this shows:**
- JAN codes page is fully loaded
- Tables showing items grouped by JAN code
- Each table has columns for Image, Subtype, HS Code, and Description

**Programmatic verification:**
- ✅ Page heading shows "Items with a blank subtype"
- ✅ Tables are displayed (if items exist)
- ✅ Table headers include: Image, Subtype, HS Code, Description
- ✅ Redux store has inventory state

**Manual verification checklist:**
- [ ] Heading is correct
- [ ] Tables are organized by JAN code
- [ ] Table headers are correct
- [ ] Page layout is correct
- [ ] If no items with blank subtypes exist, page is empty (expected)

---

## Running This Test

```bash
# Run only this test
npx playwright test e2e/011-jancodes

# Interactive UI mode
npx playwright test e2e/011-jancodes --ui
```

## Related Documentation

- [E2E Test Overview](../README.md)
- [E2E Test Guidelines](../../E2E_TEST_GUIDELINES.md)
