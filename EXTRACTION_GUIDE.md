# Extracting Admin Subdirectory - Proper Approach

## Current Situation

The `admin.dobutsustationery.com` subdirectory exists in the `website-admin` branch of this repository. It needs to be extracted to the root of this repository while preserving git history.

## Why Manual File Copying Was Not Ideal

The previous approach manually downloaded and created files one-by-one from the GitHub API. This approach had several issues:

1. **Lost Git History**: Files were created as new files, losing all commit history from the original branch
2. **No Blame Information**: `git blame` won't show the original authors and changes
3. **Tedious and Error-Prone**: Required manually fetching hundreds of files
4. **Incomplete**: Binary files and some subdirectories were not fully extracted

## The Proper Solution: `git subtree split`

The correct approach uses Git's built-in `git subtree split` command, which:

- ✅ Preserves complete git history for the subdirectory
- ✅ Maintains authorship and commit messages
- ✅ Works with all file types (including binaries)
- ✅ Is reliable and automatic
- ✅ Standard Git workflow, well-tested

## How to Use the Extraction Script

A script has been provided: `extract-admin-subdirectory.sh`

### Prerequisites

1. **Full Clone Required**: The repository must NOT be a shallow clone. Git subtree split requires full history.
   ```bash
   # Check if you have a shallow clone:
   ls .git/shallow
   
   # If the file exists, unshallow the repository:
   git fetch --unshallow
   ```

2. **Git Authentication**: You must have Git authentication configured (the script needs to fetch branches)

3. **Clean Branch**: You should be on the branch where you want the files (e.g., `copilot/bring-admin-folder-to-root`)

4. **Remove Manual Files**: Remove any manually created files from previous attempts:
   ```bash
   # If you have manually created files from previous attempts, remove them:
   git rm -r .firebaserc .gitignore .husky .npmrc .vscode LICENSE README.md \
            biome.json firebase.json package.json src static svelte.config.js \
            tests tsconfig.json vite.config.ts 2>/dev/null || true
   ```

### Running the Script

```bash
# Make sure you're on the correct branch
git checkout copilot/bring-admin-folder-to-root

# Run the extraction script
./extract-admin-subdirectory.sh
```

### What the Script Does

1. **Checks for shallow clone** - Exits with instructions if repository is shallow
2. **Validates** repository state (allows deleted files from cleanup)
3. **Fetches** the `website-admin` branch and verifies it exists
4. **Extracts** the `admin.dobutsustationery.com` subdirectory using `git subtree split`
5. **Reads** the extracted content into your current branch using `git read-tree`
6. **Creates** a new commit with the extracted files at root level
7. **Cleans up** temporary branches

### After Running

Review the changes:
```bash
git log --oneline -10
git show --stat
```

If satisfied, push:
```bash
git push origin copilot/bring-admin-folder-to-root
```

## Alternative: Manual Commands

If you prefer to run the commands manually (after ensuring you have a full clone):

```bash
# 0. If you have a shallow clone, unshallow it first
git fetch --unshallow

# 1. Fetch the source branch with full history
git fetch origin website-admin

# 2. Create a local branch tracking the remote
git branch website-admin origin/website-admin

# 3. Verify the branch and directory exist
git rev-parse --verify website-admin
git ls-tree website-admin --name-only | grep admin.dobutsustationery.com

# 4. Checkout the source branch (required for subtree split to work)
git checkout website-admin

# 5. Create a new branch with just the subdirectory using subtree split
git subtree split --prefix=admin.dobutsustationery.com -b temp-admin

# 6. Switch back to your target branch
git checkout copilot/bring-admin-folder-to-root

# 7. Read the extracted tree into the current branch
git read-tree temp-admin

# 8. Commit the changes
git commit -m "Extract admin subdirectory to root"

# 9. Clean up
git branch -D temp-admin
```

## Key Requirements

**Critical**: The repository MUST be a full clone, not a shallow clone. Git subtree split requires complete history to work.

**Important**: Git subtree split must be run from a branch that contains the subdirectory in its history. The script temporarily checks out the source branch, runs the split, then returns to your original branch.

The corrected script:
- **Checks for shallow clone** and exits with clear instructions if found
- Fetches the source branch and creates/updates local tracking branch
- **Temporarily checks out the source branch** to run subtree split in the correct context
- Returns to the original branch after split completes
- Uses `git read-tree` to bring files to root without merge conflicts
- Properly cleans up temporary branches

## Summary

**Current state**: All manually created files have been removed

**Critical requirement**: Repository must be a full clone (not shallow). Run `git fetch --unshallow` if needed.

**Recommended action**: Run `extract-admin-subdirectory.sh` to properly extract with history

**Benefit**: Complete git history, proper attribution, and all files extracted correctly including binaries
