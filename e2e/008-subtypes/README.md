# Subtypes Verification

**As an** admin user
**I want to** view items with subtypes
**So that** I can manage product variations

### 1. Signed Out State

![Signed Out State](screenshots/000-signed-out-state.png)

**Programmatic Verification:**
- [ ] Validated "Sign In" button is visible
- [ ] Validated heading contains "Items with Subtypes"

### 2. Signed In State

![Signed In State](screenshots/001-signed-in-state.png)

**Programmatic Verification:**
- [ ] Validated "Sign In" button is hidden
- [ ] Validated Redux store has user state

### 3. Subtypes Loaded

![Subtypes Loaded](screenshots/002-subtypes-loaded.png)

**Programmatic Verification:**
- [ ] Validated heading contains "Items with Subtypes"
- [ ] Validated Redux inventory state

