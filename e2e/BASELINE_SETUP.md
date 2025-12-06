# Generating Baseline Screenshots

This guide explains how to create the initial baseline screenshot for visual regression testing.

## Prerequisites

**Note:** When running in GitHub Copilot or GitHub Actions environments, all prerequisites are automatically set up by the `copilot-setup-steps.yml` workflow. This includes:
- Node.js 20
- npm dependencies installed
- Firebase emulators cached and ready
- Playwright browsers installed with dependencies
- Emulators started and test data loaded

For local development, you'll need:

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
npx playwright test --update-snapshots
```

This creates screenshots in `e2e/###-<testname>/screenshots/` for each test (e.g., `e2e/000-inventory/screenshots/`).

## Commit the Baseline

After generating:

```bash
git add e2e/###-<testname>/screenshots/
git commit -m "Add baseline screenshots for visual regression testing"
```

## On CI/CD

The baseline screenshots must exist in the repository before CI runs. The first PR with visual regression testing should include the baseline screenshots generated locally.

## Workflow

1. **Local Development**: Generate baseline once, commit it
2. **CI Testing**: Compares screenshots against committed baseline
3. **Visual Changes**: Fail CI, upload diffs for review
4. **Approval**: Update baseline with `--update-snapshots`, commit new baseline
