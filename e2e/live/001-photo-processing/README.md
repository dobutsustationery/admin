# Photo Processing (Color, Crop, Remove BG)

**As a** admin user, **I want to** process product photos (Crop, Color Correct, Remove Background) **so that** they are ready for listing.

### 1. Photos View Loaded

![Photos View Loaded](screenshots/000-photos-view.png)

**Programmatic Verification:**
- [ ] At least 1 real photo is visible in Photos view
- [ ] Chosen photo is ready for processing
- [ ] Chosen photo thumbnail has fully loaded

### 2. Color In Progress

![Color In Progress](screenshots/001-color-in-progress.png)

**Programmatic Verification:**
- [ ] Color operation entered in-progress state

### 3. Color Completed

![Color Completed](screenshots/002-color-completed.png)

**Programmatic Verification:**
- [ ] Color added one new history version

### 4. Auto Crop In Progress

![Auto Crop In Progress](screenshots/003-auto-crop-in-progress.png)

**Programmatic Verification:**
- [ ] Auto Crop operation entered in-progress state

### 5. Auto Crop Completed

![Auto Crop Completed](screenshots/004-auto-crop-completed.png)

**Programmatic Verification:**
- [ ] Auto Crop added one new history version

### 6. Remove BG In Progress

![Remove BG In Progress](screenshots/005-remove-bg-in-progress.png)

**Programmatic Verification:**
- [ ] Remove BG operation entered in-progress state

### 7. Remove BG Completed

![Remove BG Completed](screenshots/006-remove-bg-completed.png)

**Programmatic Verification:**
- [ ] Remove BG added one new history version

### 8. Processed Photo History

![Processed Photo History](screenshots/007-processed-history.png)

**Programmatic Verification:**
- [ ] History contains exactly 3 new versions after processing
- [ ] Current image is visible after processing

