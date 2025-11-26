#!/bin/bash

# Script to generate initial baseline screenshots for visual regression testing
# This should be run once to establish the baseline, then checked into git

set -e

echo "🖼️  Generating baseline screenshots for visual regression testing"
echo "=================================================================="
echo ""

# Check if emulators are running
if ! curl -s http://localhost:8080 > /dev/null 2>&1; then
  echo "❌ Firebase emulators are not running on port 8080"
  echo "   Please start them with: npm run emulators"
  exit 1
fi

echo "✓ Firestore emulator is running"

# Check if preview server is running or build exists
if [ ! -d "build" ]; then
  echo "📦 Building application for emulator mode..."
  npm run build:local
fi

echo "✓ Build exists"

# Run Playwright to generate baseline
echo ""
echo "📸 Running Playwright to generate baseline screenshots..."
echo "   This will create/update snapshots in e2e/###-<testname>/screenshots/"
echo ""

npx playwright test --update-snapshots

echo ""
echo "✅ Baseline screenshots generated!"
echo ""
echo "📁 Check the files in e2e/###-<testname>/screenshots/"
echo "   These should be committed to git for visual regression testing"
echo ""
echo "ℹ️  Note: The test will fail on subsequent runs if the UI changes."
echo "   To approve changes, run: npx playwright test --update-snapshots"
