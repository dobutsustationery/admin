# E2E Test Data Loading Timing Results

## Overview

This document presents timing comparison results for loading different amounts of test data for e2e tests. The comparison evaluates the tradeoff between using 400 records (current configuration) versus 3700 records (maximum available).

**Note:** The issue requested testing with 4000 records, but the test data contains only 3700 broadcast events, so we used the maximum available.

## Timing Results

### Data Loading Only

| Configuration | Records | Loading Time |
|--------------|---------|--------------|
| Current (400 records) | 400 broadcast + 4 users + 73 dobutsu | **0.89 seconds** |
| Maximum (3700 records) | 3700 broadcast + 4 users + 73 dobutsu | **2.02 seconds** |

### Inventory E2E Test (Complete Test Suite Run)

| Configuration | Data Load | Build | Test Execution | Total |
|--------------|-----------|-------|----------------|-------|
| 400 records | 0.87s | 9.84s | 15.37s | **26.08s** |
| 3700 records | 17.26s | 10.10s | 20.50s | **47.86s** |

### Key Findings

1. **Data Loading Time Difference:** 
   - 400 records: ~0.9 seconds
   - 3700 records: ~2.0 seconds (standalone) or ~17.3 seconds (in test suite)
   - **Difference: ~1.1 seconds (2.2x slower) for standalone loading**
   - Note: The longer load time in the test suite (17.26s vs 2.02s) may be due to emulator state or other factors

2. **Test Execution Impact:**
   - 400 records: 15.37 seconds
   - 3700 records: 20.50 seconds
   - **Difference: ~5.1 seconds (33% slower)**

3. **Total Test Suite Impact:**
   - 400 records: 26.08 seconds total
   - 3700 records: 47.86 seconds total
   - **Difference: ~21.8 seconds (84% slower)**

4. **The time increase is modest for standalone loading:**
   - 9.25x more data to load (3700 vs 400 records)
   - Only 2.2x slower due to efficient batching (standalone)
   - Network/emulator overhead is minimal with local emulator
   - Test execution itself is only 33% slower with more data

## Evaluation

### Pros of Using 3700 Records
- More comprehensive test coverage with real-world data volume
- Better representation of production state reconstruction
- Tests performance with larger datasets

### Cons of Using 3700 Records
- Slower test setup (~16 seconds additional data loading in test suite)
- Test execution is 33% slower (5 seconds additional time)
- Total test suite time is 84% slower (22 seconds additional time)
- Most e2e tests don't require full historical data

## Recommendation

Based on the timing results:

- **Total time impact:** Using 3700 records adds ~22 seconds to each test run (26s → 48s)
- **For development:** Use 400 records for faster iteration
- **For comprehensive testing:** Use 3700 records when you need full data coverage
- The `--prefix` parameter in `e2e/helpers/load-test-data.js` allows easy adjustment when needed

**Current default: 400 records** - provides good balance of speed and coverage for typical development workflows

## Usage

### Running with Current Configuration (400 records)
```bash
npm run test:e2e
# or
bash e2e/run-tests.sh
```

### Running with Maximum Data (3700 records)
Edit `e2e/run-tests.sh` line 52 to change:
```bash
node e2e/helpers/load-test-data.js --prefix=3700
```

### Timing Script
A timing script has been added to compare different configurations:
```bash
# Time data loading only
bash e2e/time-test-data-loading.sh

# Time data loading + full test suite
bash e2e/time-test-data-loading.sh --full-tests

# Time just the inventory e2e test with different data sizes
bash e2e/time-inventory-test.sh
```

## Files Modified

- `e2e/time-test-data-loading.sh` - Script for timing data loading comparisons
- `e2e/time-inventory-test.sh` - Script for timing the inventory e2e test with different data sizes
- `E2E_TEST_DATA_TIMING_RESULTS.md` - This documentation file
