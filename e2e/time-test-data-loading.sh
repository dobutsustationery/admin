#!/bin/bash

# E2E Test Data Loading Timing Script
# This script measures the time it takes to load different amounts of test data
# and optionally run the full e2e test suite with each configuration

set -e  # Exit on error

# Output file for results
RESULTS_FILE="/tmp/e2e-timing-results.txt"
echo "🕐 E2E Test Data Loading Timer" | tee "$RESULTS_FILE"
echo "==============================" | tee -a "$RESULTS_FILE"
echo "" | tee -a "$RESULTS_FILE"

# Parse command line arguments
RUN_FULL_TESTS=false
if [ "$1" == "--full-tests" ]; then
  RUN_FULL_TESTS=true
  echo "ℹ️  Will run full e2e test suite with each configuration" | tee -a "$RESULTS_FILE"
  echo "" | tee -a "$RESULTS_FILE"
fi

# Check if emulators are running
check_emulators() {
  if curl -s http://localhost:8080 > /dev/null 2>&1; then
    return 0
  else
    return 1
  fi
}

# Start emulators if not running
EMULATOR_PID=""
if ! check_emulators; then
  echo "🔥 Starting Firebase emulators..."
  npm run emulators > /tmp/emulators.log 2>&1 &
  EMULATOR_PID=$!
  echo "   Started emulators (PID: $EMULATOR_PID)"
  
  # Wait for emulators to be ready
  echo "   Waiting for emulators to be ready..."
  for i in {1..30}; do
    if check_emulators; then
      echo "   ✓ Emulators ready"
      break
    fi
    if [ $i -eq 30 ]; then
      echo "❌ Emulators failed to start after 30 seconds"
      cat /tmp/emulators.log
      exit 1
    fi
    sleep 1
  done
else
  echo "✓ Firebase emulators already running"
fi

echo ""

# Function to time data loading and optionally run tests
time_configuration() {
  local MATCH_JANCODES=$1
  local DESCRIPTION=$2
  
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$RESULTS_FILE"
  echo "📊 Testing with: $DESCRIPTION" | tee -a "$RESULTS_FILE"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$RESULTS_FILE"
  echo "" | tee -a "$RESULTS_FILE"
  
  # Clear emulator data
  echo "🧹 Clearing emulator data..."
  curl -X DELETE "http://localhost:8080/emulator/v1/projects/demo-test-project/databases/(default)/documents" \
    -H "Content-Type: application/json" \
    > /dev/null 2>&1 || true
  
  # Time data loading
  if [ -z "$MATCH_JANCODES" ]; then
    echo "📦 Loading all test data..." | tee -a "$RESULTS_FILE"
    LOAD_START=$(date +%s.%N)
    node e2e/helpers/load-test-data.js 2>&1 | tee -a "$RESULTS_FILE"
    LOAD_END=$(date +%s.%N)
  else
    echo "📦 Loading test data with --match-jancodes=$MATCH_JANCODES..." | tee -a "$RESULTS_FILE"
    LOAD_START=$(date +%s.%N)
    node e2e/helpers/load-test-data.js --match-jancodes=$MATCH_JANCODES 2>&1 | tee -a "$RESULTS_FILE"
    LOAD_END=$(date +%s.%N)
  fi
  LOAD_TIME=$(echo "$LOAD_END - $LOAD_START" | bc)
  
  echo "" | tee -a "$RESULTS_FILE"
  echo "⏱️  Data loading time: ${LOAD_TIME}s" | tee -a "$RESULTS_FILE"
  
  if [ "$RUN_FULL_TESTS" = true ]; then
    echo "" | tee -a "$RESULTS_FILE"
    echo "🏗️  Building application for emulator mode..." | tee -a "$RESULTS_FILE"
    BUILD_START=$(date +%s.%N)
    npm run build:local > /dev/null 2>&1
    BUILD_END=$(date +%s.%N)
    BUILD_TIME=$(echo "$BUILD_END - $BUILD_START" | bc)
    echo "⏱️  Build time: ${BUILD_TIME}s" | tee -a "$RESULTS_FILE"
    
    echo "" | tee -a "$RESULTS_FILE"
    echo "▶️  Running Playwright tests..." | tee -a "$RESULTS_FILE"
    TEST_START=$(date +%s.%N)
    npx playwright test 2>&1 | tail -20
    TEST_EXIT=$?
    TEST_END=$(date +%s.%N)
    TEST_TIME=$(echo "$TEST_END - $TEST_START" | bc)
    
    echo "" | tee -a "$RESULTS_FILE"
    echo "⏱️  Test execution time: ${TEST_TIME}s" | tee -a "$RESULTS_FILE"
    
    TOTAL_TIME=$(echo "$LOAD_TIME + $BUILD_TIME + $TEST_TIME" | bc)
    echo "⏱️  Total time: ${TOTAL_TIME}s" | tee -a "$RESULTS_FILE"
    
    if [ $TEST_EXIT -ne 0 ]; then
      echo "" | tee -a "$RESULTS_FILE"
      echo "❌ Tests failed with exit code: $TEST_EXIT" | tee -a "$RESULTS_FILE"
    else
      echo "" | tee -a "$RESULTS_FILE"
      echo "✅ All tests passed" | tee -a "$RESULTS_FILE"
    fi
  fi
  
  echo "" | tee -a "$RESULTS_FILE"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$RESULTS_FILE"
  echo "" | tee -a "$RESULTS_FILE"
}

# Test with 10 JAN codes (current configuration)
time_configuration 10 "First 10 JAN codes (current)"

echo ""
echo "⏸️  Pausing 5 seconds before next test..."
sleep 5
echo ""

# Test with all records (no filtering)
time_configuration "" "All broadcast events (no filtering)"

# Summary
echo "" | tee -a "$RESULTS_FILE"
echo "📈 SUMMARY" | tee -a "$RESULTS_FILE"
echo "==========" | tee -a "$RESULTS_FILE"
echo "This timing comparison helps evaluate the tradeoff between:" | tee -a "$RESULTS_FILE"
echo "  • Faster test setup with --match-jancodes=10" | tee -a "$RESULTS_FILE"
echo "  • More comprehensive testing with all records" | tee -a "$RESULTS_FILE"
echo "" | tee -a "$RESULTS_FILE"

# Clean up if we started the emulators
if [ ! -z "$EMULATOR_PID" ]; then
  echo "🧹 Stopping emulators..." | tee -a "$RESULTS_FILE"
  kill $EMULATOR_PID 2>/dev/null || true
  echo "" | tee -a "$RESULTS_FILE"
fi

echo "✅ Timing comparison complete" | tee -a "$RESULTS_FILE"
echo "" | tee -a "$RESULTS_FILE"
echo "📄 Full results saved to: $RESULTS_FILE" | tee -a "$RESULTS_FILE"
