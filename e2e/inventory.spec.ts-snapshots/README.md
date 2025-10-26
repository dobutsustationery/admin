# Visual Regression Testing

This directory contains baseline screenshots for visual regression testing of the inventory page.

## Initial Setup

**IMPORTANT**: The baseline screenshot needs to be generated on first run:

```bash
# Make sure emulators are running
npm run emulators

# In another terminal, generate the baseline
bash e2e/generate-baselines.sh
```

This will create `inventory-Inventory-Page-should-match-visual-snapshot-chromium.png` which should be committed to git.

## How it Works

1. **Baseline Screenshots**: The first time a visual test runs (or after updating baselines), Playwright captures a screenshot and saves it as the baseline.

2. **Comparison**: On subsequent runs, Playwright compares the current screenshot with the baseline:
   - If they match (within tolerance), the test passes
   - If they differ, the test fails and generates diff images

3. **Manual Review Required**: When a visual test fails:
   - Review the diff images in the test results (`test-results/*-diff.png`)
   - If the change is intentional, update the baseline
   - If the change is a bug, fix the code

## Updating Baselines

When you intentionally change the UI and need to update the baseline:

```bash
# Update all baselines
npx playwright test --update-snapshots

# Update specific test baseline  
npx playwright test inventory.spec.ts --update-snapshots

# Or use the helper script
bash e2e/generate-baselines.sh
```

## Files

- `inventory-Inventory-Page-should-match-visual-snapshot-chromium.png` - Baseline screenshot for the main inventory page test

## Tolerance Settings

Visual comparison is configured in `playwright.config.ts`:
- `maxDiffPixelRatio: 0.01` - Maximum 1% of pixels can differ
- `threshold: 0.2` - Per-pixel color difference threshold (0-1, higher = more tolerant)

These settings allow for minor rendering differences while catching significant visual regressions.

## In CI/CD

The GitHub Actions workflow automatically:
1. Runs visual regression tests
2. Detects when screenshots don't match baseline
3. Uploads diff images as artifacts for review
4. Fails the build if visual changes are detected

This ensures all UI changes require explicit approval before merging.
