# Stock Reservation Module — Production Readiness Report

## 1. Changes

### `catalog.ts`

**`discontinue()` set the wrong state (copy-paste bug).**
Root cause: `this.get(id).state = "active"` — it re-set the SKU to `"active"` instead of `"discontinued"`, so `discontinue()` was a no-op in practice. This was already caught by the existing test suite (`discontinue marks the SKU discontinued` was failing at baseline).
Fix: `discontinue()` now sets `state = "discontinued"`.

**`get()` returned a live reference into internal storage.**
Root cause: `get()` returned the actual `Sku` object stored in the `Map`. Any caller could do `catalog.get("widget").initial = 999999` or flip `.state` directly, silently corrupting the catalog with no validation and no audit trail — this is the kind of bug that turns "SKU is active" or "on-hand is 100" into a lie the rest of the system trusts.
Fix: `get()` now returns a shallow copy (`{ ...sku }`). Internal mutation (used by `discontinue()`) goes through a new private `getInternal()` that returns the live object, so the class itself can still mutate state but callers can no longer reach it.

**`add()` silently overwrote an existing SKU.**
Root cause: `add()` did a bare `this.bySku.set(id, sku)` with no existence check. Re-adding an id already in use replaced `initial`/`unitPrice`/`state` while all previously recorded `Movement`s for that SKU stayed in `Inventory`'s ledger — `available()` would then compute `initial (new, unrelated baseline) + sum(old movements)`, producing a number with no real-world meaning. This is silent, systemic data corruption, not a crash.
Fix: `add()` throws if the id already exists.

**`add()` had no input validation.**
Root cause: `initial` and `unitPrice` were accepted as-is — negative, fractional, or otherwise nonsensical values would be stored and treated as ground truth for every future `available()`/`lineValue()` call.
Fix: `add()` now requires a non-empty `id`, and non-negative integers for `initial` and `unitPrice`.

### `inventory.ts`

**`reserve()` was not atomic across multiple lines.**
Root cause: each line was checked and immediately committed (`this.movements.push(...)`) inside the same loop. If line 1 of a 2-line order succeeded and line 2 then failed (e.g. insufficient stock), the `Error` thrown for line 2 left line 1's movement permanently in the ledger — the caller sees a thrown exception ("order failed") while stock for that same order was actually reserved. This directly violates "no stock lost or duplicated under failure."
Fix: `reserve()` now validates *all* lines (including aggregating repeated SKUs within one order, since two lines for the same SKU must be checked against a single running total, not two stale snapshots of `available()`) before committing any movement. Movements are only pushed after every line passes.

**`reserve()` accepted zero, negative, and non-integer quantities.**
Root cause: no validation on `line.qty`. Since a movement is recorded as `-line.qty`, a negative quantity (e.g. `qty: -1000`) produced a *positive* movement — i.e. calling `reserve()` with adversarial input fabricated stock out of thin air. Zero/fractional quantities also made no sense against `Qty` being documented as "whole units."
Fix: every line's `qty` must be a positive integer, checked before any commit.

**`reserve()` ignored SKU lifecycle.**
Root cause: `reserve()` called `catalog.get(line.sku)` only to trigger the "does it exist" check, never inspecting `.state`. A discontinued SKU could still be reserved for new orders — `discontinue()` was effectively decorative dead state.
Fix: `reserve()` now rejects any line whose SKU is not `"active"`.

**`reserve()` was not safe to retry.**
Root cause: calling `reserve(orderId, lines)` twice (e.g. a caller retries after a timeout, not knowing whether the first call actually landed) created two independent sets of movements under the same `orderId`, double-reserving stock with no way to detect it after the fact.
Fix: `Inventory` now tracks each `orderId`'s status and originally-reserved lines. A retry with the *same* `orderId` and the *same* lines (compared by per-SKU totals, order-independent) is a silent no-op. A retry with the same `orderId` but *different* lines is rejected as a conflict, rather than silently double-booking or silently ignoring a legitimately different request.

**`getMovements()` returned the live internal array.**
Root cause: `return this.movements;` handed callers a direct reference — `inv.getMovements().push(...)` or `.splice(...)` would corrupt the append-only ledger from outside the class.
Fix: returns a fresh array of shallow-copied `Movement` objects.

### `orders.ts`

**`lineValue()` produced fractional minor units.**
Root cause: `gross - gross * (discountPct / 100)` is plain floating-point arithmetic with no rounding. `types.ts` documents `unitPrice` as "integer minor units (e.g. cents)," but e.g. `unitPrice=333, qty=3, discountPct=10` yields `899.1` — a fractional cent, which is not a valid monetary amount and would silently corrupt downstream totals/ledgers/invoices.
Fix: the discount is rounded to the nearest whole minor unit before subtracting (`Math.round(gross * (discountPct / 100))`), guaranteeing an integer result.

**`lineValue()` had no input validation.**
Root cause: `qty` and `discountPct` were unchecked — negative quantities, or a `discountPct` outside `[0, 100]` (e.g. `150` → negative price, or `-10` → price inflated above gross) produced nonsensical monetary values with no error.
Fix: `qty` must be a positive integer; `discountPct` must be an integer in `[0, 100]`.

### New capabilities

**`cancel(orderId: string): void`** — reverses a reserved order's movements (one positive movement per originally-reserved line, so `available()` returns to its pre-reservation value), atomically (all lines reversed together as one synchronous operation, never partially), and idempotently (cancelling an already-cancelled order is a no-op; cancelling an `orderId` that was never reserved throws, since there is nothing to cancel and silently succeeding would mask a caller bug). It does not consult the SKU's current lifecycle state at all — a cancel must succeed and return stock even if the SKU has since been discontinued, since discontinuing only blocks *new* reservations, not the resolution of ones already made.

**`history(sku: string, fromSeq: number, toSeq: number): Movement[]`** — returns that SKU's movements with `seq` in the inclusive `[fromSeq, toSeq]` range, as defensive copies (consistent with `getMovements()`). Throws if the SKU is unknown, for consistency with `available()`'s existing behavior.

### Test suite

Added 16 tests to `inventory.test.ts` covering every fix above plus both new methods (defensive copies on `Catalog.get`/`getMovements`, duplicate-SKU rejection, invalid-input rejection, atomic rollback on a failing multi-line reserve, discontinued-SKU rejection, retry idempotency vs. conflict, `cancel` success/idempotency/unknown-order/post-discontinue behavior, `history` range filtering, and `lineValue` rounding/validation). Original 5 tests are unchanged.

## 2. Production-readiness review

### Remaining risks (including gaps the tests do not cover)

- **Not thread-safe / no cross-process concurrency control.** All "atomicity" here means "no `await` point between validation and commit," which is sufficient for JavaScript's single-threaded event loop but says nothing about multiple Node processes (or multiple `Inventory` instances) sharing a real database — this module has no persistence layer, so that risk is currently out of scope, but it will resurface the moment this logic is backed by a real datastore with concurrent writers. A real deployment needs a transaction or optimistic-locking layer at the persistence boundary.
- **No persistence / durability.** Everything lives in memory (`this.movements`, `this.orders`, `Catalog`'s `Map`). A process restart loses the entire ledger. This is presumably intentional for this exercise, but it is the single biggest gap for "controls real warehouse stock in production."
- **Retry-safety heuristic for `reserve()` is best-effort, not a true idempotency key.** Comparing "same lines" by aggregated per-SKU totals means two genuinely different requests that happen to sum to the same per-SKU totals (e.g. `[{a,5},{a,5}]` vs `[{a,10}]`) are treated as equivalent. For this module's purposes (same net effect on availability) that's a reasonable, documented tradeoff, but a stricter production system would use a caller-supplied idempotency token rather than inferring equivalence from content.
- **`available()` and `history()` are O(n) scans over the full movement log**, and `Catalog` is a `Map` with no indexing beyond by-id lookup. Fine at this scale; would need per-SKU indices (e.g. `Map<sku, Movement[]>`) before this ledger grows large. I did not add that indexing — it's a performance concern, not a correctness one, and premature optimization here would add complexity (cache invalidation on cancel/reserve) not justified by the current scope.
- **No maximum-order-size / rate-limiting / authorization concerns** — this module has no concept of *who* is placing an order or *how many* orders per second are acceptable. Out of scope for a stock-reservation ledger, but worth flagging since "adversarial input" in a real deployment includes abuse patterns, not just malformed values.
- **`Movement.seq` is a plain incrementing counter with no persistence**, so `history()`'s ranges are only meaningful within a single process lifetime. That's consistent with the in-memory nature of the whole module.
- **Catalog id validation is minimal** (`!id`) — it doesn't reject e.g. whitespace-only strings or overly long ids. I judged this out of scope for a stock-reservation module's correctness; it's a cosmetic input-hygiene concern, not a data-integrity one.

### Deliberate non-changes (and why)

- **Did not block `reserve()` retries with a hard error on any mismatch heuristic more sophisticated than per-SKU totals** — see above; a real idempotency-key design was judged out of scope for this handoff (no API/transport layer exists here to carry such a key).
- **Did not change `reserve()`'s or `place()`'s public signatures.** `place()` in `orders.ts` still forwards straight to `reserve()`, so it now inherits all the new validation (positive integer qty, active SKU, atomicity, retry-safety) automatically — no separate fix needed there.
- **Did not add stock-level locking/mutexes.** Unnecessary in a single-threaded, synchronous, in-memory implementation; would be dead complexity here and the wrong layer to solve real concurrency (that belongs at the persistence boundary, see above).
- **Did not change `Sku`/`Movement`/`Line` shapes in `types.ts`.** Every fix was achievable within the existing data model; changing it would have been a wider, unrequested refactor.
- **Breaking-change note:** `catalog.add()` and `inventory.reserve()` now throw in several cases that previously succeeded silently (duplicate SKU id; invalid `initial`/`unitPrice`; zero/negative/non-integer `qty`; discontinued SKU; conflicting retry). Any existing caller that relied on those being silently accepted (e.g. re-adding a SKU to "reset" its stock, or reserving against a discontinued SKU) will now see a thrown `Error` and needs to be updated. I judged this necessary — the previous behavior was data corruption, not a feature — but it is a genuine behavioral break worth calling out explicitly.

## 3. Final test status

```
 Test Files  1 passed (1)
      Tests  21 passed (21)
```

`npx tsc --noEmit` also passes with no errors under the project's `strict` compiler settings.
