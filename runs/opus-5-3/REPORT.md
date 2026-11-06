# Stock reservation module — handover report

Scope: `types.ts`, `catalog.ts`, `inventory.ts`, `orders.ts`, `inventory.test.ts`.
File and export structure is unchanged; `cancel` and `history` were added as
methods on the existing `Inventory` class.

Every defect below was reproduced against the original code before being fixed,
not inferred from reading.

---

## 1. Changes

### `catalog.ts` — `discontinue` set the wrong state
**Root cause.** `discontinue(id)` assigned `state = "active"`. A SKU could never
be taken out of service; the one failing test in the inherited suite pointed at
this.
**Fix.** Sets `"discontinued"`. Made idempotent (a second call is a no-op).

### `catalog.ts` — re-adding a SKU silently rewrote stock history
**Root cause.** `add` did `this.bySku.set(id, sku)` unconditionally. Because
`available()` is computed as `initial + sum(movements)`, overwriting `initial`
retroactively restated every availability figure already derived from it.
Reproduced: `add("w",100)` → reserve 40 (available 60) → `add("w",10)` →
**available −30**. Stock invented or destroyed by a duplicate registration.
**Fix.** `add` throws `sku already exists` for a known id. `initial` is now
write-once for the lifetime of a `Catalog`.

### `catalog.ts` — no input validation
**Root cause.** `initial` and `unitPrice` were accepted unchecked, so `NaN`,
`Infinity`, fractions and negatives entered the ledger as the arithmetic base.
**Fix.** `assertWholeUnits` (non-negative safe integer; rejects `NaN`,
`Infinity`, fractions, non-numbers) on both, and `assertId` on the id. Both
helpers are exported and reused by `inventory.ts` and `orders.ts` so the
definition of "a valid quantity" is written once.

### `catalog.ts` / `types.ts` — callers could mutate catalog state
**Root cause.** `get()` returned the live internal `Sku`. Reproduced:
`catalog.get("w").initial = 999999` moved availability to 999,949.
**Fix.** Entries are `Object.freeze`d; `discontinue` replaces the entry rather
than mutating it. `Sku` and `Movement` fields are now `readonly`, so the same
mistake is a compile error as well as a runtime `TypeError`.

### `inventory.ts` — `reserve` was not atomic
**Root cause.** The loop validated and appended one line at a time, so a failure
on line *n* left lines *1..n−1* committed. Reproduced: order `[a:5, b:99]`
against `a:10, b:1` threw on `b` and left **a at 5** — five units reserved by an
order that does not exist. The same bug hit repeated lines for one SKU, because
each line was checked against availability separately rather than as a total.
**Fix.** Three passes: (1) structural validation and per-SKU aggregation,
(2) catalog lifecycle and availability checked against the *order total*,
(3) commit. Nothing after pass 3 begins can fail, so a rejected order appends
no movements at all.

### `inventory.ts` — `reserve` was not retry-safe
**Root cause.** No order registry. Reproduced: submitting `dup` twice reserved
60 units, not 30 — an ordinary at-least-once delivery retry double-reserved.
**Fix.** An order registry keyed by `orderId`. Re-submitting an id already
reserved with the same per-SKU totals is a no-op; re-submitting with different
totals throws a conflict. The idempotency check sits *before* the catalog
lookup, so an identical retry still succeeds even if the SKU was discontinued
in between — that is the case a retry most needs to survive.

### `inventory.ts` — quantities were not validated
**Root cause.** `if (line.qty > this.available(...))` is the only guard, and it
passes for values that should never reach a ledger.
 - `qty: -5` **increased** availability from 10 to 15 — stock created from nothing.
 - `qty: NaN` passed (`NaN > 10` is `false`) and made availability permanently `NaN`; every later comparison then also silently passes.
 - `qty: 0` and fractional quantities were accepted.
**Fix.** Each line must be a whole number ≥ 1, validated before anything is
appended; running totals are re-checked for safe-integer overflow.

### `inventory.ts` — SKU lifecycle was not enforced on reserve
**Root cause.** `reserve` called `this.catalog.get(line.sku)` purely for its
throw-on-unknown side effect and ignored `state`. Discontinued SKUs were freely
reservable.
**Fix.** Pass 2 rejects any non-`active` SKU.

### `inventory.ts` — the ledger was handed out by reference
**Root cause.** `getMovements()` returned the internal array. Reproduced:
`inv.getMovements().push({...})` forged a −50 movement that `available()` then
honoured.
**Fix.** `getMovements()` returns a copy of an array of frozen movements.
**Breaking change:** callers that mutated the returned array to affect inventory
no longer can — that was the vulnerability, and any such caller was already
corrupting stock.

### `inventory.ts` — read-once hardening of `reserve` (adversarial input)
**Root cause.** Even after the three-pass split, `lines` was read twice: once to
validate, once to commit. A line object with a getter can return `1` to the
check and `500` to the commit and overdraw the SKU.
**Fix.** Each field is destructured exactly once, the *copy* is validated, and
the commit pass reads only the internal snapshot. Covered by a test that mounts
the attack.

### `inventory.ts` — new: `cancel(orderId)`
Returns an order's reserved stock to availability.
 - **Atomic:** every SKU is re-resolved before any movement is appended.
 - **Idempotent:** cancelling an already-cancelled order is a no-op, so the call
   is safe to retry. An unknown `orderId` throws — that is a caller mistake, not
   a repeat of completed work.
 - **Lifecycle:** a *discontinued* SKU can still be cancelled. Discontinuing
   blocks new reservations; blocking the return as well would strand those units
   in a dead order permanently, which is precisely the stock loss this module
   exists to prevent. A SKU no longer registered at all does throw.
 - Reversal is emitted per SKU rather than per original line (an order with two
   lines of one SKU reserves twice, returns once, same net).
 - A cancelled `orderId` cannot be reserved again; reuse throws rather than
   resurrecting the order.

### `inventory.ts` — new: `history(sku, fromSeq, toSeq)`
Returns that SKU's movements with `fromSeq <= seq <= toSeq`, inclusive, in
ascending `seq` order, including cancel movements. Unknown SKU throws (an empty
array would hide a typo); non-integer bounds throw; an inverted range returns
`[]`. The returned array is fresh and its movements are frozen.
Note `seq` is global across all SKUs, so a range is a window over the whole
ledger, not a count of one SKU's movements — documented at the method.

### `inventory.ts` — `available()` no longer rescans the ledger
`available()` scanned every movement on every call, and `reserve` called it per
line, making order placement O(lines × ledger). Availability is now a running
per-SKU total updated in the same append step. Behaviour is identical; it just
no longer degrades as the ledger grows.

### `orders.ts` — money arithmetic produced fractional minor units
**Root cause.** `gross - gross * (discountPct / 100)` in floating point.
Reproduced: `lineValue` for 3 × 999 at 33% returned **2007.99** — not a whole
number of cents. Downstream this is silently truncated or rounded differently by
each consumer. `discountPct` was also unvalidated: `-100` *raised* the price to
1998, and `200` returned **−999**, a negative line value.
**Fix.** `discountPct` must be a whole percent in `0..100`. The discount is
computed in exact integer arithmetic (`%` and a multiple-of-100 division, both
exact for safe integers) and rounded half-up, so the result is always an
integer. Both `gross` and the intermediate are guarded against exceeding the
safe-integer range, where addition silently loses units.

### `inventory.test.ts`
The five original tests are unchanged. 36 tests were added covering each defect
above, the two new methods, and the adversarial cases.

---

## 2. Production-readiness review

### Risks that remain — and that the tests do *not* cover

**Durability and concurrency are entirely out of scope of this module.** State
lives in in-process `Map`s and arrays. Everything here is atomic only in the
single-threaded JavaScript sense: no `await` occurs between a check and its
commit, so no interleaving is possible *within one process*. Two processes, or
two `Inventory` instances over the same `Catalog`, each keep independent ledgers
and will both happily reserve the same physical unit. **Before this controls
real warehouse stock it needs a shared transactional store**, with the
availability check and the movement insert in one transaction (or a
`CHECK (available >= 0)` constraint as backstop). No test covers this, because
nothing at this layer can.

**Orders and movements grow without bound.** The ledger, the per-SKU index and
the order registry are append-only with no compaction or snapshotting. Memory
grows with lifetime order volume. A production deployment needs periodic
snapshot-and-truncate, which in turn needs an opening-balance concept that
`Sku.initial` does not currently provide.

**`Sku` is an immutable snapshot, which makes stale reads possible.** A
reference held across a `discontinue` call still reports `"active"`. Internal
code always re-reads through `catalog.get`, so the module itself is correct, but
a caller caching a `Sku` can act on stale lifecycle state. Documented at
`Catalog.get`.

**There is no goods-in / restock path.** `initial` is write-once and the only
positive movements come from `cancel`. Availability can therefore only ever fall
towards zero over a SKU's life. This matches the module as handed to me; a real
warehouse needs a `receive()` counterpart, and adding one will require revisiting
the overflow guards on the positive side.

**Idempotency keys are never retired.** `reserve` recognises a duplicate order
forever, which is correct but means `orderId` can never be reused, including
after cancellation. If upstream generates ids with a narrow space or recycles
them, legitimate orders will be rejected as conflicts.

**Half-up rounding on the discount is a policy choice, not a neutral default.**
It rounds in the customer's favour by up to half a minor unit per line. It is
consistent and exact, but finance should confirm it matches the rest of the
system — mixed rounding policies across services are a classic reconciliation
defect. Tested for exactness, not for agreement with any external system.

**`Object.freeze` is shallow and not a security boundary.** It stops accidental
and casual mutation. It does not stop a caller that reaches into the class
through `as any` or prototype tricks. Treat it as an integrity guard against
mistakes, not against a hostile in-process actor.

**Error signalling is by `Error` with message text.** Callers wanting to
distinguish "insufficient stock" (retryable later) from "malformed order"
(never retryable) currently have to match on message strings. Typed error
classes would be the next improvement; I left it alone rather than change the
throw contract of every method in a single pass.

### What I deliberately did not change

**`reserve` still emits one movement per line, while `cancel` emits one per
SKU.** The per-line behaviour is documented in the original comment and is
plausibly relied on by consumers reading `getMovements()`. Netting is identical
either way, so I preserved the documented shape rather than "tidying" a contract
other code may depend on.

**`seq` remains globally increasing across all SKUs rather than per-SKU.** A
per-SKU sequence would arguably make `history` ranges more natural, but `seq` is
in the exported `Movement` type and any stored or transmitted movement carries
it. Renumbering would invalidate every persisted value. I documented the
semantics instead.

**`available()` still throws for an unknown SKU** rather than returning 0.
Existing behaviour, and the safer of the two: a typo surfacing as "zero stock"
is how phantom stockouts happen.

**`lineValue` still prices discontinued SKUs.** Historical and in-flight lines
need valuing after a SKU is withdrawn; refusing would break invoicing for
already-placed orders.

**`OrderService` gained no `cancel` passthrough.** The brief placed `cancel` on
`Inventory`; adding a second entry point would widen the API without being asked.

### Breaking changes to call out explicitly

1. `getMovements()` returns a **copy**. Callers mutating it to change stock no
   longer can.
2. `Catalog.add` **throws** on a duplicate id instead of overwriting.
3. `Sku` and `Movement` fields are `readonly` and frozen; assignment now fails.
4. `reserve` rejects input it previously accepted: zero/negative/fractional/
   `NaN` quantities, empty orders, discontinued SKUs, and order-id reuse with
   different lines. Each of these previously corrupted stock levels.
5. `lineValue` rejects `discountPct` outside `0..100` and returns an integer
   where it previously could return a fraction.

Items 4 and 5 are the ones most likely to surface latent bugs in callers: code
that has been quietly reserving zero or negative quantities will start throwing.
That is the intent — but it is worth a search of call sites before rollout.

---

## 3. Final test status

`npx vitest run`, run in this directory:

```
 RUN  v4.1.10 <repo>/runs/opus-5-3

 Test Files  1 passed (1)
      Tests  41 passed (41)
   Start at  15:54:10
   Duration  513ms (transform 121ms, setup 0ms, import 147ms, tests 21ms, environment 0ms)
```

41 passing, 0 failing: the 5 original tests (one of which failed on the
inherited code) plus 36 added here. `npx tsc --noEmit` is also clean under
`strict`.
