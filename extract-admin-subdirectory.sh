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

# Step 1: Ensure we're in a clean state
echo ""
echo "Step 1: Checking repository state..."
if [[ -n $(git status -s) ]]; then
    echo "ERROR: Working directory is not clean. Please commit or stash changes first."
    git status -s
    exit 1
fi
echo "✓ Repository is clean"

# Step 2: Fetch the source branch
echo ""
echo "Step 2: Fetching '$SOURCE_BRANCH' branch..."
if ! git fetch origin "$SOURCE_BRANCH:$SOURCE_BRANCH" 2>/dev/null; then
    echo "Note: Branch may already exist locally, trying to update..."
    git fetch origin "$SOURCE_BRANCH" || {
        echo "ERROR: Could not fetch branch '$SOURCE_BRANCH'"
        exit 1
    }
fi
echo "✓ Branch fetched"

# Step 3: Use git subtree split to extract the subdirectory history
echo ""
echo "Step 3: Extracting subdirectory history using git subtree split..."
echo "This may take a few minutes..."

# Create a new branch with just the subdirectory
TEMP_BRANCH="temp-admin-extraction-$(date +%s)"
git subtree split --prefix="$SUBDIRECTORY" "$SOURCE_BRANCH" -b "$TEMP_BRANCH"

if [ $? -ne 0 ]; then
    echo "ERROR: git subtree split failed"
    exit 1
fi
echo "✓ Created temporary branch: $TEMP_BRANCH"

# Step 4: Merge the extracted branch into current branch
echo ""
echo "Step 4: Merging extracted content into current branch..."
echo "Strategy: Replace current content with extracted content"

# We'll use a strategy that brings in the files at the root level
git merge "$TEMP_BRANCH" --allow-unrelated-histories -m "Extract admin.dobutsustationery.com to root from website-admin branch" || {
    echo ""
    echo "Note: Merge may have conflicts. This is expected if files already exist."
    echo "The extracted files are now at the root level."
    echo ""
    echo "To resolve conflicts and prefer the extracted version:"
    echo "  git checkout --theirs ."
    echo "  git add ."
    echo "  git commit --no-edit"
    echo ""
    echo "Or to manually resolve, edit the conflicting files and then:"
    echo "  git add <resolved-files>"
    echo "  git commit --no-edit"
    echo ""
    exit 0
}

echo "✓ Merge complete"

# Step 5: Clean up temporary branch
echo ""
echo "Step 5: Cleaning up..."
git branch -D "$TEMP_BRANCH"
echo "✓ Temporary branch deleted"

# Step 6: Show the result
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
echo "  git diff HEAD~1"
echo ""
echo "If everything looks good, push with:"
echo "  git push origin $CURRENT_BRANCH"
echo ""
