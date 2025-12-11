# Inventory Receipt Verification

**As an** admin user
**I want to** import inventory from CSV receipts
**So that** I can update stock quantities, create draft items, and resolve subtype allocations.

### 1. View File List

![View File List](screenshots/000-view-files.png)

**Programmatic Verification:**
- [ ] App should be connected to Drive
- [ ] CSV file should be listed

### 2. Verify Preview

![Verify Preview](screenshots/001-verify-preview.png)

**Programmatic Verification:**
- [ ] Preview Header Visible
- [ ] Batch Actions Visible
- [ ] Row 1: New Item (5555...)
- [ ] Row 2: Existing or Conflict
- [ ] Row 3: Existing Pen (490...)

### 3. Process Matches

![Process Matches](screenshots/002-process-matches.png)

**Programmatic Verification:**
- [ ] Click Match Button

### 4. Process New Items

![Process New Items](screenshots/003-process-new.png)

**Programmatic Verification:**
- [ ] Click Create New Button

### 5. Open Conflict Modal

![Open Conflict Modal](screenshots/004-004-conflict-modal.png)

**Programmatic Verification:**
- [ ] Open Review Modal

### 6. Confirm Conflict Resolution

![Confirm Conflict Resolution](screenshots/005-005-conflict-resolved.png)

**Programmatic Verification:**
- [ ] Confirm Split

### 7. Process Resolved

![Process Resolved](screenshots/006-006-process-resolved.png)

**Programmatic Verification:**
- [ ] Click Process Resolved button
- [ ] Success message displayed

