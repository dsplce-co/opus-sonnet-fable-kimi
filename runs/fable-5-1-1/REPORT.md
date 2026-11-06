# Stock reservation module: handover report

All work was done incrementally, one logical change at a time, running
`npx vitest run` (and `npx tsc -p tsconfig.json`) after each step. The suite grew
from 5 tests (1 failing) to 46 tests (all passing). File and export structure is
unchanged: `types.ts`, `catalog.ts`, `inventory.ts`, `orders.ts`,
`inventory.test.ts`, with the same exported class names.

## 1. Changes

### catalog.ts

| # | Root cause | Fix |
|---|------------|-----|
| 1 | `discontinue` assigned `"active"` instead of `"discontinued"`, so the SKU lifecycle never actually took effect (the shipped test for it failed). | Assign `"discontinued"`. `discontinue` is idempotent and throws on an unknown SKU. |
| 2 | `add` silently overwrote an existing SKU, resetting its on-hand quantity underneath live reservations (stock duplicated). | `add` throws `sku already exists` on a duplicate id. **Breaking change**: callers that relied on re-adding to "update" a SKU will now get an error. |
| 3 | `add` accepted any values: negative, fractional, `NaN` or `Infinity` for `initial` / `unitPrice`, and an empty id. `NaN` would have poisoned every later availability calculation. | `initial` and `unitPrice` must be non-negative safe integers, `id` a non-empty string (validators in `types.ts`). Nothing is stored when validation fails. |
| 4 | `add` and `get` returned the catalog's internal mutable object, so any caller could set `state`, `initial` or `unitPrice` and corrupt stock accounting. | Both return a snapshot (`{ ...sku }`). Internal mutation goes through a private `lookup`. `Sku` fields are `readonly` in `types.ts`. |

### types.ts

| # | Root cause | Fix |
|---|------------|-----|
| 5 | `Sku` and `Movement` were mutable types, which advertised that leaked objects could be edited. | All fields `readonly`. Added shared `assertInteger` / `assertId` validators used by every module so the rules are defined once. |

### inventory.ts

| # | Root cause | Fix |
|---|------------|-----|
| 6 | `reserve` was not atomic: it pushed one movement per line as it went, so a later line failing (insufficient stock, unknown SKU) left the earlier lines reserved with no order to cancel them. Stock lost. | Validate every line and every per-SKU total first; only then append movements. The commit loop cannot throw, so an order lands whole or not at all. |
| 7 | `reserve` ignored SKU lifecycle: discontinued SKUs could still be reserved. | Lines for a non-active SKU are rejected with `sku is discontinued`. |
| 8 | `reserve` did not validate `qty`. A negative qty passed the `qty > available` check and *added* stock (movement `-(-5) = +5`); `NaN` passed the check and corrupted `available` for that SKU forever; `0` and fractions were accepted. | `qty` must be a safe integer >= 1; `orderId` and `sku` must be non-empty strings; `lines` must be a non-empty array of objects. |
| 9 | Two lines for the same SKU in one order were each checked against availability independently, so with the atomic validate-first approach they could jointly overdraw (60 + 60 against 100). | Per-SKU totals are aggregated across lines before the availability check (with a safe-integer overflow guard on the total). |
| 10 | `reserve` was not retry-safe: repeating the call with the same order id reserved the stock twice. | Added an order registry. Same id + identical lines (same SKUs/quantities/sequence) is a no-op; same id + different lines throws `order already exists`. The registry entry is only written on success, so a failed call can be retried. The retry check runs before lifecycle checks, so a retry still succeeds if the SKU was discontinued in between. A cancelled order id stays consumed. **Breaking change** for any caller that intentionally reused an order id to reserve more stock. |
| 11 | Validation read `line.qty` once and the commit read it again, so an adversarial line object with a getter could pass validation with `1` and commit `-1000`. | Lines are copied to fresh objects of primitives during validation and committed from the copy. |
| 12 | `getMovements` returned the live internal array; callers could push, splice or edit movements and silently change stock. | Returns `movements.slice()`; every movement is `Object.freeze`d at creation. **Breaking change**: mutating the returned array no longer affects the ledger, and assigning to a movement field throws `TypeError` (ESM strict mode). |
| 13 | `available` scanned the whole ledger on every call, and `reserve` called it per line, so cost grew as O(lines x movements). | A per-SKU running net (`Map`) is maintained in the single `append` method alongside the ledger; `available` is O(1). |

### orders.ts

| # | Root cause | Fix |
|---|------------|-----|
| 14 | `lineValue` computed money in floating point: `gross - gross * (pct / 100)`. For example gross 100 at 55% returns `44.99999999999999` and gross 90 at 70% returns `27.000000000000007`; a brute-force scan found about 96% of (gross, pct) pairs under 100 000 produce a non-integer. | Integer-only arithmetic: `gross * (100 - pct)` is exact, then divided by 100 with half-up rounding implemented with integer ops. Result is always an integer number of minor units. Rounding policy is documented in the code. |
| 15 | `lineValue` accepted negative/fractional `qty`, discounts outside 0..100, and could overflow the safe-integer range silently. | `qty` must be a non-negative safe integer, `discountPct` an integer in [0, 100]; the gross and scaled intermediates are checked to be safe integers, otherwise it throws. |

### New capabilities (inventory.ts)

- `cancel(orderId)`: returns every reserved line as a positive movement.
  Atomic (nothing after the checks can throw), idempotent (second cancel is a
  no-op), throws on an order id that was never successfully reserved. Stock is
  returned even if the SKU was discontinued after the reservation, because the
  units physically exist and the ledger must balance; the SKU still cannot be
  reserved again. Since a cancel returns exactly what was reserved, `available`
  can never exceed `initial`.
- `history(sku, fromSeq, toSeq)`: that SKU's movements with `seq` in the
  inclusive range, in seq order. Bounds must be safe integers with
  `fromSeq <= toSeq`; the SKU must exist. Ranges outside the ledger return `[]`,
  overlapping ranges are clamped. Uses the invariant `seq === array index` to
  slice instead of scanning.

## 2. Production-readiness review

### Remaining risks (not fully covered by tests)

- **In-memory only, no durability.** Ledger, order registry and per-SKU net live
  in process memory. A crash or restart loses every reservation. `seq` restarts
  at 0 per instance and is not globally unique across restarts or instances.
- **Single-process assumption.** Correctness relies on JavaScript being
  single-threaded and every method being synchronous. There is no locking or
  optimistic concurrency. If this were ever fronted by async I/O or run in
  multiple processes against shared state, `reserve` would have a
  check-then-act race. Tests cannot exercise this.
- **Three structures kept consistent by convention.** `movements`, `net` and
  `orders` are updated together only through `append` and the commit blocks.
  A future edit that appends outside `append`, or removes movements, silently
  breaks `available` and `history` (which relies on `seq === index`). The
  consistency test in `history` guards the second point only partially.
- **No consumption of reservations.** There is no ship/fulfil operation and no
  stock receipt. `initial` is the only inflow, and a reserved order stays
  reserved forever unless cancelled. Reservations on discontinued SKUs also stay
  open; the module has no policy for them.
- **Unbounded growth.** The ledger and the order registry (including cancelled
  orders, which must be kept for idempotency) grow without bound. No archival or
  compaction.
- **Idempotency is by exact line sequence.** A retry that reorders the same
  lines is rejected as "different lines". This is deliberately conservative but
  may surprise callers that rebuild the payload. The `void` return also means a
  caller cannot tell a first reservation from a no-op retry.
- **Cancel raises availability of discontinued SKUs.** Downstream code that
  treats `available > 0` as "sellable" must also check `state`; `reserve`
  enforces this, `available` does not.
- **Rounding policy is a business decision.** `lineValue` rounds half-up per
  line. Summing rounded lines can differ by a minor unit from rounding an
  order total. Single currency is assumed. This has not been confirmed with
  finance.
- **`OrderService` takes `inventory` and `catalog` separately.** If given a
  different `Catalog` than the one the `Inventory` was built with, pricing and
  stock will disagree. Not enforced.
- **Errors are plain `Error` with message text.** Callers cannot reliably
  distinguish retryable failures (insufficient stock) from programming errors
  (invalid input) without string matching.
- **Freezing is shallow and strict-mode dependent.** `Movement` contains only
  primitives so shallow freeze is sufficient, but in sloppy-mode code a write to
  a frozen movement fails silently instead of throwing.

### Deliberately not changed, and why

- Kept `OrderService(inventory, catalog)` constructor and all public method
  signatures, including `getMovements(): Movement[]`, to avoid breaking callers
  beyond what correctness required.
- Did not add ship/fulfil, stock receipts, persistence or event export. Out of
  scope; they change the domain model, not just its correctness.
- `cancel` throws on an unknown order id rather than silently succeeding. A
  no-op would hide typos and mis-routed cancels; a caller compensating a failed
  `reserve` should catch the error.
- `available` still reports discontinued SKUs rather than throwing or returning
  0, because it is a truthful ledger figure and callers may need it for
  reporting.
- Did not introduce custom error classes. Worth doing next, but it is an API
  change every caller would have to adopt at once.
- Kept `seq` starting at 0 and kept it equal to the array index; changing it
  would not add safety and `history` benefits from the invariant.
- Kept everything in one test file to preserve the existing structure.

## 3. Final test status

Real output of `npx vitest run`:

```
 RUN  v4.1.10 <repo>/runs/fable-5-1-1

 ✓ inventory.test.ts (46 tests)

 Test Files  1 passed (1)
      Tests  46 passed (46)
```

`npx tsc -p tsconfig.json` exits 0 with no diagnostics.
