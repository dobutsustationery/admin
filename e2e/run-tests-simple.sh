#!/bin/bash

# Simple E2E Test Runner for CI
# This script assumes emulators are already running and managed externally

set -e  # Exit on error

# Keep app build and data loaders pinned to the same emulator project namespace.
FIREBASE_PROJECT_ID="${E2E_FIREBASE_PROJECT_ID:-demo-test-project}"
export E2E_FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID}"
export VITE_FIREBASE_LOCAL_PROJECT_ID="${VITE_FIREBASE_LOCAL_PROJECT_ID:-${FIREBASE_PROJECT_ID}}"

# Record start time
START_TIME=$(date +%s)

echo "🧪 Simple E2E Test Runner (for CI)"
echo "===================================="
echo ""

# Check if test data file exists
if [ ! -f "test-data/firestore-export.json" ]; then
  echo "❌ Test data file not found: test-data/firestore-export.json"
  exit 1
fi

echo "✓ Test data file found"
echo ""

# Check if emulators are running
check_emulators() {
  if curl -s http://localhost:8080 > /dev/null 2>&1; then
    echo "✓ Firestore emulator is running on port 8080"
    return 0
  else
    echo "✗ Firestore emulator is not running on port 8080"
    echo "  Please start emulators first with: npm run emulators"
    return 1
  fi
}

if check_emulators; then
  echo "📥 Downloading test images..."
  node e2e/helpers/download-test-images.js
  
  echo ""
  echo "🔗 Creating symlink for test images..."
  if [ -L "static/test-images" ] || [ -e "static/test-images" ]; then
    rm -f static/test-images
  fi
  ln -sf ../e2e/test-images static/test-images
  
  echo ""
  echo "📦 Loading test data into emulator..."
  node e2e/helpers/load-test-data.js --match-jancodes=10
  
  echo ""
  echo "🏗️  Building application for emulator mode..."
  npm run build:local
  
  echo ""
  echo "▶️  Running Playwright tests..."
  
  # Record test start time
  TEST_START_TIME=$(date +%s)
  npx playwright test --config=playwright.nonlive.config.ts "$@"
  TEST_EXIT_CODE=$?
  
  # Calculate test duration
  TEST_END_TIME=$(date +%s)
  TEST_DURATION=$((TEST_END_TIME - TEST_START_TIME))
  
  echo ""
  if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo "✅ All tests passed!"
  else
    echo "❌ Some tests failed (exit code: $TEST_EXIT_CODE)"
    echo ""
    echo "📊 To view the test report, run:"
    echo "   npx playwright show-report e2e/reports/html"
  fi
  
  # Calculate and display total duration
  END_TIME=$(date +%s)
  TOTAL_DURATION=$((END_TIME - START_TIME))
  
  echo ""
  echo "⏱️  Timing Summary"
  echo "=================="
  echo "Test execution time: ${TEST_DURATION}s"
  echo "Total script time:   ${TOTAL_DURATION}s"
  
  exit $TEST_EXIT_CODE
else
  echo ""
  echo "ℹ️  Start emulators in a separate terminal with:"
  echo "   npm run emulators"
  echo ""
  echo "Then run this script again."
  exit 1
fi
