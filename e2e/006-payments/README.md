# Payments Page E2E Test

This directory contains documentation for the payments page E2E test user story.

## User Story

**As an** admin user  
**I want to** view payment information  
**So that** I can track received payments from PayPal

## Test Flow

The test follows a complete user journey from signed-out state through viewing the payments page.

### Screenshots

Screenshots are numbered sequentially to tell the story.

#### 000-signed-out-state.png

![Screenshot 000](screenshots/000-signed-out-state-chromium-linux.png)

**What this shows:**
- User navigates to `/payments` while signed out
- Application displays the sign-in screen

**Programmatic verification:**
- ✅ Sign-in button is visible

**Manual verification checklist:**
- [ ] Sign-in button is clearly visible

---

#### 001-signed-in-state.png

![Screenshot 001](screenshots/001-signed-in-state-chromium-linux.png)

**What this shows:**
- User has successfully signed in
- Page has reloaded with authentication applied
- Payments page is ready

**Programmatic verification:**
- ✅ Sign-in button is no longer visible
- ✅ User is authenticated

**Manual verification checklist:**
- [ ] Sign-in button is gone
- [ ] Page shows payments interface

---

## Running This Test

```bash
# Run only this test
npx playwright test e2e/006-payments

# Interactive UI mode
npx playwright test e2e/006-payments --ui
```

## Related Documentation

- [E2E Test Overview](../README.md)
- [E2E Test Guidelines](../../E2E_TEST_GUIDELINES.md)
