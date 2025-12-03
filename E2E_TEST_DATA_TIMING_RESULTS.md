# E2E Test Data Loading Timing Results

## Overview

This document presents timing comparison results for loading different amounts of test data for e2e tests. The comparison evaluates the tradeoff between using 400 records (current configuration) versus 3700 records (maximum available).

**Note:** The issue requested testing with 4000 records, but the test data contains only 3700 broadcast events, so we used the maximum available.

## Timing Results

### Data Loading Only

| Configuration | Records | Loading Time |
|--------------|---------|--------------|
| Current (400 records) | 400 broadcast + 4 users + 73 dobutsu | **3.01 seconds** |
| Maximum (3700 records) | 3700 broadcast + 4 users + 73 dobutsu | **133.44 seconds** |

### Key Findings

1. **Data Loading Time Difference:** 
   - 400 records: ~3 seconds
   - 3700 records: ~133 seconds
   - **Difference: ~130 seconds (44x slower)**

2. **The significant time increase is due to:**
   - 9.25x more data to load (3700 vs 400 records)
   - Network/emulator overhead for each batch operation
   - Serialization/deserialization of Firestore Timestamp objects

## Evaluation

### Pros of Using 3700 Records
- More comprehensive test coverage with real-world data volume
- Better representation of production state reconstruction
- Tests performance with larger datasets

### Cons of Using 3700 Records
- Significantly slower test setup (~130 seconds additional time)
- May slow down development iteration cycles
- Most e2e tests don't require full historical data

## Recommendation

**Keep the current 400 records configuration** for the following reasons:

1. **Fast iteration:** 3 seconds vs 133 seconds makes a huge difference in developer productivity
2. **Sufficient coverage:** The e2e tests are primarily UI/workflow tests, not data volume tests
3. **Flexibility:** The `--prefix` parameter in `e2e/helpers/load-test-data.js` allows easy adjustment when needed

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
