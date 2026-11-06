# Stock reservation module — handover report

Scope: `types.ts`, `catalog.ts`, `inventory.ts`, `orders.ts`, `inventory.test.ts`.
File and export structure is unchanged; `cancel` and `history` were added as
methods on the existing `Inventory` class.

---

## 1. Changes

Each defect below was reproduced against the original code before being fixed.
The reproductions are now regression tests in `inventory.test.ts` (the original
five tests are unchanged and still pass).

### 1.1 `catalog.ts` — `discontinue` set the wrong state

**Root cause.** `discontinue(id)` assigned `state = "active"` instead of
`"discontinued"`, so the call was a silent no-op. This was the one defect the
existing suite already caught.

**Fix.** Assign `"discontinued"`. The method is idempotent, so retrying it is
safe. Because nothing downstream checked SKU state either (§1.5), this bug had
been masking a second one.

### 1.2 `catalog.ts` — `add` silently redefined a live SKU

**Root cause.** `add` did `bySku.set(id, sku)` unconditionally. `Inventory.available`
is derived as `initial + sum(movements)`, so re-adding a SKU that already had
movements retroactively rewrote the baseline the ledger was measured against.
Reproduced: 10 on hand, reserve 5, re-add with `initial: 3` → **availability −2**.
Stock was created or destroyed with no movement recorded.

**Fix.** `add` throws on an existing id. Redefining live stock is a deliberate,
auditable operation, not a side effect of registration.

### 1.3 `catalog.ts` — internal SKU records were handed out live

**Root cause.** `get` returned the stored object by reference. Any caller could
write `catalog.get(id).initial = 1e9` or flip `state` back to `"active"`,
corrupting stock arithmetic from outside the module with no audit trail.
Reproduced: external assignment changed `initial` to 1,000,000,000.

**Fix.** `get` and `add` return a frozen shallow copy; a new private `lookup`
holds the only live reference. Mutating the returned object now throws
(ES modules are strict mode) instead of silently succeeding.

### 1.4 `catalog.ts` — no input validation

**Root cause.** `initial` and `unitPrice` were typed `number`, which at runtime
admits `NaN`, `Infinity`, fractions and negatives. TypeScript types are erased,
and callers may be untyped (JSON bodies, JS callers, `any`).

**Fix.** `add` validates the id is a non-empty string and that `initial` and
`unitPrice` are non-negative safe integers, via the shared guards added to
`types.ts` (`assertId`, `assertNonNegativeQty`, `assertPositiveQty`,
`assertSafeInteger`). Values are bounded by `Number.MAX_SAFE_INTEGER` so that
integer sums stay exact.

### 1.5 `inventory.ts` — `reserve` was not atomic (stock lost on failure)

**Root cause.** The loop validated and appended one line at a time. When a later
line failed, the movements already pushed for earlier lines stayed in the ledger.
Reproduced: `reserve("o1", [{a,10},{b,99}])` with `b` short threw
`insufficient stock for b` and left **10 units of `a` reserved to a non-existent
order** — permanently lost, with no order to cancel.

**Fix.** Split into a validation phase and a commit phase. Every line is checked
against the catalog, the SKU lifecycle and availability before anything is
written; the write goes through a single private `commit`, which projects the
whole batch and only mutates once every entry is known to be safe. Nothing
between the projection and the mutation can throw, so a batch is all-or-nothing.
`commit` is the sole writer of both the ledger and the availability index.

### 1.6 `inventory.ts` — per-line checks let an order oversell a SKU

**Root cause.** Each line was compared against `available()` independently, so an
order listing the same SKU twice could reserve it twice over.

**Fix.** Demand is summed per SKU across all lines and the *total* is checked
against availability. The ledger shape is unchanged — still one movement per
input line; only the validation aggregates.

### 1.7 `inventory.ts` — `reserve` accepted quantities that corrupted the ledger

**Root cause.** `line.qty` was used unchecked, and the movement stored `-line.qty`.
Reproduced:
- **negative qty minted stock** — `qty: -50` against 10 on hand produced a
  `+50` movement and availability of **60**; the guard `qty > available` passes
  trivially for negatives.
- **`NaN` poisoned the ledger permanently** — `NaN > available` is `false`, so
  the check passed, and every subsequent availability total for that SKU was
  `NaN` forever.
- fractional (`0.5` → availability `9.5`) and zero quantities were accepted.

**Fix.** `normalizeLines` requires a non-empty array of objects with a non-empty
`sku` and a `qty` that is a positive whole safe integer. Empty orders and empty
identifiers are rejected.

### 1.8 `inventory.ts` — SKU lifecycle was never enforced

**Root cause.** `reserve` called `catalog.get(line.sku)` only to assert existence
and discarded the result, so discontinued SKUs remained fully reservable.

**Fix.** `reserve` rejects any SKU whose state is not `"active"`. `cancel`
applies the same check (§1.11).

### 1.9 `inventory.ts` — `reserve` was not safe to retry

**Root cause.** No order identity was tracked. A client retrying after a timeout
reserved the stock a second time. Reproduced: two identical `reserve("o1", …)`
calls produced two movements and double-booked the stock.

**Fix.** Orders are recorded in an `orders` map. Replaying an identical
reservation for the same `orderId` is a no-op; reusing an `orderId` with
different lines, or for an order that was cancelled, throws. Retries are safe
and double-booking is impossible.

### 1.10 `inventory.ts` — `getMovements` exposed the live ledger

**Root cause.** It returned the internal array by reference. Reproduced: a caller
pushed one movement and drove availability to **−995**.

**Fix.** Returns per-movement copies. The caller's lines are also defensively
copied and frozen at `reserve` time, so mutating the array afterwards cannot
change what `cancel` later returns.

### 1.11 `inventory.ts` — new: `cancel(orderId)`

Returns an order's reserved stock to availability by appending compensating
positive movements — the ledger stays append-only, nothing is deleted.

- **Atomic** — every SKU in the order is checked for lifecycle state before any
  stock is returned, so a multi-line order containing a discontinued SKU returns
  nothing at all and stays reserved.
- **Respects SKU lifecycle** — cancelling into a discontinued SKU is refused, so
  stock cannot reappear as available for something no longer stocked. See §2.1
  for the cost of this choice.
- **Safe to call more than once** — a cancelled order cancels again as a no-op,
  so a retried cancel cannot return the same stock twice. An *unknown* order id
  throws rather than no-ops: that means the caller has the wrong id, which is a
  different failure from a duplicate delivery.

### 1.12 `inventory.ts` — new: `history(sku, fromSeq, toSeq)`

Returns that SKU's movements with `seq` in the **inclusive** `[fromSeq, toSeq]`
range, in ledger order, as copies. Bounds must be safe integers; an inverted
range returns `[]` rather than throwing, so paging loops terminate cleanly. An
unknown SKU throws. History stays readable for discontinued SKUs — the lifecycle
restricts what you may *do* to stock, not what you may *audit*.

### 1.13 `inventory.ts` — `available` rescanned the whole ledger

**Root cause.** `available` summed every movement ever recorded, and `reserve`
called it once per line — O(lines × ledger), degrading without bound as the
ledger grows.

**Fix.** An incrementally maintained `availableBySku` index, written only by
`commit`. This is only sound because §1.2 and §1.3 stop `initial` changing
underneath it. A test cross-checks the cached value against a full replay of the
ledger.

### 1.14 `orders.ts` — `lineValue` returned fractional money

**Root cause.** `gross - gross * (discountPct / 100)` is floating-point.
Reproduced: 3 × 999 less 10% → **2697.3**; 999 less 33% → **669.3299999999999**.
Money that is not a whole number of minor units cannot be charged, and such
values accumulate binary rounding error when summed across a basket.

**Fix.** Integer-only arithmetic: the discount is computed as
`Math.round(gross * discountPct / 100)` and subtracted from `gross`. All
intermediate values are asserted to be safe integers, so an overflowing
`unitPrice × qty` fails loudly instead of silently losing precision.
**Rounding policy: the discount is rounded half-up to the nearest minor unit,
then subtracted** (see §2.5).

### 1.15 `orders.ts` — `lineValue` accepted out-of-range discounts

**Root cause.** `discountPct` was unvalidated. Reproduced: `-100` **inflated**
the line to double list price. A value above 100 would have produced a negative
line value, i.e. a refund.

**Fix.** `discountPct` must be a whole number in `[0, 100]`; `qty` must be a
positive whole number.

---

## 2. Production-readiness review

### Remaining risks

**2.1 Cancelling into a discontinued SKU strands stock permanently.** *(the most
important limitation)* `cancel` refuses when any SKU on the order is no longer
active, and `Catalog` has no `reactivate`. So if a SKU is discontinued while
orders against it are still open, that reserved stock can never be returned to
availability through this API. This is a deliberate trade-off: the alternative —
silently making a discontinued SKU available again — is worse, because it
resurrects sellable stock for something the business has withdrawn. The gap is
real and needs an operational answer (a supervised `reactivate`, or a
force-cancel with an audit reason). It is covered by a test asserting the
*refusal*, not the recovery, because there is no recovery path yet.

**2.2 No concurrency control.** `reserve`'s check-then-commit is atomic only
because it is fully synchronous under a single-threaded event loop. There is no
lock, version or compare-and-set. The moment anyone adds an `await` inside it, or
runs two processes against shared state, the time-of-check/time-of-use window
opens and two orders can both pass the availability check and oversell. **Not
covered by tests** — it is not reachable from single-threaded vitest. This is the
first thing to address before this module backs a real warehouse.

**2.3 No durability.** All state is in memory. A process restart loses the entire
ledger, every order record and the availability index. The module is written
*like* an event-sourced ledger but has no persistence, no write-ahead log and no
recovery path. Note also that `orders` (id → lines, status) is separate state
from `movements`: rebuilding from a persisted ledger alone would require
re-deriving order status from compensating movements, which is not implemented.
**Not covered by tests.**

**2.4 Unbounded growth and linear history scans.** `movements` and `orders` grow
forever — no archival, compaction or snapshotting. `history` scans the whole
ledger per call (there is no per-SKU index), so audit queries get slower as
volume grows. Correct, but it will not hold at warehouse scale indefinitely.

**2.5 The rounding policy is a business decision I made, not one I was given.**
Half-up on the discount amount is a defensible retail default, but finance may
require banker's rounding, or rounding the net rather than the discount. It is
documented in code and covered by an explicit test so the choice is visible and
cheap to change — but it should be confirmed with whoever owns pricing.

**2.6 Pricing and stock are not connected.** `lineValue` is a pure calculation
with no link to a reservation: nothing guarantees the quantity priced is the
quantity reserved. There is no order total, no multi-line pricing, no tax, and no
currency on `unitPrice` — a mixed-currency catalog would silently add unlike
amounts.

**2.7 There is no fulfilment state.** Reservations are held until explicitly
cancelled: there is no ship/commit transition and no expiry, so an abandoned
order holds stock forever. Relatedly, `available` conflates "on hand" with
"unreserved" — there is only one number, so you cannot distinguish stock that is
physically present from stock that is spoken for.

**2.8 There is no way to add stock.** `initial` is fixed at registration and the
only positive movements come from cancels. Receiving, restocking, stock takes and
damage write-offs have no API. Real warehouses need these, and the
`Movement.orderId` field assumes every movement belongs to an order, which such
adjustments would not.

**2.9 Errors are untyped.** Callers must string-match messages to tell a
retryable business condition (`insufficient stock`) from a programming error
(`no such sku`). Typed error classes would be better; I left the shape alone to
avoid changing the public surface (§2.13).

**2.10 The availability index duplicates derived state.** It is consistent today
because `commit` is its only writer and `Catalog` is now immutable, and a test
cross-checks it against a full ledger replay. But it is a second source of truth:
any future code that appends to `movements` directly would desync it silently.
The invariant is enforced by convention plus one test, not by the type system.

**2.11 Order line identity is positional.** Retry detection compares lines
pairwise in order, so the same basket submitted with its lines in a different
sequence is treated as a *different* order and rejected rather than recognised as
a replay. Safe (it fails closed), but it may surprise a client that does not
preserve ordering.

**2.12 Frozen objects are a shallow, in-process guard.** `Object.freeze` protects
the returned snapshot only; it is not a security boundary against code running in
the same realm, which can still reach private fields via `any` casts.

### Deliberately not changed

- **One movement per input line** was kept, rather than collapsing duplicate SKU
  lines into a single movement. It matches the documented ledger shape and keeps
  `cancel` a clean mirror of `reserve`; only validation aggregates (§1.6).
- **`available()` semantics** (`initial + Σ movements`) were kept. Splitting
  on-hand from reserved (§2.7) is a data-model change, not a bug fix.
- **`getMovements()`'s name and array return type** were kept — only the aliasing
  was fixed — so existing callers keep working.
- **No `reactivate()` on `Catalog`** (§2.1): reversing a discontinuation is a
  business decision that needs an owner and an audit trail, not something to
  invent during a bug-fix pass.
- **Nothing made async or persistent** (§2.2, §2.3): that is an architectural
  change well beyond this module's boundary.
- **`place`'s signature** is unchanged; it delegates to `reserve` and inherits
  its guarantees.

### Breaking changes (intentional)

Each one converts silent corruption into a loud failure. Callers relying on the
old behaviour will now throw:

1. `Catalog.get()` returns a frozen copy — mutating the result throws. Code doing
   `catalog.get(id).state = "discontinued"` must call `discontinue(id)`.
2. `Catalog.add()` throws on a duplicate id instead of overwriting.
3. `Catalog.add()` rejects negative/fractional/non-finite `initial` or `unitPrice`.
4. `Inventory.getMovements()` returns copies; mutating them no longer affects state.
5. `Inventory.reserve()` rejects quantities ≤ 0, fractional or non-finite,
   empty orders, discontinued SKUs, and duplicate/reused order ids. Anything that
   passed a negative quantity to *add* stock will now fail — that was never a
   supported operation (§2.8).
6. `OrderService.lineValue()` returns an integer and throws for `discountPct`
   outside `[0, 100]` or a non-positive/fractional `qty`. Callers that consumed
   fractional minor units will see different (correct) values.
7. `Catalog.discontinue()` now actually discontinues. Any code that depended on
   it being a no-op will observe a behaviour change — this is the original bug.

---

## 3. Final test status

Command: `npx vitest run`

```
 RUN  v4.1.10 <repo>/runs/opus-5-1

 Test Files  1 passed (1)
      Tests  43 passed (43)
   Start at  15:34:18
   Duration  238ms (transform 57ms, setup 0ms, import 75ms, tests 18ms, environment 0ms)
```

43 tests pass: the original 5 unchanged, plus 38 added covering catalog
integrity, reserve atomicity, input validation, lifecycle enforcement, retry
safety, encapsulation, `cancel`, `history`, monetary arithmetic and ledger
invariants. `npx tsc --noEmit` is also clean.
