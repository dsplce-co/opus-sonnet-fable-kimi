# Production Readiness Report

## 1. Changes

### catalog.ts

**Line 13: discontinue() set wrong state**
- **Root cause**: Method set state to "active" instead of "discontinued"
- **Fix**: Changed `this.get(id).state = "active"` to directly access the map and set state to "discontinued"

**Lines 6-22: add() lacked input validation and data protection**
- **Root cause**: No validation of SKU id, initial stock, or unit price; allowed duplicate SKUs; returned mutable reference
- **Fix**: Added validation for non-empty id, non-negative integers for initial and unitPrice, duplicate SKU check, and return defensive copy

**Lines 33-40: get() returned mutable internal state**
- **Root cause**: Returned direct reference to internal Sku object, allowing external code to corrupt catalog data
- **Fix**: Refactored discontinue() to access map directly, then changed get() to return defensive copy

### inventory.ts

**Lines 16-28: reserve() was not atomic**
- **Root cause**: Added movements immediately while checking lines sequentially; failed mid-operation left partial reservations
- **Fix**: Complete two-phase implementation: validate all lines and accumulate demand per SKU, then commit movements only if all checks pass

**Lines 16-28: reserve() didn't handle multiple lines of same SKU**
- **Root cause**: Availability check per line didn't account for cumulative demand within same order
- **Fix**: Accumulate total demand per SKU before checking availability against accumulated totals

**Lines 16-28: reserve() lacked input validation**
- **Root cause**: No checks for positive integer quantities, non-empty orderId, or discontinued SKUs
- **Fix**: Added validation for orderId (non-empty string), quantity (positive integer), and SKU state (reject discontinued)

**Lines 69-72: getMovements() returned mutable array**
- **Root cause**: Returned direct reference to internal movements array
- **Fix**: Return shallow copy using spread operator

**Lines 74-120: Added cancel() method**
- **Root cause**: Missing capability required for production
- **Fix**: Implemented idempotent cancellation that groups reservations and cancellations by SKU, calculates remaining balance, and adds positive movements to return stock

**Lines 122-141: Added history() method**
- **Root cause**: Missing capability required for production
- **Fix**: Implemented range query with validation of bounds and SKU existence, returns defensive copies

### orders.ts

**Lines 13-25: lineValue() used floating-point arithmetic**
- **Root cause**: Expression `gross * (discountPct / 100)` introduced floating-point precision errors in financial calculations
- **Fix**: Rewrote to use integer arithmetic: `Math.floor((gross * discountPct) / 100)`, added input validation for qty and discountPct

## 2. Production-readiness Review

### Data Integrity & Safety Guarantees

**Protected:**
- ✅ Stock cannot go negative (reserve validates availability atomically)
- ✅ Quantities are whole-unit integers (validated in reserve and catalog.add)
- ✅ Financial arithmetic is integer-based (no floating-point precision loss)
- ✅ Internal state protected from external mutation (defensive copies)
- ✅ Multi-SKU orders are atomic (all-or-nothing)
- ✅ Discontinued SKUs cannot be reserved
- ✅ Duplicate SKU ids are rejected
- ✅ cancel() is idempotent (safe to retry)

### Remaining Risks & Limitations

**Concurrency**: Not thread-safe. JavaScript's single-threaded event loop makes this acceptable for Node.js, but if moved to a multi-threaded environment or used with shared state across workers, requires external synchronization.

**Performance**: 
- `available()` is O(n) in movements; scales poorly for high-movement SKUs. Consider caching or maintaining running totals if movements exceed thousands per SKU.
- `history()` scans all movements; no indexing. For large movement logs, consider pagination or indexing by SKU.

**Data Model**:
- Movements are append-only and never pruned. In production, implement archival/compaction after a retention period.
- No transaction log or audit trail beyond movements. Consider adding timestamp, user, or reason fields for compliance.
- No support for partial cancellations (cancel all or nothing per order). If needed, would require tracking which specific movements were canceled.

**Edge Cases Not Validated by Tests**:
- Very large orders (does `nextSeq` overflow? JavaScript numbers are safe up to 2^53-1)
- SKU deletion (not supported; discontinue is the only lifecycle change)
- Concurrent reserve/cancel of same orderId (safe in single-threaded JS, but untested)
- cancel() on non-existent orderId (silently succeeds; this is by design for idempotency)

**API Surface**:
- `getMovements()` exposes the raw movement log. If this is a large dataset, consider pagination.
- No way to query total value of an order post-reservation (would need to store lines or reconstruct from movements)

### Deliberately NOT Changed

**Catalog.get() defensive copy overhead**: Chosen simplicity over optimization. If this becomes a bottleneck (profiling shows it), could introduce separate `getReadonly()` and `getMutable()` (internal only) methods.

**Movement immutability**: Movements are plain objects, not frozen. Could use `Object.freeze()` for additional protection, but not necessary given defensive copies are already returned.

**Empty line arrays**: `reserve()` accepts empty arrays (succeeds with no movements). This is valid behavior (no-op reservation) and supports edge cases.

## 3. Final Test Status

```
 RUN  v4.1.10 <repo>/runs/sonnet-4-5-3

 Test Files  1 passed (1)
      Tests  15 passed (15)
   Start at  16:37:43
   Duration  113ms (transform 31ms, setup 0ms, import 41ms, tests 3ms, environment 0ms)
```

**Test Coverage:**
- Original functionality: 5 tests
- New capabilities (cancel, history): 3 tests  
- Input validation & edge cases: 4 tests
- Data protection (mutation defense): 2 tests
- Atomicity: 1 test

All tests pass. The module is ready for production use within the documented limitations.
