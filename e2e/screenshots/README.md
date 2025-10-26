# E2E Test Screenshots

This directory contains numbered screenshots generated during E2E test execution that tell a visual story of the application flow.

## Naming Convention

Screenshots follow a numbered pattern:
- `000-description.png` - Starting state (usually signed-out)
- `001-next-step.png` - First action or state change
- `002-another-step.png` - Following actions
- etc.

## Purpose

The numbered screenshots provide:
1. **Visual documentation** of the user journey through the app
2. **Debugging aid** when tests fail - you can see exactly where things went wrong
3. **Visual regression testing** - compare screenshots across test runs
4. **Story-based testing** - each test tells a complete story from start to finish

## Test Suites

### Inventory Story Test (`inventory-story.spec.ts`)
- `000-signed-out-loading.png` - Initial signed-out state
- `001-signed-in-inventory-loading.png` - After authentication, loading inventory
- `002-inventory-displayed.png` - Inventory data loaded and displayed
- `003-inventory-table-detail.png` - Close-up of inventory table
- `004-inventory-scrolled.png` - After scrolling through inventory
- `005-final-state.png` - Final application state

### Inventory Page Test (`inventory.spec.ts`)
- `inventory-000-signed-out.png` - Starting from signed-out state
- `inventory-001-authenticated-loading.png` - Authenticated, loading inventory
- `inventory-002-data-loaded.png` - Inventory data displayed

## Notes

- Screenshots are generated during test execution
- They are excluded from git (see `.gitignore`)
- Screenshots are uploaded as artifacts in CI/CD for review
- Only `.gitkeep` is committed to maintain the directory structure
