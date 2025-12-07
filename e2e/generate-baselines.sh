#!/bin/bash

# Script to generate initial baseline screenshots for visual regression testing
# This should be run once to establish the baseline, then checked into git
#
# Prerequisites (automatically set up in Copilot/GitHub Actions via copilot-setup-steps.yml):
# - Node.js 20+
# - npm dependencies installed (npm ci)
# - Firebase emulators available and cached
# - Playwright browsers installed (npx playwright install --with-deps chromium)
# - Firebase emulators running on port 8080 (Firestore) and 9099 (Auth)
# - Test data loaded with --match-jancodes=10

set -e

echo "🖼️  Generating baseline screenshots for visual regression testing"
echo "=================================================================="
echo ""

# Check if emulators are running
if ! curl -s http://localhost:8080 >/dev/null 2>&1; then
	echo "❌ Firebase emulators are not running on port 8080"
	echo "   Please start them with: npm run emulators"
	exit 1
fi

echo "✓ Firestore emulator is running"

# Download test images for local serving (ensures consistent image loading)
echo ""
echo "📥 Downloading test images..."
node e2e/helpers/download-test-images.js
echo "✓ Test images downloaded"

# Create symlink for serving test images
echo ""
echo "🔗 Creating symlink for test images..."
if [ -L "static/test-images" ] || [ -e "static/test-images" ]; then
	rm -f static/test-images
fi
ln -sf ../e2e/test-images static/test-images
echo "✓ Symlink created: static/test-images -> e2e/test-images"

# Load test data into emulator
echo ""
echo "📦 Loading test data into emulator..."
node e2e/helpers/load-test-data.js --match-jancodes=10
echo "✓ Test data loaded (matching JAN codes from first 10 records)"

# Check if preview server is running or build exists
echo ""
echo "📦 Building application for emulator mode..."
npm run build:local

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
