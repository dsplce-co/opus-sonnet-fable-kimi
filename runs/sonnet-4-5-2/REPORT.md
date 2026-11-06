# Production Readiness Report

## 1. Changes

### catalog.ts:13 - discontinue() bug
**Root cause**: Method set state to "active" instead of "discontinued"  
**Fix**: Changed `this.get(id).state = "active"` to `this.get(id).state = "discontinued"`

### catalog.ts:6 - Missing input validation
**Root cause**: No validation for initial quantity and unit price, allowing negative or non-integer values  
**Fix**: Added validation to throw on invalid initial quantities or unit prices (must be non-negative integers)

### catalog.ts:6 - Missing duplicate SKU check
**Root cause**: Calling add() with an existing SKU ID would silently overwrite it, losing data and orphaning movements  
**Fix**: Added check to throw error if SKU already exists

### inventory.ts:16 - reserve() not atomic
**Root cause**: Method validated and recorded movements one line at a time; failure mid-operation left partial movements  
**Fix**: Restructured to validate ALL lines first (accumulating per-SKU demand), then record all movements only if all checks pass

### inventory.ts:16 - Missing quantity validation
**Root cause**: No validation for line quantities, allowing negative, zero, or non-integer values  
**Fix**: Added check to throw on invalid quantities (must be positive integers)

### inventory.ts:16 - Missing SKU lifecycle check
**Root cause**: No check whether SKU is active, allowing reservations of discontinued SKUs  
**Fix**: Added check to throw error if SKU state is not "active"

### inventory.ts:16 - Incorrect multi-line availability check
**Root cause**: When multiple lines reference the same SKU, each line checked availability independently; a 100-unit stock could pass two 60-unit lines because the first check didn't account for the second reservation  
**Fix**: Accumulate total demand per SKU across all lines before checking availability

### inventory.ts:16 - Missing orderId validation
**Root cause**: No validation of orderId parameter  
**Fix**: Added check to throw if orderId is missing or not a string

### inventory.ts:16 - Empty orders allowed
**Root cause**: No check for empty lines array  
**Fix**: Added check to throw on empty orders

### inventory.ts:42 - getMovements() exposes internal state
**Root cause**: Returned direct reference to internal movements array; callers could push/splice to corrupt state  
**Fix**: Return defensive copy (`[...this.movements]`)

### inventory.ts - Added cancel() method
**Implementation**: Finds all reservation movements (qty < 0) for the orderId, validates SKUs still exist, records reversing movements (qty > 0), and tracks canceled orders in a Set for idempotency. Prevents reuse of canceled order IDs in reserve().

### inventory.ts - Added history() method
**Implementation**: Filters movements by SKU and inclusive seq range [fromSeq, toSeq]. Returns a new array (does not expose internal state).

### inventory.ts:24 - Prevent canceled order ID reuse
**Root cause**: Reusing a canceled order ID would be confusing and mix unrelated reservations under one ID  
**Fix**: Added check in reserve() to throw if orderId was previously canceled

### orders.ts:14 - Floating-point arithmetic on money
**Root cause**: Discount calculation used `gross - gross * (discountPct / 100)`, which can produce non-integer minor units due to floating-point division  
**Fix**: Changed to integer arithmetic: `Math.floor(gross * (100 - discountPct) / 100)` to ensure result is always an integer

## 2. Production-readiness review

### Remaining risks

**Concurrent access**: Module has no locking or synchronization. Safe for single-threaded use only. Under concurrent access, availability checks could pass for two callers simultaneously, both recording movements that together exceed available stock. Mitigation: Use external locking or run in single-threaded environment.

**Order ID reuse (non-canceled)**: Code allows calling reserve() multiple times with the same orderId (before cancellation). This creates multiple sets of movements under one ID, which may or may not be intended. Canceled order IDs are blocked from reuse. If order IDs must be globally unique (one reserve() call per ID), add a Set to track all used order IDs, not just canceled ones.

**Unbounded memory growth**: movements array grows indefinitely. Long-running processes will exhaust memory. No archival or compaction strategy. Mitigation: Implement periodic compaction (e.g., collapse movements into checkpointed initial quantities) or external archival.

**Large SKU catalogs**: available() scans all movements on every call; O(movements) per call. For high-volume systems, index movements by SKU. Current implementation trades memory for simplicity.

**Integer overflow**: JavaScript numbers are 64-bit floats, safe for integers up to 2^53-1 (~9 quadrillion). Quantities and prices exceeding this will lose precision. For this domain, risk is negligible.

**Partial SKU deletion**: cancel() validates that all SKUs still exist in catalog before recording cancellations. If a SKU is deleted from catalog (no delete method provided, but Map could be mutated externally), cancel() will throw and no cancellations will be recorded. Movements already in the log reference the deleted SKU, which would cause available() to throw. Mitigation: Never delete SKUs; use discontinue() only.

**Monetary rounding**: lineValue() rounds down. For large orders or unusual discount percentages, rounding could accumulate. This is deliberate (minor units can't be fractional), but business rules should specify rounding direction.

### What was NOT changed

**Movement sequence gaps**: If reserve() fails mid-validation, nextSeq is not incremented; sequences remain contiguous. However, if an unhandled exception occurs during movement recording (e.g., out of memory), nextSeq may advance without recording movements, creating gaps. Accepted risk: catastrophic failures leave gaps.

**cancel() on non-existent orders**: Calling cancel() on an order that was never reserved is a silent no-op. This is intentional for idempotency. If strict validation is required, throw on non-existent orders by checking `reservations.length === 0` differently.

**No audit trail for cancellations**: Cancellation movements share the original orderId. There's no separate "cancel ID" or timestamp. If you need to distinguish multiple cancel attempts or know when a cancel happened, movements need a timestamp field (not added to avoid breaking schema).

**history() edge cases**: 
  - fromSeq > toSeq returns empty array (valid but potentially caller error)
  - Negative sequences are allowed by the method signature but never occur in practice
  - No validation that sku exists in catalog (returns empty array for unknown SKU, which is reasonable for a query)

**No transaction log durability**: All state is in-memory. Process restart loses all movements. For production, persist movements to durable storage (database, append-only log).

## 3. Final test status

```
 RUN  v4.1.10 <repo>/runs/sonnet-4-5-2

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  16:33:11
   Duration  1.01s (transform 275ms, setup 0ms, import 350ms, tests 8ms, environment 0ms)
```

All tests pass. Test coverage includes:
- SKU creation in active state
- SKU discontinuation
- Stock reservation reducing availability
- Initial availability reflection
- Insufficient stock rejection
- Cancellation returning stock to availability
- Cancel idempotency
- Movement history filtering by SKU and seq range
