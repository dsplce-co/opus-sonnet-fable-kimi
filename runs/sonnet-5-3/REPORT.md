# Stock Reservation Module — Production Readiness Report

## 1. Changes

### `catalog.ts`

**`discontinue()` set the wrong state (root cause: copy-paste bug).**
`discontinue(id)` set `state = "active"` instead of `"discontinued"` — it was a no-op that silently failed to discontinue anything. This is the one bug the pre-existing test suite already caught (`discontinue marks the SKU discontinued`).
*Fix:* set `state = "discontinued"`.

**`get()` returned the live internal `Sku` object (root cause: no encapsulation).**
Any caller could do `catalog.get("widget").unitPrice = 0` or `.state = "discontinued"` and silently corrupt catalog state from outside the class, with no audit trail. `Inventory.reserve()` and `OrderService.lineValue()` both trust `catalog.get()` for pricing/state decisions, so this was a direct path to corrupting money and lifecycle logic.
*Fix:* `get()` now returns a shallow copy. Internal code (`discontinue()`) uses a new private `getInternal()` that still returns the live reference, so mutation-through-`discontinue` keeps working.

**`add()` allowed silently overwriting an existing SKU, and accepted invalid quantities/prices (root cause: no input validation).**
Calling `add()` twice with the same id silently replaced the SKU, including its `initial` on-hand quantity — while any existing movements for that SKU (computed against the old `initial`) would suddenly be interpreted against a different baseline, corrupting `available()`. Negative or non-integer `initial`/`unitPrice` were also accepted, which would have propagated into negative-available or fractional-money bugs downstream.
*Fix:* `add()` now throws if the id already exists, and validates `initial`/`unitPrice` are non-negative integers.
**Note — behavior change:** re-adding an existing SKU id now throws instead of silently overwriting. No current caller relies on upsert semantics, but flagging it as intentional and breaking for any caller that did.

### `inventory.ts`

**`reserve()` validated and committed one line at a time — not atomic (root cause: validate-and-commit interleaved in a single loop).**
For a multi-line order, if line 3 of 5 failed validation (unknown SKU, insufficient stock), lines 1–2 had already been pushed as committed movements. The order as a whole failed (the caller sees a thrown error) but partial stock was already deducted and permanently unaccounted for — a direct violation of "no stock lost under failure."
*Fix:* `reserve()` now runs a full validation pass (existence, SKU lifecycle, quantity, and *aggregated* per-SKU availability across all lines of the order) before writing any movement. Movements are only pushed once every line is known-good, so a rejected order leaves no trace.

**`reserve()` accepted negative, zero, non-integer, `NaN`/`Infinity` quantities (root cause: no input validation on `Line.qty`).**
`qty > this.available(sku)` was the only guard. A negative `qty` (e.g. `-5`) passes that check trivially and then gets pushed as `-line.qty` = a *positive* movement — i.e. calling `reserve` with a negative quantity would silently **increase** available stock. This is a direct "stock duplicated/inflated" exploit via adversarial input.
*Fix:* every line's `qty` must be a positive integer (`Number.isInteger(qty) && qty > 0`), or the whole order is rejected before any movement is written.

**`reserve()` didn't check SKU lifecycle (root cause: missing state check).**
Nothing prevented reserving stock against a `discontinued` SKU, even though the type system models `SkuState` specifically to express that lifecycle.
*Fix:* reserving against a non-`"active"` SKU now throws.

**`reserve()` had no protection against being called twice with the same `orderId` (root cause: no duplicate/retry tracking).**
Calling `reserve("o1", ...)` twice reserved stock twice under the same order id — silent stock duplication, and specifically unsafe for the common retry pattern ("caller times out waiting for a response and retries the same request").
*Fix:* added an `orderStatus: Map<string, "reserved" | "cancelled">` tracking each order's lifecycle. `reserve()` now throws if the `orderId` has already been used (reserved or cancelled). A caller that gets this specific error on retry can safely treat it as "already applied" rather than retrying into a duplicate reservation.

**`getMovements()` returned the live internal array (root cause: no encapsulation, mirrors the `catalog.get()` issue).**
`inv.getMovements().push(...)` or mutating a returned `Movement`'s `qty` in place would corrupt the append-only ledger that `available()` depends on for every future calculation — undetectable stock corruption from outside the class.
*Fix:* `getMovements()` now returns an array of shallow copies.

**Added `cancel(orderId): void`.**
Reverses a reserved order's stock movements (pushes a positive movement per original negative movement, preserving the append-only/auditable design already used for `reserve`). Uses the same `orderStatus` map to:
- throw on an unknown `orderId` (distinguishing "invalid input" from "already handled"),
- no-op on an already-`"cancelled"` order, making the operation safe to call more than once (the explicit "safe to retry" requirement),
- respect SKU lifecycle implicitly — cancellation only ever reverses movements that were legitimately reserved, regardless of the SKU's *current* state, since returning stock shouldn't be blocked by the SKU having since been discontinued.

Because JavaScript is single-threaded and `cancel()` performs no `await`, the read-validate-write sequence is atomic with respect to any other call into this module — there's no interleaving point where another operation could observe or act on a half-cancelled order.

**Added `history(sku, fromSeq, toSeq): Movement[]`.**
Filters the ledger to the given SKU and inclusive `[fromSeq, toSeq]` seq range, returning copies (same rationale as `getMovements()`).

### `orders.ts`

**`lineValue()` used naive floating-point percentage math for money (root cause: `discountPct / 100` and multiplication done in floating point without rounding).**
`gross - gross * (discountPct / 100)` can produce non-integer results even though the type's own contract (`unitPrice` is "integer minor units," e.g. cents) requires an integer answer — e.g. `gross=999, discountPct=29` gives `999 - 289.71 = 709.29`, not a valid minor-unit amount. Left unrounded, this either silently returns fractional cents or accumulates floating-point drift over repeated calls.
*Fix:* compute the discount amount and round it to the nearest integer minor unit (`Math.round((gross * discountPct) / 100)`) before subtracting, so the result is always a whole number of minor units.

**`lineValue()` had no input validation (root cause: none present).**
Negative `qty`, `discountPct` outside `[0, 100]`, or non-integer `discountPct` (the doc comment specifically says "whole-percent discount") were all silently accepted, which could produce negative order values or discounts greater than 100%.
*Fix:* `qty` must be a positive integer; `discountPct` must be an integer in `[0, 100]`. Both throw otherwise.

`place()` was left unchanged — it delegates straight to `Inventory.reserve()`, which now performs all necessary validation.

## 2. Production-readiness review

### Remaining risks (things I did not fix, and why)

- **No persistence / durability.** All state (`movements`, `nextSeq`, `orderStatus` in `Inventory`; `bySku` in `Catalog`) is in-memory only. A process crash loses the ledger entirely. This is out of scope for a module-level fix — it's an architectural decision (what store, what transaction boundary) that needs to be made by whoever integrates this module into a real service, not guessed at here.
- **No concurrency control beyond single-threaded JS guarantees.** The atomicity claims in this report ("reserve is atomic," "cancel is safe to retry") hold because JavaScript executes each of these synchronous methods to completion without interleaving. If this module is ever run behind multiple Node processes/workers sharing the same catalog (e.g. via a database), none of that protection carries over — real optimistic/pessimistic concurrency control (row versioning, transactions) would be needed at that boundary. Not addressed here since there's no persistence layer to attach it to.
- **`available()` is O(n) in the number of movements for that SKU, scanned on every call**, and `history()`/`getMovements()` are O(n) full scans. For a long-lived SKU with a large history this is a performance concern, not a correctness one. I left it as-is: the existing design is already scan-based (`available()` was already O(n) before my changes), and adding a running-balance cache or an index by `orderId`/`sku` would be a reasonable follow-up but is a performance optimization, not something the stated "production-ready" bar (no lost/duplicated/negative stock, correct arithmetic, safe retries, encapsulation, honest docs) requires.
- **No maximum bound on `qty` beyond "positive integer."** Nothing stops a single reservation for `Number.MAX_SAFE_INTEGER` units of a SKU that happens to have that much `available()` (which itself would require a matching `initial` — bounded in practice by what `Catalog.add()` was given). Not fixed, since it's not a correctness bug: the arithmetic stays exact for safe-integer ranges, and any business-specific "max order size" policy belongs at a layer above this module, not invented here.
- **`cancel()` on an order whose SKU has since been re-discontinued/removed** still succeeds (by design, see above) — but there is no way to re-reserve under the same `orderId` afterward (by design: `orderStatus` never forgets a used id, matching the "one-shot order id" model implied by rejecting duplicate `reserve` calls). If the intended business semantics are instead "a cancelled order id can be reused," that's a deliberate design choice this report is flagging, not a bug — the requirements only asked that `cancel` be idempotent, not that ids be recyclable.
- **`Line.qty` validation stops at "positive integer."** It does not, and cannot, know whether a huge but technically valid quantity is a legitimate bulk order or a data-entry error (e.g. quantity entered in the wrong unit). That's a business-rule/UI concern, not something this module can safely infer.
- **Discontinuing a SKU does not touch existing reservations.** A SKU can be discontinued while orders against it are still outstanding; those orders remain valid and `cancel()` will still return their stock. This mirrors real-world inventory semantics (you can stop selling something without invalidating orders already placed for it) and I judged it correct behavior rather than a gap — flagging it here since it wasn't obvious from the original code whether this was intended.

### What tests do *not* cover (beyond what's fixed above)

The original suite (5 tests) only covered the two happy-path lifecycle assertions and the single-line insufficient-stock case. It did not exercise: multi-line orders, repeated SKUs within one order, duplicate `orderId` calls, non-integer/negative quantities, discontinued-SKU reservation, `cancel()` (new capability, so unsurprising), `history()` (new capability), `getMovements()`/`catalog.get()` mutation-safety, or `lineValue()` at all. I wrote a throwaway adversarial test file during development to verify each fix (atomicity under partial failure, negative-qty rejection, duplicate-order rejection, cancel idempotency, defensive copies, rounding), confirmed all of it behaved as intended, and then deleted that file since it wasn't part of the requested deliverable — `inventory.test.ts` is unchanged from the original and still the only test file in the repo. If this module is taken further, I'd recommend promoting that coverage (multi-line atomicity, retry-safety, cancel, history, money rounding) into the permanent suite before this controls real stock.

## 3. Final test status

```
$ npx vitest run

 RUN  v4.1.10 <repo>/runs/sonnet-5-3


 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  16:08:06
   Duration  647ms (transform 212ms, setup 0ms, import 243ms, tests 7ms, environment 0ms)
```

`npx tsc --noEmit` also passes cleanly under the repo's `strict` TypeScript configuration.
