# Stock-reservation module — production-readiness report

## 1. Changes

### `catalog.ts`

**`discontinue()` set the wrong state (root cause: copy-paste bug)**
`discontinue(id)` set `state = "active"` instead of `"discontinued"`, so a
discontinued SKU stayed fully reservable and the existing test for this was
already red.
Fix: set `state = "discontinued"`.

**`add()` had no input validation (root cause: missing guards)**
- Calling `add()` twice with the same `id` silently overwrote the existing
  `Sku` record. Any prior reservations still referenced that SKU id, but
  `initial` and `unitPrice` would now be whatever the second call passed,
  silently changing the meaning of all past movements.
- `initial` and `unitPrice` accepted negative or fractional values, which
  breaks the documented invariants ("whole units", "integer minor units")
  and can drive `available()` negative from the very first call.

Fix: throw if the `id` already exists; throw if `initial` or `unitPrice`
is not a non-negative integer.

### `inventory.ts`

**`reserve()` accepted negative quantities (root cause: no validation on `qty`)**
The only check was `line.qty > this.available(line.sku)`. A negative `qty`
(e.g. `-1000`) always satisfies that comparison, and the pushed movement is
`-line.qty`, i.e. **positive** — so a single adversarial call could
manufacture stock out of nothing. Fractional quantities were also accepted,
violating "whole units of stock."

Fix: reject any line whose `qty` is not a positive integer, before touching
state.

**`reserve()` ignored SKU lifecycle (root cause: missing check)**
Nothing stopped reserving stock for a `discontinued` SKU.

Fix: reject reservations against any SKU whose `state !== "active"`.

**`reserve()` was not atomic across lines (root cause: check-and-push interleaved per line)**
The original loop validated and pushed one line at a time. If line 3 of a
4-line order failed (e.g. insufficient stock), lines 1–2 were already
committed as real movements — a caller who saw the thrown error and retried
or gave up would leave the warehouse in a state that doesn't correspond to
any order actually being placed, and `available()` would silently undercount
real inventory.

Fix: validate every line and the combined per-SKU demand for the whole call
first (aggregating repeated SKUs within one order), and only push movements
once everything is known to succeed. Either the whole order commits or
nothing does.

**`reserve()` had no retry-safety / idempotency (root cause: no order ledger)**
There was nothing tying an `orderId` to what it had already reserved. Calling
`reserve()` twice with the same `orderId` (e.g. a network-retry after a
timeout) would double-reserve the same stock — a serious correctness bug for
an operation that must be "safe to retry."

Fix: added an internal `orders: Map<string, { lines, cancelled }>` ledger.
- A second `reserve()` call with the same `orderId` and the *same* lines
  (order-insensitive comparison) is a no-op — the retry succeeds without
  double-reserving.
- A second call with the same `orderId` but *different* lines throws
  (ambiguous — we don't guess which reservation the caller actually wants).
- A `reserve()` call against an `orderId` that was already cancelled throws
  (an order shouldn't be resurrected after cancellation).

**`getMovements()` leaked the internal array by reference (root cause: returning the live array)**
Any caller could `push`/`splice`/mutate the array returned by
`getMovements()` and corrupt the inventory's actual movement ledger — the
one thing this module exists to keep correct.

Fix: return a shallow copy (`[...this.movements]`).

**Added `cancel(orderId: string): void`**
Looks up the order in the new ledger:
- unknown `orderId` → throws (nothing to cancel),
- already cancelled → no-op (idempotent — safe to call more than once, as
  required),
- otherwise → pushes one positive (returning) movement per originally
  reserved line, all in the same call (atomic), then marks the order
  cancelled so it can never be reserved or cancelled again.

**Added `history(sku: string, fromSeq: number, toSeq: number): Movement[]`**
Validates the SKU exists (consistent with `available()`'s behavior) and
returns the movements for that SKU with `seq` in the inclusive
`[fromSeq, toSeq]` range. Returns a new array (movements are filtered, not
referenced from the live array).

### `orders.ts`

**`lineValue()` used floating-point arithmetic on money (root cause: float division/subtraction on minor units)**
`gross - gross * (discountPct / 100)` can return a non-integer number of
minor units due to binary floating-point rounding (e.g.
`1000 - 1000 * (33/100)` is `669.9999999999999` in IEEE-754 double
arithmetic, not `670`). Money in minor units must always be a whole number.

Fix: compute the discount as `Math.round((gross * discountPct) / 100)` and
subtract that integer from `gross`.

**`lineValue()` had no input validation (root cause: missing guards)**
`qty` could be negative/fractional, and `discountPct` could be negative or
over 100 (i.e. it could *increase* the price or go negative), with no error.

Fix: reject non-positive/non-integer `qty` and `discountPct` outside
`[0, 100]` (or non-integer).

## 2. Production-readiness review

### Remaining risks / things I deliberately left alone

- **No persistence / durability.** All state (`movements`, `orders`,
  `Catalog`'s map) lives in memory only. A process restart loses every
  reservation and the catalog itself. This module has no notion of a
  transaction log or database, so it cannot by itself guarantee "no stock
  lost" across a crash — only within a single process's lifetime. Adding
  persistence is a much larger architectural change than a bug-fix pass, and
  the task scope (types/catalog/inventory/orders, no storage layer) doesn't
  include one, so I left it out. This is the single biggest gap between
  "tests pass" and "controls real warehouse stock."
- **Not thread-safe against real concurrency.** All the atomicity work here
  (validate-then-commit, the order ledger) makes `reserve`/`cancel` safe
  under JavaScript's single-threaded, synchronous execution model, and safe
  against sequential retries. It does **not** protect against two workers in
  different processes/threads mutating a shared external store concurrently
  — there is no such external store here, so this is a non-issue *today*,
  but it will become one the moment this module is wrapped around a shared
  database instead of an in-memory array. I did not add locking/CAS logic
  because there's nothing external to protect yet, and speculative locking
  around an in-memory `Map` would be dead code.
- **`reserve()`'s idempotency comparison is exact-match only.** A retry must
  submit literally the same lines (same SKUs and quantities, any order) to
  be treated as a no-op; anything else against an existing `orderId` throws.
  I chose "throw on ambiguity" over "silently take the newest lines" or
  "merge" because guessing wrong here means either losing or duplicating a
  customer's stock — an explicit error that surfaces to the caller is the
  safer failure mode. Callers that need to *change* an order should cancel
  and re-reserve with a new `orderId`.
- **`available()` is O(number of movements) per call**, and `reserve()`
  calls it once per distinct SKU in the order. For a long-lived inventory
  with a very large movement history this is a real (if unexciting)
  performance concern. I did not introduce a running-balance cache because
  it would duplicate the source of truth (the movement ledger) and I'd
  rather have one clearly-correct-but-slower implementation than two things
  that must always agree. This is a good candidate for a follow-up once
  there's a real performance signal, not a correctness fix.
- **No maximum-quantity / overflow guard.** `qty`, `unitPrice`, and `initial`
  are validated to be non-negative integers but not bounded, so a
  sufficiently large `qty * unitPrice` could exceed
  `Number.MAX_SAFE_INTEGER`. Given the module already commits to `number`
  (not `bigint`) for both quantities and money, and the task didn't flag
  this as in scope, I left the existing numeric type as-is rather than
  changing the public `Qty`/money representation, which would ripple into
  every signature in `types.ts`.
- **`Catalog.get()` / `Inventory.available()` / `history()` throw on an
  unknown SKU** rather than returning `undefined`/`[]`. I kept this
  behavior (it was already how `available()` worked) and made `history()`
  match it for consistency, on the theory that a caller asking about a SKU
  that was never added has a bug, and silent `[]`/`0` results would hide
  that. This is a deliberate, not accidental, choice — flagging it because
  it's a possible breaking-change point if some caller relied on a soft
  failure for unknown SKUs (none does, in this codebase).
- **Breaking changes worth calling out explicitly:**
  - `Catalog.add()` now throws on a duplicate SKU id instead of silently
    overwriting it. Any caller that relied on "re-adding" a SKU to reset its
    quantity/price will now get an exception instead.
  - `reserve()` now throws for non-active SKUs, non-integer/non-positive
    quantities, and for a second call with the same `orderId` and different
    lines. Any caller that was (accidentally or intentionally) relying on
    reserving discontinued SKUs, fractional/negative quantities, or
    "silently re-reserve with new lines under the same id" will now see an
    error.
  - `getMovements()` now returns a copy, not the live array. Any caller that
    was mutating the returned array to affect inventory state (this would
    have been a bug in that caller) will no longer be able to.
  These were all judgment calls in favor of correctness/safety over
  preserving accidental behavior, per the task's instruction to prioritize a
  production-grade standard.

### What the tests do not cover (and how I convinced myself the fixes work anyway)

The shipped `inventory.test.ts` only covers the five original happy-path/
error cases. It does not exercise `cancel`, `history`, multi-line orders,
retries, or adversarial input. I verified all of the new/changed behavior
with a temporary local test file (12 cases: negative-qty rejection,
multi-line atomicity, reserve-retry idempotency, cancel-then-double-cancel,
cancel-then-re-reserve rejection, unknown-order cancel rejection,
discontinued-SKU rejection, inclusive-range `history()`, `getMovements()`
defensive copy, float-safe `lineValue()` rounding, out-of-range discount
rejection, and duplicate-SKU rejection) — all 12 passed. That file was
scratch work for verification and was removed before finishing, per the
instruction to leave the repository containing only the intended module
changes; the underlying behavior it checked is now implemented in
`inventory.ts`/`orders.ts`/`catalog.ts`.

## 3. Final test status

```
 RUN  v4.1.10

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

All 5 original tests in `inventory.test.ts` pass. `npx tsc --noEmit` is
clean under the repo's `strict: true` config.
