# Generating Baseline Screenshots

This guide explains how to create the initial baseline screenshot for visual regression testing.

## Prerequisites

1. Firebase emulators running (`npm run emulators`)
2. Application built for emulator mode (`npm run build:local`)
3. Playwright installed (`npm install`)

## Generate Baseline

Run the helper script:

```bash
bash e2e/generate-baselines.sh
```

Or manually:

```bash
# With emulators already running
npx playwright test inventory.spec.ts --grep "should match visual snapshot" --update-snapshots
```

This creates: `e2e/inventory.spec.ts-snapshots/inventory-Inventory-Page-should-match-visual-snapshot-chromium.png`

## Commit the Baseline

After generating:

```bash
git add e2e/inventory.spec.ts-snapshots/
git commit -m "Add baseline screenshot for visual regression testing"
```

## On CI/CD

The baseline screenshot must exist in the repository before CI runs. The first PR with visual regression testing should include the baseline screenshot generated locally.

## Workflow

1. **Local Development**: Generate baseline once, commit it
2. **CI Testing**: Compares screenshots against committed baseline
3. **Visual Changes**: Fail CI, upload diffs for review
4. **Approval**: Update baseline with `--update-snapshots`, commit new baseline
