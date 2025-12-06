# Inventory Page Verification

**As an** admin user
**I want to** view the inventory
**So that** I can see current stock levels

### 1. Signed Out State

![Signed Out State](screenshots/000-signed-out-state.png)

**Programmatic Verification:**
- [ ] Validated "Sign In" button is visible
- [ ] Verified no console errors (except expected auth init)

### 2. Signed In State

![Signed In State](screenshots/001-signed-in-state.png)

**Programmatic Verification:**
- [ ] Validated "Sign In" button is hidden
- [ ] Verified user is authenticated

### 3. Inventory Loaded

![Inventory Loaded](screenshots/002-inventory-loaded.png)

**Programmatic Verification:**
- [ ] Validated inventory table is visible
- [ ] Checked headers include "JAN Code" and "Quantity"
- [ ] Verified at least one row is displayed
- [ ] Validated sample row data structure
