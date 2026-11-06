# Production-readiness report — stock reservation module

## 1. Changes

### Fix: `discontinue()` set the wrong state
- **File:** `catalog.ts`
- **Root cause:** `discontinue()` assigned `state = "active"` — a plain typo/inverted
  literal. The lifecycle transition was a no-op, so discontinued SKUs stayed
  sellable and the state field was meaningless.
- **Fix:** assign `state = "discontinued"`.

### Fix: `reserve()` was not atomic
- **File:** `inventory.ts`
- **Root cause:** each line was validated and its movement appended inside the
  same loop. A multi-line order that failed on line N (unknown SKU,
  insufficient stock) left lines 1..N-1 reserved — stock leaked with no
  corresponding order.
- **Fix:** two-phase reserve. Phase 1 validates *everything* (orderId, lines,
  quantities, SKU existence + lifecycle, aggregated per-SKU availability).
  Phase 2 appends all movements and records the order. Nothing in phase 2 can
  fail, so a thrown error always leaves zero partial state.

### Fix: duplicate lines for one SKU could over-reserve
- **File:** `inventory.ts`
- **Root cause:** availability was checked per line, so
  `[{sku:"a",qty:6},{sku:"a",qty:6}]` against 10 on-hand passed each check
  individually while reserving 12 — availability went negative.
- **Fix:** demand is aggregated per SKU before the availability check.

### Fix: unvalidated quantities corrupted the ledger
- **File:** `inventory.ts`
- **Root cause:** `line.qty` was trusted. `qty: -5` produced a *positive*
  movement (fabricating stock out of thin air); fractional/NaN/Infinity
  quantities made availability non-integral or NaN forever after.
- **Fix:** every line quantity must be a positive safe integer; `orderId` must
  be a non-empty string; `lines` must be non-empty.

### Fix: `reserve()` was not retry-safe
- **File:** `inventory.ts`
- **Root cause:** no record of which orders had been placed, so retrying a
  timed-out `reserve("o1", ...)` reserved the stock twice.
- **Fix:** an order registry (`orderId -> {lines, cancelled}`). A repeat call
  with the same orderId and identical lines is a no-op; the same orderId with
  different lines, or after a cancel, throws. Sequence numbers are only
  consumed by successful mutations, so failed reserves leave no seq gaps.

### Fix: callers could corrupt internal state
- **File:** `inventory.ts`
- **Root cause:** `getMovements()` returned the live ledger array by reference;
  any caller could `push`/`splice`/edit movements and change availability
  retroactively.
- **Fix:** `getMovements()` and the new `history()` return per-object copies.

### Fix: `lineValue()` returned fractional minor units
- **File:** `orders.ts`
- **Root cause:** `gross - gross * (discountPct / 100)` is binary floating
  point arithmetic — e.g. 999 @ 33% yielded 669.33 "cents", unpayable and
  un-reconcilable.
- **Fix:** the discount is computed as `Math.round(gross * pct / 100)` (nearest
  minor unit, half up) and the result is always an exact integer.
  `discountPct` is validated to [0, 100] (NaN rejected) and `qty` to a
  positive integer.

### Fix: `Catalog.add()` accepted anything and silently overwrote
- **File:** `catalog.ts`
- **Root cause:** no validation, and re-adding an existing id silently reset
  its `initial` on-hand — a data-integrity hazard (availability is computed
  as `initial + movements`, so rewriting `initial` rewrites reality).
- **Fix:** reject empty ids, negative/fractional `initial` and `unitPrice`,
  and duplicate ids.

### New capability: `cancel(orderId)`
- **File:** `inventory.ts`
- Returns all stock an order reserved, per SKU, as positive movements.
  Atomic (returns computed fully before any append), idempotent (second call
  is a no-op), throws for never-reserved orders, works for discontinued SKUs
  (stock must come back even when the SKU can no longer be sold), and a
  cancelled orderId can never be reserved again.

### New capability: `history(sku, fromSeq, toSeq)`
- **File:** `inventory.ts`
- Returns copies of that SKU's movements with `seq` in the inclusive range;
  empty array for empty or inverted ranges; throws for unknown SKUs
  (consistent with `available()`).

### Tests
- **File:** `inventory.test.ts` — 20 tests added (25 total): reserve atomicity,
  seq-gap-freedom after failure, qty validation, combined duplicate-line
  demand, discontinued-reserve rejection, reserve idempotency/conflict,
  cancel (restore, multi-line, idempotency, unknown order, discontinued SKU),
  history (inclusive range, copies, unknown SKU), ledger-copy integrity,
  lineValue rounding and validation, catalog validation. Original 5 tests
  unchanged.

### Deliberate behavior changes (call-outs)
1. **Reserving a discontinued SKU now throws.** Previously allowed. This is
   the only sane reading of a SKU lifecycle, but if a caller relied on
   selling discontinued stock, it breaks them.
2. **Duplicate `Catalog.add(id, ...)` now throws** instead of silently
   replacing the SKU.
3. **`reserve()` with an empty `lines` array now throws** instead of being a
   no-op success.
4. **Retrying `reserve()` with the same orderId and different lines now
   throws** instead of double-reserving.
5. **`lineValue()` rounds the discount half-up to the nearest minor unit** —
   results can differ by one minor unit from the old float truncation, and
   invalid `discountPct`/`qty` now throw.

## 2. Production-readiness review

**Remaining risks / limitations (honest list):**
- **In-memory only.** All state (ledger, order registry, catalog) is lost on
  process restart, and there is no persistence, snapshotting, or replay
  mechanism. As-is this cannot be the system of record for real warehouse
  stock without a storage layer behind it.
- **Single-process, single-threaded assumption.** Atomicity holds because
  JavaScript runs each method to completion. Two *instances* of this class
  sharing one physical stock pool (e.g. scaled-out services) would need an
  external concurrency/locking story — not provided.
- **`available()` and `history()` are O(ledger size)** per call. Fine at this
  scale; a long-lived process with millions of movements would want a
  per-SKU running balance cache.
- **Unbounded growth.** The movements array and order registry grow forever;
  there is no compaction/archival.
- **No "shipment" or "adjustment" movement types.** Stock can leave via
  reservation and return via cancel, but there is no way to record a
  fulfilled shipment removing stock permanently, a stocktake correction, or
  a receiving event — real warehouses need these.
- **`cancel` semantics are all-or-nothing per order.** Partial cancels
  (return 2 of 5 units) are not supported.
- **`OrderService.place()` does no validation of its own** — it relies on
  `reserve()`'s. Acceptable layering, but worth knowing.
- **Rounding policy for `lineValue` is a business decision** (half-up on the
  discount). Finance should confirm it matches their invoicing.
- **Not covered by tests:** multi-Inventory-instance interaction, behavior
  under extremely large ledgers, `Number.MAX_SAFE_INTEGER`-boundary
  quantities, and `OrderService.place` pass-through of every invalid-input
  class (covered indirectly via `reserve`).

**Deliberately NOT changed, and why:**
- **`available()` derives state by replaying the ledger** rather than keeping
  a mutable balance. Kept: the ledger is the single source of truth and this
  makes balances auditable and self-healing; the performance cost is
  documented above.
- **`discontinue()` is irreversible** (no `reactivate()`). Kept: adding a
  reverse transition is a product decision, not a bug fix.
- **`Catalog.get()` returning the live `Sku` object.** Callers can mutate
  `state`/`initial` on the returned object. I left this because `add()`'s
  contract returns the SKU and existing tests rely on reading it; fixing it
  (returning copies) is cheap but changes the feel of the API — flagged here
  as the next hardening step rather than silently done.
- **`history()` throwing on unknown SKU** vs returning `[]`. Chose throw for
  consistency with `available()`; an empty list would hide caller typos.

## 3. Final test status

```
 Test Files  1 passed (1)
      Tests  25 passed (25)
   Duration  ~350ms
```

`npx tsc --noEmit` (strict mode) also passes with no errors.
