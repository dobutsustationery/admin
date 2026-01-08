# E2E Test Data Loading Timing Results

## Overview

This document presents timing comparison results for loading different amounts of test data for e2e tests. The comparison evaluates the tradeoff between using the --match-jancodes approach (current configuration) versus loading all records.

## Timing Results

### Data Loading Only

| Configuration | Records | Loading Time |
|--------------|---------|--------------|
| Current (--match-jancodes=10) | ~200-300 broadcast (matching 10 JAN codes) + 4 users + 73 dobutsu | **0.5-0.8 seconds** |
| All records | All broadcast + 4 users + 73 dobutsu | **2.0-3.0 seconds** |

**Note:** Data loading times can vary significantly depending on emulator state and system load. Fresh emulator restart shows consistent ~2-3 second load times for all records.

### Inventory E2E Test (Complete Test Suite Run)

| Configuration | Data Load | Build | Test Execution | Total |
|--------------|-----------|-------|----------------|-------|
| --match-jancodes=10 | 0.5-0.8s | 10.11s | 16.99s | **~28s** |
| All records | 2-3s | 10.27s | 18.95s | **~32s** |

**Note:** With fresh emulator, load times are consistently 2-3 seconds for all records.

### Key Findings

1. **Data Loading Time (Fresh Emulator):** 
   - --match-jancodes=10: ~0.5-0.8 seconds
   - All records: ~2-3 seconds
   - **Difference: ~2 seconds**

2. **Emulator Performance Degradation:**
   - Fresh emulator: 2-3 seconds for all records
   - After heavy use: 15-18 seconds for all records
   - **Root cause identified:** Emulator performance degrades significantly with repeated use

3. **Test Execution Impact:**
   - --match-jancodes=10: ~17 seconds
   - All records: ~19 seconds
   - **Difference: ~2 seconds (11% slower)**

4. **Total Test Suite Impact (with fresh emulator):**
   - --match-jancodes=10: ~28 seconds total
   - All records: ~32 seconds total
   - **Difference: ~4 seconds (14% slower)**

## Evaluation

### Pros of Using --match-jancodes=10
- Fast test setup (~0.5-0.8 seconds data loading)
- Loads complete data for first 10 items (all related actions)
- Provides good test coverage with minimal overhead
- Recommended for typical E2E testing and development

### Cons of Using --match-jancodes=10
- Limited to data for first 10 items
- May miss edge cases in rarely-accessed items

### Pros of Loading All Records
- Complete test coverage with real-world data volume
- Better representation of production state reconstruction
- Tests performance with larger datasets

### Cons of Loading All Records
- Slower test setup (~2-3 seconds additional data loading)
- Test execution is ~11% slower (~2 seconds additional time)
- Total test suite time is ~14% slower (~4 seconds additional with fresh emulator)
- Emulator performance can degrade with heavy use, causing much slower load times

## Recommendation

Based on the timing results, **the default uses --match-jancodes=10**:

- **Total time impact:** Using --match-jancodes=10 is ~4 seconds faster than loading all records (28s vs 32s)
- **Benefits:** Fast iteration with focused test data that includes complete coverage for first 10 items
- **Tradeoff:** Slightly less comprehensive than loading all data, but much faster for development
- **Important:** Restart emulators periodically to avoid performance degradation

**Current default: --match-jancodes=10** - provides good test coverage with optimal performance

## Usage

### Running with Current Configuration (--match-jancodes=10)
```bash
npm run test:e2e
# or
bash e2e/run-tests.sh
```

### Running with All Data (for comprehensive testing)
Edit the test loading command to remove the flag:
```bash
node e2e/helpers/load-test-data.js  # No flag = load all data
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
