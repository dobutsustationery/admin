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

1. You must have Git authentication configured (the script needs to fetch branches)
2. You should be on the branch where you want the files (e.g., `copilot/bring-admin-folder-to-root`)
3. Your working directory should be clean (no uncommitted changes)

### Running the Script

```bash
# Make sure you're on the correct branch
git checkout copilot/bring-admin-folder-to-root

# Run the extraction script
./extract-admin-subdirectory.sh
```

### What the Script Does

1. **Validates** repository state
2. **Fetches** the `website-admin` branch
3. **Extracts** the `admin.dobutsustationery.com` subdirectory using `git subtree split`
4. **Merges** the extracted content into your current branch
5. **Cleans up** temporary branches

### After Running

Review the changes:
```bash
git log --oneline -20
git diff HEAD~1
```

If satisfied, push:
```bash
git push origin copilot/bring-admin-folder-to-root
```

## Alternative: Manual Commands

If you prefer to run the commands manually:

```bash
# 1. Fetch the source branch
git fetch origin website-admin:website-admin

# 2. Create a new branch with just the subdirectory
git subtree split --prefix=admin.dobutsustationery.com website-admin -b temp-admin

# 3. Merge into your current branch (will place files at root)
git merge temp-admin --allow-unrelated-histories -m "Extract admin subdirectory to root"

# 4. Clean up
git branch -D temp-admin
```

## Why the Shallow Clone Was a Problem

The repository was cloned with `--depth=1` (shallow clone), which:
- Only fetches recent commits
- Cannot fetch additional branches without authentication
- Cannot properly run `git subtree split` without full history

This is why the proper approach requires git authentication to fetch the full branch.

## Handling Conflicts

If there are merge conflicts (because files already exist from manual creation):

```bash
# Accept the extracted version (from website-admin branch)
git checkout --theirs .
git add .
git commit --no-edit
```

Or manually resolve conflicts and commit.

## Summary

**Current state**: Files were manually copied, losing git history

**Recommended action**: Run `extract-admin-subdirectory.sh` to properly extract with history

**Benefit**: Complete git history, proper attribution, and all files extracted correctly
