---
description: How to submit changes via Pull Request
---

1.  **Preparation & Clean Up (CRITICAL)**
    *   **Git Status**: Run `git status` to see what files are changed/untracked.
    *   **Format**: Run `npm run format` (or equivalent) to fix style issues.
    *   **Check/Lint**: Run `npm run check` (or `npm run lint`) to ensure no errors.
        *   *If these fail, FIX THEM. Do not proceed to commit.*

2.  **Commit Changes**
    *   **Stage**: `git add .` (Ensures *all* files, including new ones, are staged).
    *   **Verify**: Run `git status` again to confirm everything is staged.
    *   **Commit**: `git commit -m "Type: Descriptive message"`
        *   *Note: If you are amending a previous commit to fix CI/lint, use `git commit --amend --no-edit`.*

3.  **Sync with Remote**
    *   **Push**: `git push` (or `git push -u origin <branch>` if first push).

4.  **Pull Request Management**
    *   **Check Existence**: Run `gh pr list --head $(git branch --show-current)` to see if a PR is already open.
    *   **Create (if needed)**:
        ```bash
        gh pr create --title "Descriptive Title" --body "Detailed description of changes."
        ```
    *   **Update Verification**: If the PR already exists, the push in step 3 updated it. Confirm this by checking the PR link or running `gh pr view`.
