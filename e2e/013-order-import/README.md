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
- [ ] Row 1: New Item (7777...)
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

### 5. Resolve Conflict

![Resolve Conflict](screenshots/004-resolve-conflict.png)

**Programmatic Verification:**
- [ ] Resolve Conflict

### 6. Process Resolved

![Process Resolved](screenshots/005-process-resolved.png)

**Programmatic Verification:**
- [ ] Click Process Resolved button
- [ ] Verify Conflict item is Done
- [ ] Success message displayed

