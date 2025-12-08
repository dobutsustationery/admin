# Inventory View Verification

**As an** admin user
**I want to** view the inventory list
**So that** I can track stock levels

### 1. Signed Out State

![Signed Out State](screenshots/000-signed-out-state.png)

**Programmatic Verification:**
- [ ] Validated "Sign In" button is visible
- [ ] Validated inventory table is NOT visible

### 2. Signed In State

![Signed In State](screenshots/001-signed-in-state.png)

**Programmatic Verification:**
- [ ] Validated "Sign In" button is no longer visible
- [ ] Validated inventory table is visible

### 3. Inventory Data Loaded

![Inventory Data Loaded](screenshots/002-inventory-loaded.png)

**Programmatic Verification:**
- [ ] Validated table headers include "JAN Code" and "Quantity"
- [ ] Validated inventory data rows are present
- [ ] Validated Redux store has inventory state

