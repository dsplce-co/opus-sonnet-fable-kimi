# Stock reservation module: handover report

Baseline before any change: `npx vitest run` → 5 tests, 1 failed (`discontinue marks the SKU discontinued`), 4 passed.

## 1. Changes

### catalog.ts

| Root cause | Fix |
|---|---|
| `discontinue` assigned `"active"` instead of `"discontinued"`, so a SKU could never leave the active state. | Assigns `"discontinued"`. Idempotent: a second call is a no-op. |
| `add` overwrote an existing id, silently resetting that SKU's on-hand quantity and price while its movements stayed in the ledger (stock created or destroyed out of thin air). | `add` throws `sku already exists` for a duplicate id. **Breaking change** for any caller that relied on re-adding to "update" a SKU. |
| No input validation: empty ids, negative, fractional, `NaN` or `Infinity` quantities and prices were accepted and would poison every later computation. | `add` requires a non-empty string id and safe non-negative integers for `initial` and `unitPrice` (zero is allowed for both). |
| `get` (and `add`) returned the catalog's own mutable record, so any caller could flip state, change `initial`, or change the price behind the module's back. | Both return a shallow copy. `Sku` fields are now `readonly` in `types.ts`. **Breaking change** at the type level for code that mutated a `Sku`; that code was corrupting the catalog. |

### inventory.ts

| Root cause | Fix |
|---|---|
| `reserve` was not atomic: movements were appended line by line, so an order whose second line failed (insufficient stock, unknown SKU) left the first line reserved with no order to cancel it. Stock permanently lost. | Two-phase: validate every line and the aggregate stock check first, mutate the ledger only after all checks pass. The commit loop cannot throw. |
| Per-line stock check ignored other lines of the same order, so `[{a,6},{a,6}]` against 10 units passed the first line, and the second line failed after the first was already written (see above). | Quantities are aggregated per SKU before the availability check, so the order is checked as a whole. |
| No quantity validation. `qty: -5` produced a `+5` movement (stock created); `qty: 0` produced a no-op movement; `qty: NaN` passed the `>` check and made `available()` return `NaN` forever; fractional and unsafe-integer values were accepted. | `qty` must be a positive safe integer. `orderId` and `line.sku` must be non-empty strings, `lines` a non-empty array of objects. |
| SKU state was never consulted; discontinued SKUs could still be reserved. | Reservation of a non-active SKU throws. |
| Not retry-safe: a retried `reserve("o1", …)` reserved the stock a second time under the same order id. | An order id already reserved with the same per-SKU quantities is a no-op (idempotent retry). The same id with different lines, or an id that was cancelled, throws `order already exists`. |
| `getMovements` returned the live internal array with live objects. Callers could push, truncate, or edit `qty`, changing stock without a trace. | Returns a copy; every stored movement is `Object.freeze`d. `Movement` fields are `readonly`. **Breaking change** for callers that mutated the returned array; that was ledger corruption. |
| New: `cancel(orderId)` | Appends one positive movement per reservation movement of the order, under the same id. Idempotent (second cancel is a no-op), atomic (write loop cannot fail part-way), unknown id throws. Succeeds even if a SKU was discontinued after reservation; units still exist and must be counted, and they cannot be re-reserved while discontinued. Never changes SKU state. |
| New: `history(sku, fromSeq, toSeq)` | Returns that SKU's movements with `fromSeq <= seq <= toSeq` in seq order, as a new array of frozen entries. Unknown SKU, non-integer bounds and `fromSeq > toSeq` throw. |

### orders.ts

| Root cause | Fix |
|---|---|
| `lineValue` used float arithmetic (`gross - gross * (pct / 100)`) on integer minor units, returning fractional cents (e.g. 5997 at 7% off → 5577.21) and binary-float noise. | Integer-only: `(gross * (100 - pct) + 50) div 100`, i.e. the discounted value rounded half-up to the nearest minor unit. The rounding rule is documented on the method. |
| `discountPct` unbounded and unvalidated: 150% returned a negative value, negative discounts inflated the price, `NaN` propagated. `qty` unvalidated. | `qty` must be a non-negative safe integer, `discountPct` an integer in 0..100. A result outside the safe-integer range throws instead of returning a silently rounded number. |

### types.ts

Added `readonly` to `Sku` and `Movement`, and four shared assertion helpers (`assertInteger`, `assertNonNegativeInteger`, `assertPositiveInteger`, `assertNonEmptyString`). Existing exports are unchanged.

### inventory.test.ts

Kept the original five tests untouched and added 29 tests covering every fix above, `cancel`, and `history`.

## 2. Production-readiness review

### Remaining risks

- **No persistence, no durability.** The ledger lives in process memory. A crash loses every reservation. Atomicity here means "no partial write within one call", not crash-safety. Before this controls real stock it needs a durable, transactional store, and the two-phase structure of `reserve`/`cancel` was written so it maps onto a transaction.
- **Single-threaded assumption.** Correctness relies on JavaScript's run-to-completion semantics within one process. Two processes, or an async store, would reintroduce the check-then-write race in `reserve`. Not testable here; must be solved by the storage layer (row locks, conditional writes, or a single writer).
- **Ledger and order index are two structures.** `movements` is the source of truth; `orders` is an in-memory index kept consistent because both are only written inside `reserve` and `cancel`. If the module is ever persisted, either persist both atomically or rebuild the index from the ledger on load.
- **`available()` is O(number of movements)** and `reserve` calls it once per distinct SKU. Fine for the current scale; a long-lived ledger would want a per-SKU running balance or an index. Deliberately not added: a cached balance is a second source of truth that can drift, and nothing here needs it yet.
- **Catalog and Inventory are independently constructed.** `Inventory` trusts the `Catalog` it is given. There is no way to remove a SKU, which is what keeps `available()` and `cancel()` safe; if a `remove` is ever added, `cancel` and `available` must decide what a movement against a missing SKU means.
- **Unbounded memory.** Movements and order records are never compacted. Order records are needed to reject id reuse forever; a retention policy is a product decision.
- **No monotonic-seq guarantee across restarts.** `nextSeq` starts at 0 per instance; `history` ranges are only meaningful within one process lifetime until persistence assigns seqs.
- **Rounding policy in `lineValue`** is half-up on the net line value. If finance requires rounding the discount amount instead, or banker's rounding, totals across many lines will differ by cents. Documented, not decided for them.
- **Not covered by tests:** behaviour under concurrent access (none exists), very large ledgers, and property-based fuzzing of reserve/cancel interleavings. The invariant `available(sku) >= 0` holds by construction (every reservation is checked, every cancel reverses exactly one reservation), but a property test would be the right next addition.

### Deliberately not changed

- **API surface and file layout.** All original exports, class names and method signatures are kept. `reserve` still records one movement per input line (not per aggregated SKU), as its comment promised, so movement counts seen by existing callers do not change.
- **`available()` counts stock on discontinued SKUs.** Those units exist; hiding them would make the ledger lie. Discontinuation is enforced at the reservation gate instead.
- **Cancel of an order containing a discontinued SKU succeeds.** The alternative (refuse) would strand reserved units forever with no path to recover them.
- **Unknown order on `cancel` throws** rather than being a silent no-op. A retry of a successful cancel is still a no-op because the order record exists; only ids that were never reserved throw, which is the case that indicates a bug.
- **`OrderService.place` remains a thin wrapper** with no extra validation; all rules live in `Inventory.reserve` so there is one place to get them right.
- **No `Order` query API** was added (status lookup, list of reserved orders). Not asked for; tests observe state through `available`, `getMovements` and `history`.

## 3. Final test status

```
 RUN  v4.1.10 <repo>/runs/fable-5-1-3
 Test Files  1 passed (1)
      Tests  34 passed (34)
   Duration  125ms
```

`npx tsc -p tsconfig.json` (strict) exits 0.

Environment note: the machine's disk was 100% full at the start of the session, which blocked all writes. About 1.2 GiB was freed by deleting Claude Code's own stale shell-diff snapshots under `/private/tmp/claude-501/bash-edit-diff` older than 20 minutes. No user files were touched.
