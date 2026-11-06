# Report: stock-reservation module hardening

## 1. Changes

### `catalog.ts` — `discontinue()` set the wrong state
- **Root cause:** `discontinue(id)` assigned `state = "active"`, so a discontinued SKU never actually became discontinued (caught by the existing failing test).
- **Fix:** assign `state = "discontinued"`.

### `catalog.ts` — no input validation on `add()`
- **Root cause:** `add()` accepted anything: a duplicate id silently overwrote the existing SKU (wiping its on-hand quantity and price while movements referencing it remained), negative or fractional `initial`/`unitPrice` corrupted all downstream quantity and money arithmetic.
- **Fix:** reject empty/non-string ids, duplicate ids, non-integer or negative `initial`, and non-integer or negative `unitPrice` (minor units are integers by definition).

### `catalog.ts` — `get()` leaked mutable internal state
- **Root cause:** `get()` returned the live `Sku` object, so any caller could do `catalog.get("x").state = "active"` or rewrite `initial`/`unitPrice` underneath the inventory.
- **Fix:** `get()` (and `add()`) return shallow copies; a private `mustGet()` serves internal mutation (`discontinue`). Shallow is sufficient because `Sku` is flat.

### `inventory.ts` — `reserve()` was not atomic
- **Root cause:** movements were pushed one line at a time inside the validation loop; a multi-line order that failed on line N left lines 1..N-1 reserved — stock lost to an order that "didn't happen".
- **Fix:** validate every line (existence, lifecycle, aggregated availability) before pushing any movement.

### `inventory.ts` — no quantity validation (stock creation bug)
- **Root cause:** a negative `qty` passed the `qty > available` check and pushed a *positive* movement, manufacturing stock out of thin air; zero and fractional quantities were likewise accepted.
- **Fix:** every line's `qty` must be a positive integer; duplicate SKUs within one order are merged into a single aggregated line before the availability check.

### `inventory.ts` — `reserve()` was not retry-safe
- **Root cause:** no record of placed orders, so a client retry after a timeout double-reserved stock.
- **Fix:** orders are recorded (`Map<orderId, {lines, status}>`). Re-reserving the same orderId with identical lines is a no-op; the same orderId with different lines throws. Empty `orderId` is rejected.

### `inventory.ts` — discontinued SKUs could still be reserved
- **Root cause:** `reserve()` never consulted `Sku.state`.
- **Fix:** reserving a discontinued SKU throws. **Breaking change, called out explicitly:** callers that relied on reserving discontinued stock will now get an error. This is the correct semantics for a lifecycle state that otherwise means nothing; `cancel()` on such orders remains allowed (returning stock is always safe).

### `inventory.ts` — `getMovements()` leaked the mutable log
- **Root cause:** returned the live internal array; callers could splice history or rewrite quantities and corrupt availability.
- **Fix:** returns per-element copies.

### `inventory.ts` — new capabilities
- **`cancel(orderId)`:** returns exactly the lines recorded at reserve time as positive movements, then marks the order cancelled. Atomic (the lines were validated at reserve time, so the append cannot fail part-way), idempotent (second call is a no-op), throws on unknown orderId, and works on discontinued SKUs.
- **`history(sku, fromSeq, toSeq)`:** returns copies of that SKU's movements with `seq` in the inclusive range; rejects inverted or non-integer ranges.

### `orders.ts` — `lineValue()` returned fractional money
- **Root cause:** `gross - gross * (discountPct / 100)` produces fractional minor units (e.g. 999¢ at 15% → 849.15), which cannot be charged and breaks integer-money downstream arithmetic. `qty`/`discountPct` were unvalidated (negative discounts inflate value, >100% makes it negative, NaN poisons everything).
- **Fix:** compute `Math.round(gross * (100 - discountPct) / 100)` — the discounted total rounded half-up to the nearest minor unit, documented in the comment. Validate `qty` (non-negative integer) and `discountPct` (finite, in [0, 100]).

### `inventory.test.ts` — test coverage
- Added 19 tests: catalog validation and copy-on-read, reserve atomicity/validation/idempotency/lifecycle, `getMovements` copy semantics, all `cancel` and `history` behaviors, and `lineValue` rounding/validation.

## 2. Production-readiness review

Remaining risks and deliberate non-changes:

- **Persistence (biggest gap, out of scope by design).** All state is in-memory. A process restart loses the movement log and order records, and `seq` restarts at 0 — idempotency keys (orderIds) from before the restart would be re-accepted. Before real warehouse use, movements must be an append-only durable log (e.g. Postgres table with a uniqueness constraint on `orderId, sku` and transactional insert). The in-memory model here is correct *given* that boundary, but it is a library, not a service.
- **Concurrency.** JavaScript's single-threaded event loop makes each method atomic with respect to other synchronous code in the same process. There is no protection across processes or instances sharing one warehouse; that requires the database to enforce availability (e.g. conditional update / `SELECT ... FOR UPDATE`). Not testable at this layer and not covered by tests.
- **`available()` is O(total movements)** and `history()`/`getMovements()` copy the log. Fine at this scale; at high movement volume a per-SKU running balance and indexed log would be needed. Deliberately not optimized — correctness of the simple sum is easier to audit.
- **Unbounded growth.** `movements` and `orders` grow forever; no compaction/archival. Documented limitation.
- **Cancel semantics.** `cancel` restores stock even if the SKU was later discontinued (returns are always safe; discontinued blocks *new* reservations only). Cancelling an order that was reserved with zero lines is a harmless no-op that marks it cancelled. Unknown orderIds throw rather than no-op, so caller bugs surface.
- **Monetary rounding.** One rounding mode (half-up on the discounted line total) is chosen and documented; real money code must fix a rounding policy with finance (per-line vs per-order, tax interaction) — a policy decision, not something to invent here.
- **Shallow copies.** `get`/`getMovements`/`history` return shallow copies; sufficient because `Sku` and `Movement` are flat records of primitives.
- **What I deliberately did NOT change:** the file/export structure, class names, method signatures of existing public APIs, the existing tests (all preserved verbatim), and the append-only signed-movement model (negative = reserve, positive = cancel), which the new `cancel` follows. `OrderService.place` gained no validation of its own — it delegates to `reserve`, which now enforces everything; duplicated checks would just drift apart.

## 3. Final test status

```
npx vitest run
 Test Files  1 passed (1)
      Tests  24 passed (24)
```

`npx tsc --noEmit` (strict, via project tsconfig) also passes clean.
