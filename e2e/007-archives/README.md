# Inventory Archives Verification

**As an** admin user
**I want to** manage inventory archives
**So that** I can track historical data

### 1. Signed Out State

![Signed Out State](screenshots/000-signed-out-state.png)

**Programmatic Verification:**
- [ ] Validated "Sign In" button is visible
- [ ] Validated heading contains "Archives"

### 2. Signed In State

![Signed In State](screenshots/001-signed-in-state.png)

**Programmatic Verification:**
- [ ] Validated "Sign In" button is hidden
- [ ] Validated Redux store has user state

### 3. Archives Loaded

![Archives Loaded](screenshots/002-archives-loaded.png)

**Programmatic Verification:**
- [ ] Validated heading is "Archives"
- [ ] Validated archive input is visible
- [ ] Validated Add Archive button is visible
- [ ] Validated Redux store has archives state

