# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Safety Rule

- Never use `--no-verify` when running `git commit` or `git push`.

## Project Overview

SvelteKit + Firebase admin portal for managing inventory and orders for a Japanese stationery store. Key capabilities: barcode scanning, real-time multi-user sync via Firestore action broadcasting, Google Drive/Photos integration, Gemini AI for product descriptions, and Shopify product sync.

## Commands

### Development

```bash
bun install               # Install dependencies
npm run dev:local         # Dev server with Firebase emulators
npm run dev:staging       # Dev server against staging Firebase
npm run emulators         # Start Firebase emulators (separate terminal)
npm run auth              # Firebase login
```

### Build & Deploy

```bash
npm run build:local       # Build for emulator mode
npm run build             # Build for production
npm run deploy            # Deploy to production (hosting + functions)
npm run deploy:staging    # Deploy to staging
```

### Code Quality

```bash
bun run lint:fix          # Format with Prettier (run before committing)
bun run check             # Type-check with svelte-check
```

### Testing

```bash
bun run test              # Unit tests (Vitest) with coverage
npm run test:watch        # Unit tests in watch mode
npm run test:e2e          # Full E2E suite (manages emulators automatically)
npm run test:e2e:simple   # E2E tests (emulators already running)
npm run test:e2e:ui       # Interactive Playwright UI
npm run test:e2e:headed   # E2E with visible browser
npm run test:e2e:report   # View last HTML report
```

To run a single E2E test file:

```bash
npx playwright test e2e/000-inventory/
```

To run unit tests matching a pattern:

```bash
bun run test -- --reporter=verbose -t "pattern"
```

### Live Integration Tests (requires OAuth setup)

```bash
VITEST_INCLUDE_LIVE=1 npm run test:live:contracts
npm run test:live:e2e
npm run test:live:doctor  # Health check
```

## Architecture

### Tech Stack

- **Framework**: SvelteKit 1.20.4 with `adapter-static` (outputs to `build/`)
- **State**: Redux Toolkit 1.9.7 with Immer
- **Backend**: Firebase 12 (Firestore, Auth, Hosting) + Cloud Functions
- **Linter/Formatter**: Prettier (note: copilot instructions say Biome, but package.json uses Prettier)
- **Testing**: Vitest (unit), Playwright (E2E)
- **Package manager**: Bun (preferred) or npm

### Real-Time Sync Architecture

The app uses a **Redux action broadcast** pattern for multi-user sync:

1. User dispatches a Redux action
2. Middleware writes the serialized action to Firestore `broadcast` collection
3. All connected clients listen to `broadcast` and replay actions locally
4. This creates eventual consistency across all admin users

Key files:

- `src/lib/redux-firestore.ts` — Firestore broadcast middleware
- `src/lib/store.ts` — Store setup with middleware chain
- `src/lib/root-reducer.ts` — Combined reducers (~1200 lines)

### State Slices (`src/lib/`)

- `inventory.ts` — Core item management, quantities, shipping (~31KB)
- `listing-creation-slice.ts` — Photo-based product creation with Gemini AI (~58KB)
- `listings-slice.ts` — Shopify listing sync
- `photos-slice.ts` — Photo categorization
- `order-import-slice.ts` — CSV order imports
- `shopify-import-slice.ts` — Shopify product sync
- `google-drive.ts` — Drive API client (~26KB)
- `google-photos.ts` — Photos API picker integration
- `gemini-client.ts` — LLM image analysis & descriptions

### Firebase Collections

- `broadcast` — Action log for state sync (timestamped, creator tracked)
- `dobutsu` — Orders and payments
- `users` — Admin user activity
- `jailed` — Quarantined invalid actions
- `listings` — Shopify listing state
- `photos` — Photo categorization state

### Firestore Projects

- `default`/`production`: `dobutsu-admin`
- `staging`: `dobutsu-admin-staging`
- Local: Firebase emulators (Firestore :8080, Auth :9099, Functions :5001)

## Code Patterns

### Redux Actions (required pattern)

```typescript
// 1. Define action in slice file
export const action_name = createAction<PayloadType>("action_name");

// 2. Add reducer case using Immer draft
r.addCase(action_name, (state, action) => {
  state.field = action.payload.value; // Mutable draft syntax
});

// 3. Dispatch with Firestore broadcast for multi-user sync
broadcast(firestore, $user.uid, action_name({ ...payload }));
// Or for local-only (no sync needed):
store.dispatch(action_name({ ...payload }));
```

### Svelte Components

- Use `<script lang="ts">` always
- Use `$lib/` alias for all imports: `import { store } from '$lib/store'`
- Component files: PascalCase (`MyComponent.svelte`)
- Route files: SvelteKit conventions (`+page.svelte`, `+layout.svelte`)

### Adding New State

1. Create slice in `src/lib/` (e.g., `my-slice.ts`)
2. Define interface and actions with `createAction`
3. Create reducer with `createReducer`
4. Add to `src/lib/store.ts`
5. Access as `$store.mySlice` in components

### Adding New Routes

1. Create directory in `src/routes/route-name/`
2. Add `+page.svelte` (and `+page.ts` if load function needed)
3. Auth is handled by root `+layout.svelte`

## E2E Testing

E2E tests are the **primary verification mechanism**. Each test suite in `e2e/NNN-name/` contains:

- `NNN-name.spec.ts` — Playwright tests
- `README.md` — Source of truth for functionality validation (includes screenshot gallery)
- `screenshots/` — Visual regression baselines (committed to git, 0-pixel tolerance)

Tests run serially (workers: 1), no retries. Screenshots are captured on every test. Visual regression uses exact pixel matching — update baselines deliberately.

Test data loads from `e2e/test-data/firestore-export.json`. The emulator is pre-populated before tests run.

### E2E Guidelines (CRITICAL — follow exactly)

1. **Zero pixel tolerance** — Screenshots use exact pixel matching. Never adjust tolerances. If a screenshot doesn't match, fix the code or deliberately update the baseline.

2. **No `waitForTimeout`** — Banned. The pre-commit hook (`scripts/check-no-wait-for-timeout.js`) will reject any commit containing it. Use proper wait mechanisms instead:
   - `page.waitForLoadState("domcontentloaded" | "networkidle")`
   - `element.waitFor({ state: "visible" | "hidden" })`
   - `expect(element).toBeVisible()`
   - `page.waitForSelector()`

3. **Short, explicit timeouts** — When a timeout is needed, set it short and targeted. Long timeouts mask bugs and slow down the suite. Never use timeouts as a proxy for "wait until ready."

4. **Tests must pass reliably** — Flaky tests are broken tests. If a test fails intermittently, that is a real bug to fix, not a condition to work around with retries or sleeps.

5. **Do not blame race conditions** — If a test fails, assume your change broke it. Investigate the failure. "It's a race condition" is almost never correct and is a distraction from the real cause.

6. **Failing tests are your fault** — When your change causes a test to fail, fix your code, not the test. Only update test baselines/assertions when the new behavior is intentional and correct.

7. **Write E2E tests for every new feature** — Every new user-facing capability needs a corresponding E2E test. No feature is complete without test coverage.

### Git Hooks

- **Pre-commit** (`.husky/pre-commit`): Runs `npm run ci` (which includes the `waitForTimeout` ban check), `npm run check` (type-check), and the full unit test suite (`bun run test`). Fix all failures before committing.

- **Pre-push** (`.husky/pre-push`): Runs the full E2E suite against isolated emulator ports (offset +10000 from defaults to avoid conflicts). Also runs live integration tests and fixture health checks. Push will be blocked until all pass.

## Agent Workflow (Design-First)

For non-trivial tasks, follow this 4-step cycle:

1. **Design Doc** — Write `implementation_plan.md` documenting the approach
2. **Milestones** — Subdivide into independently verifiable steps in `task.md`
3. **Implementation** — For each milestone: code + unit tests + E2E tests
4. **Regression** — Run all E2E tests (`npm run test:e2e`)

For new tasks: create a branch, follow the workflow, then `gh pr create --draft`.
For context switching: `gh pr checkout <number>` then `gh pr view --comments`.

## Environment Setup

Environment files: `.env.emulator` (local), `.env.staging`, `.env.production`

Switch environments with `npm run env:local/staging/production`.

For local development: copy `.env.example` to `.env`, run `npm run emulators` in one terminal, then `npm run dev:local` in another.

The pre-commit hook (`scripts/check-no-wait-for-timeout.js`) rejects `waitForTimeout` calls in E2E tests.

### Nix + direnv

The development environment is defined by a **Nix flake** (`flake.nix`). `direnv` automatically loads the flake when you enter the project directory (via `.envrc`).

When a tool is missing from the shell:

- **Do not install it globally** with `brew`, `npm -g`, or similar.
- **Add it to the flake** so all contributors and CI get the same version automatically.
- After editing `flake.nix`, run `direnv reload` (or `cd` out and back in) to apply the change.
