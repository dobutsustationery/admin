# Shows Verification

**As an** admin user
**I want to** manage event sales
**So that** I can track sales performance

### 1. Signed Out State

![Signed Out State](screenshots/000-signed-out-state.png)

**Programmatic Verification:**
- [ ] Validated "Sign In" button is visible
- [ ] Validated heading contains "Create and view event sales"

### 2. Signed In State

![Signed In State](screenshots/001-signed-in-state.png)

**Programmatic Verification:**
- [ ] Validated "Sign In" button is hidden
- [ ] Validated Redux store has user state

### 3. Shows Loaded

![Shows Loaded](screenshots/002-shows-loaded.png)

**Programmatic Verification:**
- [ ] Validated heading contains "Create and view event sales"
- [ ] Validated "Available Archives" heading (if visible)
- [ ] Validated table exists (if visible)
- [ ] Validated Redux store has sales events state

