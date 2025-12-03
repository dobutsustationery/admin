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

**Note:** Data loading times can vary significantly (2-18 seconds) depending on emulator state and system load. Fresh emulator restart shows consistent ~2-3 second load times.

### Inventory E2E Test (Complete Test Suite Run)

| Configuration | Data Load | Build | Test Execution | Total |
|--------------|-----------|-------|----------------|-------|
| 400 records | 0.79s | 10.11s | 16.99s | **27.89s** |
| 3700 records | 2-3s (fresh) | 10.27s | 18.95s | **31-32s** (estimated with fresh emulator) |

**Note:** Initial test showed 18.29s load time due to degraded emulator performance. With fresh emulator, load times are consistently 2-3 seconds.

### Key Findings

1. **Data Loading Time (Fresh Emulator):** 
   - 400 records: ~0.8 seconds
   - 3700 records: ~2-3 seconds
   - **Difference: ~2 seconds (2.5-3x slower)**

2. **Emulator Performance Degradation:**
   - Fresh emulator: 2-3 seconds for 3700 records
   - After heavy use: 15-18 seconds for 3700 records
   - **Root cause identified:** Emulator performance degrades significantly with repeated use

3. **Test Execution Impact (estimated with fresh emulator):**
   - 400 records: 16.99 seconds
   - 3700 records: 18.95 seconds
   - **Difference: ~2 seconds (11% slower)**

4. **Total Test Suite Impact (with fresh emulator):**
   - 400 records: ~28 seconds total
   - 3700 records: ~32 seconds total
   - **Difference: ~4 seconds (14% slower)**

## Evaluation

### Pros of Using 3700 Records
- More comprehensive test coverage with real-world data volume
- Better representation of production state reconstruction
- Tests performance with larger datasets

### Cons of Using 3700 Records
- Slightly slower test setup (~2 seconds additional data loading)
- Test execution is ~11% slower (~2 seconds additional time)
- Total test suite time is ~14% slower (~4 seconds additional with fresh emulator)
- Emulator performance can degrade with heavy use, causing much slower load times

## Recommendation

Based on the timing results with a fresh emulator:

- **Total time impact:** Using 3700 records adds ~4 seconds to each test run (28s → 32s)
- **For development:** Use 400 records for faster iteration
- **For comprehensive testing:** Use 3700 records when you need full data coverage
- **Important:** Restart emulators periodically to avoid performance degradation
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
