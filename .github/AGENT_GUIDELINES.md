# Antigravity Agent Guidelines

This repository is configured for AI assistance. As an Antigravity agent, you must adhere to the following guidelines to ensure effective collaboration and code quality.

## 1. Coding Standards & Project Context
**Primary Source of Truth**: `.github/copilot-instructions.md` from the repo root.
- **Strictly follow** the coding style, patterns, and architectural guidelines defined there.
- Pay special attention to:
    - **TypeScript**: Strict typing (despite current errors, strive for no new errors).
    - **Redux Toolkit**: Use `createAction` and `broadcast` patterns for state sync.
    - **Firebase**: Use modular v9+ SDK.

## 2. Agent Workflow Artifacts & Process
We use a **Strict Design-First Workflow** in this repository.

### The 4-Step Development Cycle
1.  **Design Doc**: Create a design document for the task.
2.  **Milestones**: Subdivide the design doc into intermediate milestones that can be independently verified.
3.  **Implementation**: For *each* milestone, write:
    - Code
    - Unit Tests
    - **E2E Tests** (Critical for verification)
4.  **Regression**: Run *all* E2E tests to ensure nothing was broken.

### Key Artifacts
- **`task.md`**: Tracks the Milestones defined in step 2.
- **`implementation_plan.md`**: Documents the Design (Step 1).
- **`walkthrough.md`**: Summary of verification results.

## 3. Environment & Verification
- **E2E Tests (`e2e/`)**: **REQUIRED**.
    - E2E tests are the primary verification mechanism.
    - Each E2E directory has a `README.md` that is the source of truth for functionality validation.
    - Run all: `npm run test:e2e` (or specific scripts as defined in package.json).
- **Unit Tests (`tests/`)**: `bun run test` (Vitest).
- **Linter**: `bun run lint:fix`.
- **Type Checking**: `bun run check`.

## 4. Specific "Gotchas"
- **Imports**: Use `$lib/` aliases.
- **Strict Verification**: User relies on E2E `README.md` files to validate functionality. Ensure your tests align with these descriptions.
