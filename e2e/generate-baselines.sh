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

# Load test data into emulator
echo ""
echo "📦 Loading test data into emulator..."
node e2e/helpers/load-test-data.js --prefix=3700
echo "✓ Test data loaded (3700 broadcast events)"

# Check if preview server is running or build exists
if [ ! -d "build" ]; then
  echo ""
  echo "📦 Building application for emulator mode..."
  npm run build:local
fi

echo "✓ Build exists"

# Run Playwright to generate baseline
echo ""
echo "📸 Running Playwright to generate baseline screenshots..."
echo "   This will create/update snapshots in e2e/###-<testname>/screenshots/"
echo "   for all tests (use specific test path to update only one test)"
echo ""

# Generate baselines for all tests
# To update a specific test only: npx playwright test e2e/000-inventory/000-inventory.spec.ts --update-snapshots
npx playwright test --update-snapshots

echo ""
echo "✅ Baseline screenshots generated!"
echo ""
echo "📁 Check the files in e2e/###-<testname>/screenshots/"
echo "   These should be committed to git for visual regression testing"
echo ""
echo "ℹ️  Note: The test will fail on subsequent runs if the UI changes."
echo "   To approve changes, run: npx playwright test --update-snapshots"
