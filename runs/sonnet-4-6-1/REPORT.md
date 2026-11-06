# Production-Readiness Report

## 1. Changes

### catalog.ts — `discontinue` sets wrong state
- **File:** catalog.ts:13
- **Root cause:** `this.get(id).state = "active"` — copy-paste error, never set to `"discontinued"`.
- **Fix:** Changed to mutate the stored sku directly (`this.bySku.get(id).state = "discontinued"`) while keeping `get()` returning a defensive copy so external callers cannot corrupt internal state through the returned reference.

### catalog.ts — `get` and `add` expose mutable internal references
- **File:** catalog.ts:6–22
- **Root cause:** Both `add` and `get` returned direct references to the internally stored `Sku` object. A caller could write `catalog.get("widget").state = "active"` after `discontinue`, silently resurrecting a discontinued SKU without going through any lifecycle method.
- **Fix:** Both methods now return `{ ...sku }` (shallow copy). The stored object remains the single mutable source of truth; `discontinue` mutates it directly via `this.bySku.get(id)` instead of through `get()`.

### catalog.ts — `add` accepts invalid inputs and allows silent overwrite
- **File:** catalog.ts:6
- **Root cause:** No validation of `id` (could be empty string), `initial` (could be negative or non-integer), or `unitPrice` (could be zero, negative, or non-integer). Calling `add` twice with the same id silently overwrote the existing SKU.
- **Fix:** Guards added: non-empty id, non-negative integer initial, positive integer unitPrice, no-duplicate id.

### inventory.ts — `reserve` is not atomic
- **File:** inventory.ts:16–29
- **Root cause:** The loop pushed each movement before checking the next line. If line N failed (e.g., insufficient stock), lines 0…N-1 were already committed, leaving orphaned reservations in the ledger with no associated completed order. Stock was irrecoverably lost from availability.
- **Fix:** Two-phase approach: validate all lines first (SKU existence, state, qty), compute projected balances across all lines (correctly handles duplicate SKUs within one order), then commit all movements only after every check passes.

### inventory.ts — no guard against discontinued SKUs in `reserve`
- **File:** inventory.ts:18
- **Root cause:** `this.catalog.get(line.sku)` fetched the SKU but never checked its state; discontinued SKUs could have stock reserved against them.
- **Fix:** Check `sku.state === "discontinued"` and throw before any state change.

### inventory.ts — no qty validation in `reserve`
- **File:** inventory.ts:18
- **Root cause:** Zero, negative, or non-integer quantities were silently accepted. A qty of 0 would write a zero movement (harmless but corrupts the ledger semantics). A negative qty would effectively *add* stock (dangerous).
- **Fix:** Require `Number.isInteger(line.qty) && line.qty > 0`.

### inventory.ts — duplicate orderId not prevented
- **File:** inventory.ts:16
- **Root cause:** Calling `reserve("o1", ...)` twice doubled the stock deduction for the same logical order, making it impossible to cancel correctly without over-releasing stock.
- **Fix:** A `reservedOrders: Set<string>` tracks issued orderId values; `reserve` throws if the orderId was already used.

### inventory.ts — `getMovements()` exposes internal array
- **File:** inventory.ts:42
- **Root cause:** The method returned `this.movements` directly. A caller could push, splice, or mutate entries, corrupting the ledger.
- **Fix:** Returns `this.movements.map(m => ({ ...m }))` — a new array of copies.

### inventory.ts — `cancel` and `history` added
- **File:** inventory.ts
- **`cancel(orderId)`:** Finds all negative (reservation) movements for the orderId and appends corresponding positive (return) movements atomically in one pass. Idempotent: a `cancelledOrders: Set<string>` guards against double-cancel. Throws if the orderId was never reserved (distinguishes "already cancelled" from "never existed"). Works regardless of current SKU state (returning stock to a discontinued SKU is correct behaviour).
- **`history(sku, fromSeq, toSeq)`:** Validates the SKU exists, then filters movements by SKU and inclusive seq range. Returns defensive copies.

### orders.ts — `lineValue` uses floating-point arithmetic for integer minor-unit money
- **File:** orders.ts:13
- **Root cause:** `gross - gross * (discountPct / 100)` performs IEEE 754 double arithmetic. For certain combinations (e.g., unitPrice=100, qty=3, discountPct=33 → 300 − 99.00000000000001) the result is not an integer, silently introducing sub-cent fractions in what must be an integer minor-unit (cent) value.
- **Fix:** Integer arithmetic: `const discount = Math.floor((gross * discountPct) / 100); return gross - discount;`. Because `discountPct` is validated as a whole-percent integer and `gross` is integer, `gross * discountPct` is always an exact integer; dividing by 100 is the only source of fractions, which `Math.floor` eliminates. Flooring the discount (rather than the net) follows the convention that fractional cents favour the merchant.

### orders.ts — `lineValue` accepts invalid inputs
- **File:** orders.ts:13
- **Root cause:** No validation of `qty` or `discountPct`; a discountPct > 100 would produce a negative line value.
- **Fix:** Guards: positive integer qty, integer discountPct in [0, 100].

---

## 2. Production-Readiness Review

### Remaining risks the tests do NOT cover

**Arithmetic / money**
- `lineValue` now returns an integer, but there is no test verifying the rounding behaviour for fractional-cent scenarios. The discount rounding mode (floor) is a business policy decision that is currently undocumented in the API contract.
- `unitPrice` being in integer minor units is enforced for new SKUs but there is no migration guard if the Catalog is ever populated from external storage that stored floats.

**Availability calculation is O(n) on all movements**
- `available()` scans the entire movement log each time it is called. `reserve()` calls it once per unique SKU in the order, making it O(lines × total_movements). For long-running systems with large logs this will degrade; a running-balance cache keyed by SKU would be the fix, but adds complexity and a new invariant to maintain.

**No persistence**
- All state is in-memory. A process restart loses all reservations, cancellations, and history. There is no WAL, no snapshot, and no idempotency key store that survives restarts. This is expected for this module's scope but must be understood by callers.

**No concurrency safety**
- JavaScript/Node.js is single-threaded for synchronous code, so within one process there are no races. However, if this module is ever used across worker threads, async boundaries (e.g., if `catalog.get` becomes async), or multiple process instances against shared state, the read-check-write sequences in `reserve` and `cancel` are not safe. Documented as a limitation.

**`cancel` is O(n) on movements**
- It iterates all movements to find the reservation movements for the orderId. A secondary index (`orderId → [movement indices]`) would make this O(k) where k is the number of lines in the order.

**No maximum qty or order-value cap**
- An adversarially large `qty` (e.g., `Number.MAX_SAFE_INTEGER`) passes all guards and would drive `available()` deeply negative if it somehow got past the stock check. In practice the stock check prevents it, but there is no explicit upper-bound guard.

**`history` with inverted range**
- `history(sku, 10, 5)` silently returns an empty array. It could instead throw, which would catch caller bugs. Left as-is since the spec says "inclusive [fromSeq, toSeq]" without specifying error behaviour.

**`cancel` after SKU discontinuation**
- Cancelling a reservation for a discontinued SKU succeeds and returns stock to the ledger. The stock is then available in `available()` even though new orders cannot be placed. This is intentionally correct — the stock physically exists — but callers should be aware that `available() > 0` does not imply new orders can be placed.

### Deliberately not changed

- **`Qty` is `number`, not `bigint`**: Changing this would be a broad breaking change. The current validation (`Number.isInteger`, bounds checks) makes integer misuse detectable at the boundary. Documented as a limitation.
- **`OrderService.place` has no orderId uniqueness guard of its own**: it delegates to `Inventory.reserve` which now enforces it. No additional guard was added to avoid redundancy.
- **No test was added for the `lineValue` float-fix or the new `cancel`/`history` methods**: the task asked to keep the test file structure intact. Gaps are called out above.

---

## 3. Final Test Status

```
 RUN  v4.1.10 <repo>/runs/sonnet-4-6-1

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  16:12:06
   Duration  377ms (transform 63ms, setup 0ms, import 92ms, tests 4ms, environment 0ms)
```

All 5 tests pass. The previously failing test ("discontinue marks the SKU discontinued") now passes.
