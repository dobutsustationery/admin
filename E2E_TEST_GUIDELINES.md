# E2E Verification Guidelines

This repository uses E2E tests as the primary verification mechanism for features.
The `README.md` in each test directory is not "documentation"—it is a **Verification Document** used to validate the feature.

For instructions on HOW to implement tests, see **[How to Write E2E Tests](E2E_TEST_WRITING_STEPS.md)**.

## The Verification Document Standard

Each `e2e/###-<name>/README.md` MUST follow this structure:

### 1. Header & User Story
Concise description of the user value.
```markdown
# [Feature Name] Verification

**As a** [user]
**I want to** [action]
**So that** [value]
```

### 2. Verification Steps
A sequential walkthrough of the test steps. For each step, provide:
- **Visual Verification**: The baseline screenshot.
- **Programmatic Verification**: A checklist of what the code explicitly asserts.

**Format:**
```markdown
### [Step Number]. [Step Name]

![Step Name](screenshots/NNN-step-name.png)

**Programmatic Verification:**
- [ ] Validated [X] is visible
- [ ] Validated [X] has text "..."
- [ ] Checked Redux state for [X]
```

## Creating Screenshots
1. **Filename**: `NNN-description.png` (e.g., `000-initial-state.png`).
   - **DO NOT** include platform/browser suffixes (e.g., `-chromium-linux`) in the filename or documentation links.
2. **Content**: Capture the relevant state clearly.
3. **Commit**: You MUST commit baseline screenshots to `e2e/###-<name>/screenshots/`.

## Enforcement
- **Zero-Pixel Tolerance**: Images must match exactly.
- **No Arbitrary Delays**: Use `await expect().toBeVisible()` or `waitFor({ state: 'visible' })`.
- **Strict Links**: The image links in `README.md` MUST work on GitHub.

## How to Run
- Run All: `npm run test:e2e`
- Update Baselines: `npx playwright test --update-snapshots`
