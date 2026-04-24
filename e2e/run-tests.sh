#!/bin/bash

# E2E Test Runner Script
# This script sets up and runs the Playwright E2E tests with Firebase emulators

set -e  # Exit on error

FIRESTORE_HOST="${E2E_FIRESTORE_EMULATOR_HOST:-localhost}"
# Default to isolated E2E ports so ad-hoc runs don't attach to the developer's local stack.
FIRESTORE_PORT="${E2E_FIRESTORE_EMULATOR_PORT:-18080}"
AUTH_PORT="${E2E_AUTH_EMULATOR_PORT:-19099}"
PREVIEW_PORT="${E2E_PREVIEW_PORT:-14173}"
FIREBASE_CONFIG_PATH="${E2E_FIREBASE_CONFIG_PATH:-firebase.prepush.json}"
FIREBASE_PROJECT_ID="${E2E_FIREBASE_PROJECT_ID:-demo-test-project}"
EMULATOR_LOG_PATH="${E2E_EMULATOR_LOG_PATH:-/tmp/dobutsu-e2e-emulators.log}"

export FIRESTORE_EMULATOR_HOST="${FIRESTORE_HOST}:${FIRESTORE_PORT}"
export E2E_FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID}"
export VITE_FIREBASE_LOCAL_PROJECT_ID="${VITE_FIREBASE_LOCAL_PROJECT_ID:-${FIREBASE_PROJECT_ID}}"
export E2E_FIRESTORE_EMULATOR_PORT="${FIRESTORE_PORT}"
export E2E_AUTH_EMULATOR_PORT="${AUTH_PORT}"
export E2E_PREVIEW_PORT="${PREVIEW_PORT}"
export E2E_AUTH_EMULATOR_URL="${E2E_AUTH_EMULATOR_URL:-http://localhost:${AUTH_PORT}}"
export E2E_PREVIEW_BASE_URL="${E2E_PREVIEW_BASE_URL:-http://localhost:${PREVIEW_PORT}}"
export VITE_EMULATOR_FIRESTORE_HOST="${FIRESTORE_HOST}"
export VITE_EMULATOR_FIRESTORE_PORT="${FIRESTORE_PORT}"
export VITE_EMULATOR_AUTH_HOST="localhost"
export VITE_EMULATOR_AUTH_PORT="${AUTH_PORT}"
export E2E_FIXED_CREATED_TIME="${E2E_FIXED_CREATED_TIME:-2025-01-15T10:00:00.000Z}"
export SHOPIFY_CLIENT_SECRET="${SHOPIFY_CLIENT_SECRET:-test_secret}"

# Record start time
START_TIME=$(date +%s)

echo "🧪 E2E Test Runner"
echo "=================="
echo ""
echo "Using emulator ports: Firestore=${FIRESTORE_PORT}, Auth=${AUTH_PORT}"
echo "Using preview port: ${PREVIEW_PORT}"
echo "Using Firebase config: ${FIREBASE_CONFIG_PATH}"
echo "Using Firebase project: ${FIREBASE_PROJECT_ID}"
echo ""

print_emulator_port_diagnostics() {
  if command -v lsof >/dev/null 2>&1; then
    echo "Port diagnostics:"
    lsof -nP -iTCP:"${FIRESTORE_PORT}" -sTCP:LISTEN || true
    lsof -nP -iTCP:"${AUTH_PORT}" -sTCP:LISTEN || true
  fi
}

kill_stale_emulator_port_processes() {
  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi

  for port in "${FIRESTORE_PORT}" "${AUTH_PORT}"; do
    pids="$(lsof -t -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ')"
    [ -z "${pids}" ] && continue
    for pid in ${pids}; do
      comm="$(ps -p "${pid}" -o comm= 2>/dev/null | tr -d ' ')"
      comm_base="$(basename "${comm}" 2>/dev/null || echo "${comm}")"
      if [ "${comm_base}" = "java" ]; then
        echo "Killing stray java process ${pid} on emulator port ${port}..."
        kill "${pid}" 2>/dev/null || true
        sleep 1
        if lsof -t -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null | grep -q "^${pid}$"; then
          echo "Force killing stubborn java process ${pid} on emulator port ${port}..."
          kill -9 "${pid}" 2>/dev/null || true
        fi
      fi
    done
  done
  sleep 1
}

# Check if emulators are running
check_emulators() {
  echo "📡 Checking if Firebase emulators are running..."
  local ok=0

  if curl -s "http://${FIRESTORE_HOST}:${FIRESTORE_PORT}" > /dev/null 2>&1; then
    echo "✓ Firestore emulator is running on port ${FIRESTORE_PORT}"
  else
    echo "✗ Firestore emulator is not running on port ${FIRESTORE_PORT}"
    ok=1
  fi

  if curl -s "http://localhost:${AUTH_PORT}" > /dev/null 2>&1; then
    echo "✓ Auth emulator is responding on port ${AUTH_PORT}"
  else
    echo "✗ Auth emulator is not responding on port ${AUTH_PORT}"
    ok=1
  fi

  return $ok
}

# Start emulators if not running
if ! check_emulators; then
  echo ""
  echo "🔥 Starting Firebase emulators..."
  print_emulator_port_diagnostics
  kill_stale_emulator_port_processes
  print_emulator_port_diagnostics
  (npm run env:functions:local && firebase emulators:start --project "${FIREBASE_PROJECT_ID}" --config "${FIREBASE_CONFIG_PATH}") > "${EMULATOR_LOG_PATH}" 2>&1 &
  EMULATOR_PID=$!
  echo "   Started emulators (PID: $EMULATOR_PID)"
  
  # Wait for emulators to be ready
  echo "   Waiting for emulators to be ready..."
  for i in {1..30}; do
    if check_emulators; then
      break
    fi
    if ! kill -0 "$EMULATOR_PID" 2>/dev/null; then
      echo "❌ Emulator process exited before becoming ready"
      cat "${EMULATOR_LOG_PATH}"
      print_emulator_port_diagnostics
      exit 1
    fi
    if [ $i -eq 30 ]; then
      echo "❌ Emulators failed to start after 30 seconds"
      cat "${EMULATOR_LOG_PATH}"
      print_emulator_port_diagnostics
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

# Default to CI mode to avoid interactive prompts unless explicitly overridden
export CI="${CI:-1}"

# Record test start time
START_TIME_TEST=$(date +%s)
npx playwright test --config=playwright.nonlive.config.ts "$@"
TEST_EXIT_CODE=$?

# Calculate test duration
END_TIME_TEST=$(date +%s)
TEST_DURATION=$((END_TIME_TEST - START_TIME_TEST))

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
