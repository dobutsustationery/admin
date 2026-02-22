#!/bin/bash

# E2E Test Runner Script
# This script sets up and runs the Playwright E2E tests with Firebase emulators

set -e  # Exit on error

FIRESTORE_HOST="${E2E_FIRESTORE_EMULATOR_HOST:-localhost}"
FIRESTORE_PORT="${E2E_FIRESTORE_EMULATOR_PORT:-8080}"
AUTH_PORT="${E2E_AUTH_EMULATOR_PORT:-9099}"
PREVIEW_PORT="${E2E_PREVIEW_PORT:-4173}"
FIREBASE_CONFIG_PATH="${E2E_FIREBASE_CONFIG_PATH:-firebase.json}"
EMULATOR_LOG_PATH="${E2E_EMULATOR_LOG_PATH:-/tmp/emulators.log}"

export FIRESTORE_EMULATOR_HOST="${FIRESTORE_HOST}:${FIRESTORE_PORT}"
export E2E_AUTH_EMULATOR_URL="${E2E_AUTH_EMULATOR_URL:-http://localhost:${AUTH_PORT}}"
export E2E_PREVIEW_BASE_URL="${E2E_PREVIEW_BASE_URL:-http://localhost:${PREVIEW_PORT}}"
export VITE_EMULATOR_FIRESTORE_HOST="${FIRESTORE_HOST}"
export VITE_EMULATOR_FIRESTORE_PORT="${FIRESTORE_PORT}"
export VITE_EMULATOR_AUTH_HOST="localhost"
export VITE_EMULATOR_AUTH_PORT="${AUTH_PORT}"

# Record start time
START_TIME=$(date +%s)

echo "🧪 E2E Test Runner"
echo "=================="
echo ""

# Check if emulators are running
check_emulators() {
  echo "📡 Checking if Firebase emulators are running..."
  if curl -s "http://${FIRESTORE_HOST}:${FIRESTORE_PORT}" > /dev/null 2>&1; then
    echo "✓ Firestore emulator is running on port ${FIRESTORE_PORT}"
    return 0
  else
    echo "✗ Firestore emulator is not running on port ${FIRESTORE_PORT}"
    return 1
  fi
}

# Start emulators if not running
if ! check_emulators; then
  echo ""
  echo "🔥 Starting Firebase emulators..."
  (npm run env:functions:local && firebase emulators:start --config "${FIREBASE_CONFIG_PATH}") > "${EMULATOR_LOG_PATH}" 2>&1 &
  EMULATOR_PID=$!
  echo "   Started emulators (PID: $EMULATOR_PID)"
  
  # Wait for emulators to be ready
  echo "   Waiting for emulators to be ready..."
  for i in {1..30}; do
    if check_emulators; then
      break
    fi
    if [ $i -eq 30 ]; then
      echo "❌ Emulators failed to start after 30 seconds"
      cat "${EMULATOR_LOG_PATH}"
      exit 1
    fi
    sleep 1
  done
fi

echo ""
echo "📥 Downloading test images (cached images will be skipped)..."
node e2e/helpers/download-test-images.js --match-jancodes=10

echo ""
echo "🔗 Creating symlink for test images..."
if [ -L "static/test-images" ] || [ -e "static/test-images" ]; then
  rm -f static/test-images
fi
ln -sf ../e2e/test-images static/test-images

echo ""
echo "📦 Loading test data into emulator with local images..."
node e2e/helpers/load-test-data-with-local-images.js --match-jancodes=10

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

# Clean up if we started the emulators
if [ ! -z "$EMULATOR_PID" ]; then
  echo ""
  echo "🧹 Stopping emulators..."
  kill $EMULATOR_PID 2>/dev/null || true
fi

exit $TEST_EXIT_CODE
