# Order Detail Page E2E Test

This directory contains documentation for the order detail page E2E test user story.

## User Story

**As an** admin user  
**I want to** view and manage a specific order  
**So that** I can package items for that order

## Test Flow

The test follows a complete user journey from signed-out state through viewing the order detail page.

**Note:** This page typically requires query parameters (`orderId`, `email`, `product`). The test validates the page loads correctly without specific order data.

### Screenshots

Screenshots are numbered sequentially to tell the story.

#### 000-signed-out-state.png

![Screenshot 000](screenshots/000-signed-out-state-chromium-linux.png)

**What this shows:**
- User navigates to `/order` while signed out
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
- Order detail page is ready

**Programmatic verification:**
- ✅ Sign-in button is no longer visible
- ✅ User is authenticated

**Manual verification checklist:**
- [ ] Sign-in button is gone
- [ ] Page shows order interface

---

## Running This Test

```bash
# Run only this test
npx playwright test e2e/004-order

# Interactive UI mode
npx playwright test e2e/004-order --ui
```

## Related Documentation

- [E2E Test Overview](../README.md)
- [E2E Test Guidelines](../../E2E_TEST_GUIDELINES.md)
