#!/bin/bash
#
# extract-admin-subdirectory.sh
#
# This script extracts the admin.dobutsustationery.com subdirectory from the
# website-admin branch and moves its contents to the root of the current branch.
# It preserves the git history for files in that subdirectory.
#
# Usage: ./extract-admin-subdirectory.sh
#
# Requirements:
# - Git authentication configured (to fetch branches)
# - Running from the repository root

set -e  # Exit on error

REPO_ROOT=$(git rev-parse --show-toplevel)
CURRENT_BRANCH=$(git branch --show-current)
SOURCE_BRANCH="website-admin"
SUBDIRECTORY="admin.dobutsustationery.com"

echo "==============================================="
echo "Admin Subdirectory Extraction Script"
echo "==============================================="
echo ""
echo "This script will extract the '$SUBDIRECTORY' directory"
echo "from the '$SOURCE_BRANCH' branch to the root of '$CURRENT_BRANCH'"
echo ""
echo "Repository: $REPO_ROOT"
echo "Current branch: $CURRENT_BRANCH"
echo ""

# Confirm before proceeding
read -p "Continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
fi

# Step 1: Check if this is a shallow clone
echo ""
echo "Step 1: Checking if repository is shallow..."
if [ -f .git/shallow ]; then
    echo "⚠ WARNING: This is a shallow clone!"
    echo ""
    echo "Git subtree split requires a full clone with complete history."
    echo "You need to unshallow the repository first:"
    echo ""
    echo "  git fetch --unshallow"
    echo ""
    echo "After unshallowing, run this script again."
    exit 1
fi
echo "✓ Repository has full history"

# Step 2: Ensure we're in a clean state (allow deleted files from cleanup)
echo ""
echo "Step 2: Checking repository state..."
UNTRACKED=$(git status --porcelain | grep -E '^\?\?' || true)
if [[ -n "$UNTRACKED" ]]; then
    echo "ERROR: Working directory has untracked files. Please remove or commit them first."
    echo "$UNTRACKED"
    exit 1
fi
echo "✓ Repository is ready (note: deleted files from previous manual creation are OK)"

# Step 3: Fetch the source branch
echo ""
echo "Step 3: Fetching '$SOURCE_BRANCH' branch..."
# First, try to create/update the local branch from remote
if git fetch origin "$SOURCE_BRANCH:$SOURCE_BRANCH" 2>&1 | grep -q "fatal\|error"; then
    echo "Note: Branch may already exist locally, trying to update..."
    if ! git fetch origin "$SOURCE_BRANCH" 2>&1; then
        echo "ERROR: Could not fetch branch '$SOURCE_BRANCH'"
        echo "Make sure you have internet connectivity and access to the repository."
        exit 1
    fi
fi

# Verify the branch exists now
if ! git rev-parse --verify "$SOURCE_BRANCH" >/dev/null 2>&1; then
    echo "ERROR: Branch '$SOURCE_BRANCH' still not found after fetch."
    echo "Available branches:"
    git branch -a
    exit 1
fi
echo "✓ Branch fetched: $SOURCE_BRANCH"

# Step 4: Use git subtree split to extract the subdirectory history
echo ""
echo "Step 4: Extracting subdirectory history using git subtree split..."
echo "This may take a few minutes..."

# Create a new branch with just the subdirectory
# We need to run subtree split on the SOURCE_BRANCH, not the current branch
TEMP_BRANCH="temp-admin-extraction-$(date +%s)"

# Check if the subdirectory exists in the source branch
if ! git ls-tree -r "$SOURCE_BRANCH" --name-only | grep -q "^$SUBDIRECTORY/"; then
    echo "ERROR: Directory '$SUBDIRECTORY' not found in branch '$SOURCE_BRANCH'"
    echo "Available top-level directories:"
    git ls-tree "$SOURCE_BRANCH" --name-only
    exit 1
fi

# Run subtree split
git subtree split --prefix="$SUBDIRECTORY" "$SOURCE_BRANCH" -b "$TEMP_BRANCH"

if [ $? -ne 0 ]; then
    echo "ERROR: git subtree split failed"
    exit 1
fi
echo "✓ Created temporary branch: $TEMP_BRANCH"

# Step 5: Read the files from the temporary branch into the current branch
echo ""
echo "Step 5: Reading extracted content into current branch..."

# Use git read-tree to get the content at the root
git read-tree "$TEMP_BRANCH"

# Create a new commit with the extracted content
git commit -m "Extract admin.dobutsustationery.com to root from website-admin branch

This commit extracts the admin.dobutsustationery.com subdirectory from the
website-admin branch using git subtree split, preserving the complete git
history of all files within that directory.

The files are now at the root level of this repository, making this a
standalone Firebase project for the admin site." || {
    echo ""
    echo "Note: Commit may have failed. Checking status..."
    git status
    exit 1
}

echo "✓ Extraction complete"

# Step 6: Clean up temporary branch
echo ""
echo "Step 6: Cleaning up..."
git branch -D "$TEMP_BRANCH"
echo "✓ Temporary branch deleted"

# Step 7: Show the result
echo ""
echo "==============================================="
echo "Extraction Complete!"
echo "==============================================="
echo ""
echo "The contents of '$SUBDIRECTORY' from the '$SOURCE_BRANCH' branch"
echo "have been extracted to the root of the current branch."
echo ""
echo "Files at root level now:"
git ls-tree --name-only HEAD | head -20
echo ""
echo "Review the changes with:"
echo "  git log --oneline -10"
echo "  git show --stat"
echo ""
echo "If everything looks good, push with:"
echo "  git push origin $CURRENT_BRANCH"
echo ""
