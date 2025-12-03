#!/bin/bash

# E2E Inventory Test Timing Script
# This script measures the time it takes to run the inventory e2e test
# with different amounts of test data

set -e  # Exit on error

# Output file for results
RESULTS_FILE="/tmp/e2e-inventory-timing-results.txt"
echo "🕐 E2E Inventory Test Timer" | tee "$RESULTS_FILE"
echo "=============================" | tee -a "$RESULTS_FILE"
echo "" | tee -a "$RESULTS_FILE"

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
  echo "🔥 Starting Firebase emulators..." | tee -a "$RESULTS_FILE"
  npm run emulators > /tmp/emulators.log 2>&1 &
  EMULATOR_PID=$!
  echo "   Started emulators (PID: $EMULATOR_PID)" | tee -a "$RESULTS_FILE"
  
  # Wait for emulators to be ready
  echo "   Waiting for emulators to be ready..." | tee -a "$RESULTS_FILE"
  for i in {1..30}; do
    if check_emulators; then
      echo "   ✓ Emulators ready" | tee -a "$RESULTS_FILE"
      break
    fi
    if [ $i -eq 30 ]; then
      echo "❌ Emulators failed to start after 30 seconds" | tee -a "$RESULTS_FILE"
      cat /tmp/emulators.log
      exit 1
    fi
    sleep 1
  done
else
  echo "✓ Firebase emulators already running" | tee -a "$RESULTS_FILE"
fi

echo "" | tee -a "$RESULTS_FILE"

# Function to time inventory test with specific data configuration
time_inventory_test() {
  local PREFIX=$1
  local DESCRIPTION=$2
  
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$RESULTS_FILE"
  echo "📊 Testing with: $DESCRIPTION" | tee -a "$RESULTS_FILE"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$RESULTS_FILE"
  echo "" | tee -a "$RESULTS_FILE"
  
  # Clear emulator data
  echo "🧹 Clearing emulator data..." | tee -a "$RESULTS_FILE"
  curl -X DELETE "http://localhost:8080/emulator/v1/projects/demo-test-project/databases/(default)/documents" \
    -H "Content-Type: application/json" \
    > /dev/null 2>&1 || true
  
  # Time data loading
  echo "📦 Loading test data with --prefix=$PREFIX..." | tee -a "$RESULTS_FILE"
  LOAD_START=$(date +%s.%N)
  node e2e/helpers/load-test-data.js --prefix=$PREFIX > /dev/null 2>&1
  LOAD_END=$(date +%s.%N)
  LOAD_TIME=$(echo "$LOAD_END - $LOAD_START" | bc)
  echo "⏱️  Data loading time: ${LOAD_TIME}s" | tee -a "$RESULTS_FILE"
  
  # Build application
  echo "" | tee -a "$RESULTS_FILE"
  echo "🏗️  Building application for emulator mode..." | tee -a "$RESULTS_FILE"
  BUILD_START=$(date +%s.%N)
  npm run build:local > /dev/null 2>&1
  BUILD_END=$(date +%s.%N)
  BUILD_TIME=$(echo "$BUILD_END - $BUILD_START" | bc)
  echo "⏱️  Build time: ${BUILD_TIME}s" | tee -a "$RESULTS_FILE"
  
  # Run only the inventory test
  echo "" | tee -a "$RESULTS_FILE"
  echo "▶️  Running inventory e2e test..." | tee -a "$RESULTS_FILE"
  TEST_START=$(date +%s.%N)
  npx playwright test e2e/000-inventory/000-inventory.spec.ts 2>&1 | tee -a /tmp/test-output.txt | tail -20
  TEST_EXIT=$?
  TEST_END=$(date +%s.%N)
  TEST_TIME=$(echo "$TEST_END - $TEST_START" | bc)
  
  echo "" | tee -a "$RESULTS_FILE"
  echo "⏱️  Test execution time: ${TEST_TIME}s" | tee -a "$RESULTS_FILE"
  
  TOTAL_TIME=$(echo "$LOAD_TIME + $BUILD_TIME + $TEST_TIME" | bc)
  echo "⏱️  Total time: ${TOTAL_TIME}s" | tee -a "$RESULTS_FILE"
  
  if [ $TEST_EXIT -ne 0 ]; then
    echo "" | tee -a "$RESULTS_FILE"
    echo "❌ Test failed with exit code: $TEST_EXIT" | tee -a "$RESULTS_FILE"
  else
    echo "" | tee -a "$RESULTS_FILE"
    echo "✅ Test passed" | tee -a "$RESULTS_FILE"
  fi
  
  echo "" | tee -a "$RESULTS_FILE"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$RESULTS_FILE"
  echo "" | tee -a "$RESULTS_FILE"
}

# Test with 400 records (current configuration)
time_inventory_test 400 "First 400 broadcast events (current)"

echo "" | tee -a "$RESULTS_FILE"
echo "⏸️  Pausing 5 seconds before next test..." | tee -a "$RESULTS_FILE"
sleep 5
echo "" | tee -a "$RESULTS_FILE"

# Test with 3700 records (maximum available)
time_inventory_test 3700 "All 3700 broadcast events (maximum available)"

# Summary
echo "" | tee -a "$RESULTS_FILE"
echo "📈 SUMMARY" | tee -a "$RESULTS_FILE"
echo "==========" | tee -a "$RESULTS_FILE"
echo "This timing comparison shows the impact of data volume on the inventory e2e test." | tee -a "$RESULTS_FILE"
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
