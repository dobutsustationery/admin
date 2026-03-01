# JAN Codes Verification

**As an** admin user
**I want to** view items with blank subtypes
**So that** I can categorize them

### 1. Signed Out State

![Signed Out State](screenshots/000-signed-out-state.png)

**Programmatic Verification:**
- [ ] Validated "Sign In" button is visible
- [ ] Validated heading contains "Items with a blank subtype"

### 2. Signed In State

![Signed In State](screenshots/001-signed-in-state.png)

**Programmatic Verification:**
- [ ] Validated "Sign In" button is hidden
- [ ] Validated Redux store has user state

### 3. JAN Codes Loaded

![JAN Codes Loaded](screenshots/002-jancodes-loaded.png)

**Programmatic Verification:**
- [ ] Validated heading contains "Items with a blank subtype"
- [ ] Validated table headers (if visible)
- [ ] Validated Redux inventory state

