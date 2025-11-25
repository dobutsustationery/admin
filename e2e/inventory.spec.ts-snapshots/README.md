# Visual Regression Testing - Inventory Page

This directory contains baseline screenshots for visual regression testing of the inventory page.

## User Story Screenshots

The inventory test follows a user story pattern with numbered screenshots:

- **000-signed-out-state-chromium-linux.png** - Initial state when user navigates to inventory while signed out
- **001-signed-in-state-chromium-linux.png** - State after user successfully signs in
- **002-inventory-loaded-chromium-linux.png** - Final state with inventory data loaded and displayed

Each screenshot represents a step in the complete user journey. See [../inventory/README.md](../inventory/README.md) for detailed documentation of what each screenshot shows and what to verify.

## How Visual Regression Testing Works

1. **Baseline Screenshots**: These screenshots in this directory are the "source of truth" for how the UI should look.

2. **Comparison**: When tests run, Playwright:
   - Captures current screenshots
   - Compares them pixel-by-pixel with baselines
   - Tests pass if screenshots match (within tolerance)
   - Tests fail if visual differences exceed thresholds

3. **Manual Review Required**: When a visual test fails:
   - Review the diff images in test results (`test-results/*-diff.png`)
   - If the change is intentional (UI update), update the baseline
   - If the change is a bug, fix the code

## Updating Baselines

When you intentionally change the UI and need to update baselines:

```bash
# Update all baselines
npx playwright test --update-snapshots

# Update specific test baseline  
npx playwright test inventory.spec.ts --update-snapshots

# Or use the helper script
bash e2e/generate-baselines.sh
```

After updating, review the new screenshots and commit them to git.

## Screenshot Naming Convention

Screenshots follow the pattern: `NNN-description-browser-os.png`

- `NNN` - Zero-padded number indicating sequence (000, 001, 002, etc.)
- `description` - Brief description of what the screenshot shows (kebab-case)
- `browser` - Browser used (e.g., chromium, firefox, webkit)
- `os` - Operating system (e.g., linux, darwin, win32)

This naming makes it easy to:
- Understand the test flow at a glance
- Track screenshots in version control
- Identify which step failed when tests break

## Tolerance Settings

Visual comparison is configured in `playwright.config.ts`:
- `maxDiffPixels: 0` - Zero pixels can differ (exact match required)
- `threshold: 0` - No color difference allowed

**Screenshots must match exactly.** Test authors are responsible for generating and committing accurate baseline screenshots.

## In CI/CD

The GitHub Actions workflow automatically:
1. Runs visual regression tests against these baselines
2. Detects when screenshots don't match
3. Uploads diff images as artifacts for review
4. Fails the build if visual changes are detected

This ensures all UI changes require explicit approval before merging.
