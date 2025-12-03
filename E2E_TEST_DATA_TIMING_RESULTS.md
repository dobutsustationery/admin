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

### Key Findings

1. **Data Loading Time Difference:** 
   - 400 records: ~0.9 seconds
   - 3700 records: ~2.0 seconds
   - **Difference: ~1.1 seconds (2.2x slower)**

2. **The time increase is very modest:**
   - 9.25x more data to load (3700 vs 400 records)
   - Only 2.2x slower due to efficient batching
   - Network/emulator overhead is minimal with local emulator

## Evaluation

### Pros of Using 3700 Records
- More comprehensive test coverage with real-world data volume
- Better representation of production state reconstruction
- Tests performance with larger datasets

### Cons of Using 3700 Records
- Slightly slower test setup (~1 second additional time)
- Minimal impact on development iteration cycles
- Most e2e tests don't require full historical data

## Recommendation

The timing difference is **very minimal** (~1 second), so either configuration is acceptable:

- **Use 400 records** for slightly faster iteration during active development
- **Use 3700 records** when you need more comprehensive data coverage
- The `--prefix` parameter in `e2e/helpers/load-test-data.js` allows easy adjustment when needed

**Current default: 400 records** - provides good balance of speed and coverage

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
```

## Files Modified

- `e2e/time-test-data-loading.sh` - New script for timing comparisons
- `E2E_TEST_DATA_TIMING_RESULTS.md` - This documentation file
