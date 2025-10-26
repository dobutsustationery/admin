# E2E Testing Reminder for GitHub Copilot

## 🚨 IMPORTANT: Always Run E2E Tests After Changes

**This is a critical reminder for the GitHub Copilot agent:**

### Responsibility

It is **YOUR responsibility** as the Copilot agent to:

1. **Run e2e tests** at the end of every change that affects the application
2. **Update e2e screenshots** when they change
3. **Commit the updated screenshots** to the repository

### When to Run E2E Tests

Run e2e tests whenever you make changes to:
- Application code (src/)
- Test files (e2e/)
- Authentication logic
- Page layouts or components
- Any user-facing features

### How to Run E2E Tests

```bash
# Option 1: If emulators are already running
npm run test:e2e:simple

# Option 2: Full run (starts emulators automatically)
npm run test:e2e
```

### What to Do After Running Tests

1. **Check for new/updated screenshots** in `e2e/screenshots/`
2. **Review the screenshots** to ensure they show the expected behavior
3. **Commit the screenshots** along with your code changes
4. **Update PR description** if the screenshots reveal important changes

### Screenshot Guidelines

- Numbered screenshots (000, 001, 002...) tell a story
- Each screenshot should document a specific step in the user journey
- Screenshots are committed to git (not gitignored)
- They serve as visual documentation and regression tests

### Remember

❌ **DON'T** submit PRs without updated screenshots if tests changed
✅ **DO** run tests after every significant change
✅ **DO** commit screenshots with your changes
✅ **DO** verify screenshots show expected behavior

---

**This reminder was created in response to feedback to ensure screenshots are always up-to-date.**
