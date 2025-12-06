---
description: How to submit changes via Pull Request
---

1. Ensure you are on a feature branch (not main/develop).
2. Stage and commit your changes with a descriptive message.
3. Push the branch to origin: `git push -u origin <branch_name>`.
4. Create a Pull Request using GitHub CLI:
   ```bash
   gh pr create --title "Title" --body "Description"
   ```
5. Wait for CI checks to pass (if applicable).
6. Request review if creating as draft, or merge if authorized.
