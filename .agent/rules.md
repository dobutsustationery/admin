# Repository Rules & Policies

All contributors must adhere to the following rules when working in this repository.

## 1. Submission Workflow

When you are ready to submit changes, follow this mandatory workflow:

1.  **Preparation & Clean Up (CRITICAL)**
    *   **Branch Check**: Ensure you are NOT on `main`. Run `git checkout -b feature/name` (or `fix/name`) if you are.
    *   **Git Status**: Run `git status` to see what files are changed/untracked.
    *   **Format**: Run `npm run format` to fix style issues.
    *   **Check/Lint**: Run `npm run check` to ensure no errors.
        *   *If these fail, FIX THEM. Do not proceed to commit.*


## 2. Testing & Verification - **MANDATORY PREREQUISITE**

Before committing your changes, you must ensure:

*   **Tests Pass**: All relevant E2E tests must pass locally.
*   **E2E Artifacts**: All new E2E tests **must** generate visual verification artifacts.
    *   Use `createScreenshotHelper` and `TestDocumentationHelper` in your tests.
    *   Ensure every test run generates a `README.md` and screenshots in the test's directory (e.g., `e2e/090-my-test/README.md`).
    *   These artifacts serve as the proof of work for reviewers.

**DO NOT COMMIT OR PUSH IF TESTS ARE FAILING.**

## 3. Commit Changes
    *   **Stage**: `git add .` (Ensures *all* files, including new ones, are staged).
    *   **Verify**: Run `git status` again to confirm everything is staged.
    *   **Commit**: `git commit -m "Type: Descriptive message"` (e.g., `feat: ...`, `fix: ...`).

## 4. Sync with Remote
    *   **Push**: `git push` (or `git push -u origin <branch>` if first push).

## 5. Pull Request Management
    *   **Check Existence**: Run `gh pr list --head $(git branch --show-current)` to check for existing PRs.
    *   **Create**: `gh pr create --title "Title" --body "Description"` if none exists.
    *   **Verify**: Ensure the PR is open and linked correctly.
