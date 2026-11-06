# Production-Readiness Report

## 1. Changes

### `catalog.ts` — `discontinue` set wrong state (line 13)

**Root cause:** The method body read `this.get(id).state = "active"` — a copy-paste error that set
the state to `"active"` rather than `"discontinued"`. Every call to `discontinue` was therefore a
no-op, meaning discontinued SKUs could never be blocked from new reservations.

**Fix:** Changed the assignment to `"discontinued"`.

---

### `inventory.ts` — `reserve` was non-atomic

**Root cause:** The original loop pushed each movement to `this.movements` as it processed each
line. If line N failed (e.g. insufficient stock), lines 0..N-1 were already committed. That stock
was permanently deducted from availability and lost — no order held it, no cancel could return it.

**Fix:** Accumulate all validated pending lines in a local array first. Only push to
`this.movements` (the commit step) after every line passes validation. A failure at any line now
leaves the movements array untouched.

---

### `inventory.ts` — `reserve` allowed discontinued SKUs to be reserved

**Root cause:** `reserve` called `catalog.get(sku)` only to verify the SKU existed; it never
checked `sku.state`. Combined with the broken `discontinue` method, this had no visible effect
before, but with `discontinue` fixed a discontinued SKU would still accept new reservations.

**Fix:** After fetching the SKU, throw `Error("sku <id> is discontinued")` if
`sku.state === "discontinued"`.

---

### `inventory.ts` — `reserve` accepted zero, negative, and fractional quantities

**Root cause:** `Qty` is a plain `number` type alias with no runtime enforcement. A caller could
pass `qty: 0`, `qty: -5`, or `qty: 1.5` without error, each silently corrupting the availability
balance.

**Fix:** Added `if (!Number.isInteger(line.qty) || line.qty <= 0)` guard that throws before any
availability check or movement is staged.

---

### `inventory.ts` — `reserve` had no idempotency guard (same `orderId` double-deducted stock)

**Root cause:** Nothing prevented calling `reserve` twice with the same `orderId`. A retry or
accidental duplicate call would deduct stock again and create a second set of movements for the
same order. This is unsafe for a retry-tolerant system.

**Fix:** At the very start of `reserve`, scan `this.movements` for any existing entry with
`m.orderId === orderId`. If one is found, return immediately (no-op). This makes `reserve`
idempotent: the first call commits, every subsequent call with the same ID is a safe no-op.

**Breaking change note:** Previously, calling `reserve("o1", ...)` twice would deduct stock twice.
Any code that relied on that behaviour (intentional double-reservation via repeated calls) will now
only see the first reservation take effect.

---

### `inventory.ts` — `getMovements()` returned the internal array by reference

**Root cause:** `return this.movements` exposed the live backing array. Any caller could
`.push(...)`, `.splice(...)`, or mutate movement objects on the returned array and corrupt internal
state without going through any validation.

**Fix:** Changed to `return [...this.movements]` (shallow copy of the array).

---

### `inventory.ts` — Added `cancel(orderId: string): void`

New method. Finds all negative-qty movements for the given `orderId` (the reservations), then
atomically pushes one positive-qty movement per reservation line to return the stock. Idempotent:
if no reservations exist, or if positive (return) movements for that `orderId` already exist, the
method returns without writing anything. Works on discontinued SKUs — blocking cancel on a
discontinued SKU would permanently trap that stock.

---

### `inventory.ts` — Added `history(sku: string, fromSeq: number, toSeq: number): Movement[]`

New method. Validates that the SKU exists (throws the catalog's standard error if not), then
returns a shallow copy of each movement whose `sku` matches and whose `seq` falls within the
inclusive `[fromSeq, toSeq]` range. Returns copies of movement objects so callers cannot mutate
internal state.

---

### `orders.ts` — `lineValue` produced non-integer minor-unit amounts

**Root cause:** `gross - gross * (discountPct / 100)` used floating-point division. For example,
`unitPrice=10, qty=3, discountPct=33` yields `gross=30`, discount `30 × 0.33 = 9.9`, result
`20.1` — not a valid integer cent value.

**Fix:** `Math.round(gross * (1 - discountPct / 100))` snaps to the nearest integer minor unit.
Rounding direction: standard half-up. In a system that requires consistent rounding direction
(e.g. always truncate in favour of the merchant), callers should specify this explicitly and the
implementation should be updated accordingly.

---

## 2. Production-readiness review

### Remaining risks not covered by the current test suite

**`Catalog` objects are mutable by any holder of a `Sku` reference.**
`catalog.add` and `catalog.get` both return the live `Sku` object. Any caller can write
`sku.unitPrice = 0` or `sku.initial = 99999` without going through the catalog. `available()`
reads `sku.initial` directly; mutating it retroactively changes every past and future availability
calculation. Fixing this would require `Catalog` to return defensive copies and disallow external
mutation. Not changed here because it would require a broader type-system refactor that may break
existing callers.

**No duplicate-SKU guard in `Catalog.add`.**
Calling `catalog.add("widget", ...)` twice silently overwrites the first entry. The
`initial` on-hand is reset, but existing movements that reference the old `initial` will now
produce wrong availability figures (negative or inflated). Not changed: the tests have no coverage
for re-adding a SKU and the correct semantics (replace vs. error) need a product decision.

**`lineValue` rounding direction is unspecified.**
`Math.round` rounds `.5` up. For financial systems that require deterministic and auditable
rounding (e.g. banker's rounding, or always truncating in a particular party's favour), this needs
to be replaced with an explicit rounding policy. Current tests do not exercise any fractional-cent
case.

**`cancel` does not validate that the caller owns the order.**
Any code with a reference to the `Inventory` instance can cancel any `orderId`, including orders
placed by other services. There is no ownership or authorization model. This is a systemic design
gap beyond the scope of this module — noted as a risk for real multi-tenant warehouse use.

**`reserve` idempotency is keyed only on `orderId`.**
If a retry arrives with the same `orderId` but a different set of lines (e.g. a corrected order),
it will silently succeed as a no-op rather than applying the correction. Systems that need
at-most-once-with-correction semantics would require a different approach (e.g. compare the full
request hash, or require explicit cancel-and-re-reserve).

**`available()` is O(n) over all movements.**
For high-volume systems this will degrade as the movements log grows without bound. A materialized
per-SKU balance cache would be needed before production at scale. Not changed because the current
simple model is correct; caching is a performance concern, not a correctness concern, for the
current test set.

**No persistence or durability.**
All state is in-process memory. A restart loses all movements, orders, and the SKU catalogue. This
is expected for an in-memory module but documented here as the most obvious gap between this
implementation and a real warehouse system.

**`Qty` type alias is not enforced.**
`Qty = number` is a documentation hint, not a runtime constraint. The positive-integer guard in
`reserve` enforces it at the reservation boundary, but nothing prevents a `Movement` or `Sku` from
carrying a `Qty` that is a float or negative if constructed directly. A branded type
(`type Qty = number & { __qty: never }`) with a factory would close this, but is a type-system
refactor left for a future pass.

### What was deliberately NOT changed

**`types.ts`** — no changes. The type definitions are correct as-is; enforcement is done at the
boundary methods rather than the type level.

**`Catalog` mutability** — `Sku` objects remain mutable. Fixing this properly requires either
frozen objects or copy-on-return semantics across the catalog, which would constitute a broader
interface change beyond the stated scope.

**`lineValue` rounding policy** — changed from floating-point to `Math.round`, but the direction
of rounding (half-up vs. truncate vs. banker's) is a business decision that should be made
explicitly with the finance/product team.

---

## 3. Final test status

```
 RUN  v4.1.10 <repo>/runs/sonnet-4-6-3

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  16:27:25
   Duration  310ms (transform 81ms, setup 0ms, import 99ms, tests 5ms, environment 0ms)
```

All 5 pre-existing tests pass. No tests were removed or modified.
