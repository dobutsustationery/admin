#!/bin/bash

# Generate baseline screenshots for the CSV export Google Drive integration test
# This script must be run locally after setting up Firebase emulators

set -e

echo "🖼️  Generating baseline screenshots for CSV export test (002-csv)"
echo "=================================================================="
echo ""

# Check if emulators are running
if ! curl -s http://localhost:8080 > /dev/null 2>&1; then
  echo "❌ Firebase emulators are not running on port 8080"
  echo "   Please start them in another terminal with: npm run emulators"
  echo ""
  exit 1
fi

echo "✓ Firestore emulator is running"

# Check if auth emulator is running
if ! curl -s http://localhost:9099 > /dev/null 2>&1; then
  echo "❌ Auth emulator is not running on port 9099"
  echo "   Please ensure Firebase emulators are fully started"
  exit 1
fi

echo "✓ Auth emulator is running"

# Load test data into emulator
echo ""
echo "📦 Loading test data into emulator..."
node e2e/helpers/load-test-data.js --prefix=400
echo "✓ Test data loaded"

# Build application if needed
if [ ! -d "build" ]; then
  echo ""
  echo "📦 Building application for emulator mode..."
  npm run build:local
  echo "✓ Build complete"
else
  echo "✓ Build exists"
fi

# Generate baselines for CSV test
echo ""
echo "📸 Generating baseline screenshots for 002-csv test..."
echo ""

npx playwright test e2e/002-csv/002-csv.spec.ts --update-snapshots

echo ""
echo "✅ Baseline screenshots generated!"
echo ""
echo "📁 Screenshots saved to: e2e/002-csv/screenshots/"
echo ""
echo "   Expected screenshots:"
echo "   - 000-signed-out-state.png"
echo "   - 001-signed-in-state.png"
echo "   - 002-drive-ui-visible.png"
echo "   - 003-drive-ui-structure.png"
echo "   - 004-ui-elements.png"
echo ""
echo "⚠️  IMPORTANT: Review the screenshots to ensure they look correct, then commit them:"
echo "   git add e2e/002-csv/screenshots/"
echo "   git commit -m 'Add baseline screenshots for CSV export Google Drive test'"
echo ""
