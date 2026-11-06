# Stock reservation module — hardening handover

Scope: `types.ts`, `catalog.ts`, `inventory.ts`, `orders.ts`. File layout and exported
class names are unchanged. The inherited suite `inventory.test.ts` was left byte-for-byte
intact as a baseline; new coverage lives in `hardening.test.ts`.

Baseline on arrival: **1 of 5 tests failing**, plus nine further defects that the suite did
not exercise. Each defect below was reproduced with a failing assertion before being fixed.

---

## 1. Changes

### `catalog.ts`

**C1 — `discontinue()` set the state to `"active"`.**
Root cause: copy/paste of the literal in `add()`; a SKU could never leave the active state,
so every lifecycle rule downstream was unenforceable. This was the one failing inherited test.
Fix: set `"discontinued"`. The method is naturally idempotent.

**C2 — `add()` silently overwrote an existing SKU.**
Root cause: unconditional `Map.set`. Because `available()` is anchored on `initial`, re-adding
a SKU that already had movements against it reset the anchor and teleported availability
(observed: a fully reserved SKU jumping from 0 back to 10 units). Fix: reject a duplicate id.
IDs are now immutable once registered.

**C3 — No validation of `initial` / `unitPrice` / `id`.**
Root cause: arguments trusted. `NaN`, `Infinity`, fractions, negatives and empty ids all
entered the catalog and propagated into stock and money arithmetic. Fix: `assertId` and
`assertWholeNumber` (new, in `types.ts`) reject anything that is not a non-empty string /
non-negative exact integer, before any state is touched.

**C4 — `get()` and `add()` returned the live internal `Sku`.**
Root cause: reference leak. A caller could write `sku.initial = 999999` and move warehouse
availability directly — reproduced, availability went to 999,899. Fix: both return a frozen
copy; `Sku` is now a `readonly` interface, so TypeScript rejects the write and strict-mode ESM
throws at runtime. Mutation is only possible through `Catalog`'s own methods.

### `types.ts`

**T1 — Added the shared validation vocabulary** (`assertId`, `assertWholeNumber`) so every
public entry point validates identically, and `Mutable<T>` for the internal writable view.
`Sku` and `Movement` are now deeply `readonly`. Rationale: validation duplicated per call site
drifts; one helper does not.

### `inventory.ts`

**I1 — `reserve()` was not atomic.**
Root cause: the loop checked and pushed one line at a time, so a failure on line *n* left lines
`1..n-1` permanently committed with no order record to undo them. Reproduced: a two-line order
failing on line 2 left 5 units reserved and unreleasable — silent stock loss. Fix: all lines are
normalised and checked against availability first; nothing is written unless the whole order
passes. A rejected `reserve` now leaves zero movements.

**I2 — `reserve()` was not idempotent.**
Root cause: no record of which orders existed, so a client retry after a timeout reserved the
stock a second time (observed: 100 → 40 instead of 70). Fix: a per-order ledger. An exact replay
of a live reservation is a no-op; reusing an order id with *different* lines is rejected rather
than silently applied; re-reserving a cancelled order id is rejected.

**I3 — `reserve()` accepted quantities that minted or destroyed stock.**
Root cause: only `qty > available` was checked. A negative qty inverted to a *positive* movement
and created stock from nothing; `NaN` passed the comparison (`NaN > x` is `false`) and poisoned
availability to `NaN` permanently; fractions broke the whole-units invariant. Fix: every qty must
be an exact integer ≥ 1 within safe-integer range, and the per-SKU total is re-checked after
summing so duplicate lines cannot overflow past `Number.MAX_SAFE_INTEGER`.

**I4 — Duplicate lines for one SKU were checked in isolation.**
Root cause: each line was compared against availability as it was pushed. Fix: lines are folded
into net demand per SKU before the check, so an order for 6 + 6 units of a 10-unit SKU is
rejected as 12, not accepted as two independent 6s. *Behaviour change:* `reserve` now writes one
movement per distinct SKU rather than one per line (see §2).

**I5 — SKU lifecycle was not enforced.**
Root cause: `reserve` called `catalog.get()` only to assert existence and ignored `state`.
Discontinued SKUs were freely reservable. Fix: reserving a non-active SKU is rejected.

**I6 — `getMovements()` returned the internal array by reference.**
Root cause: reference leak. A caller could `push` a forged movement or rewrite an existing one
and move availability arbitrarily. Fix: returns a copy; every movement is frozen at write time.

**I7 — `available()` was an O(n) scan of an unbounded append-only log.**
Fix: a per-SKU net aggregate maintained by `commit()`, the single writer that appends the
movement and moves the aggregate together, so the log and the aggregate cannot drift apart.
`hardening.test.ts` asserts `available() === initial + Σ movements` as a standing invariant.

**I8 — New: `cancel(orderId)`.** Returns an order's stock to availability. Atomic (the whole
order is validated before any movement is written). Idempotent (a second call is a no-op, so a
retry cannot return the same stock twice). Cancelling an unknown order id throws, because that is
a caller bug rather than a retry. Writes positive movements — the log stays append-only, nothing
is erased. Lifecycle handling is a deliberate asymmetry, called out in §2.

**I9 — New: `history(sku, fromSeq, toSeq)`.** That SKU's movements within the inclusive
`[fromSeq, toSeq]` range, in recorded order, as frozen objects in a fresh array. Unknown SKU,
non-integer/negative bounds, and an inverted range (`fromSeq > toSeq`) all throw.

### `orders.ts`

**O1 — `lineValue()` returned fractional money.**
Root cause: `gross - gross * (discountPct / 100)` in float. With `unitPrice` 999, qty 3, 10% off
it returned `2697.3000000000002` — a non-integer in a field documented as integer minor units,
which would then be summed, stored and reconciled against real payments. Fix: round the *discount*
to a whole minor unit and subtract it, which keeps the result an exact integer and makes 0% return
the full gross and 100% return exactly 0.

**O2 — `lineValue()` accepted any discount.**
Root cause: no range check. `-100` inflated the line to 200% of gross; `500` returned a large
negative value — a credit. Fix: `discountPct` must be a whole number in `[0, 100]`, `qty` a
non-negative integer, and the gross is rejected if it exceeds safe-integer range rather than
silently returning an inexact number.

**O3 — Added `cancel()`** as the service-level counterpart to `place()`, delegating to
`Inventory.cancel`.

### Deliberate breaking changes

Called out explicitly because callers may depend on the old behaviour:

1. `Catalog.add` on an existing id now **throws** instead of replacing the entry.
2. `Catalog.get`/`add` return **frozen copies**; code that mutated the returned `Sku` now throws.
3. `Inventory.reserve` now **rejects discontinued SKUs**.
4. `Inventory.reserve` writes **one movement per distinct SKU**, not per line, and rejects empty
   line arrays. Anything that counted movements to infer line count is affected.
5. `Inventory.getMovements` returns a **copy**; code that mutated it to adjust stock is broken by
   design.
6. `OrderService.lineValue` returns a **rounded integer** and throws on out-of-range input, so
   totals may differ from the old float results by sub-unit amounts.

All six trade a silent data-integrity failure for a loud error. I would ship them, but each is a
caller-visible change and belongs in the release note.

---

## 2. Production-readiness review

### Deliberate design decisions

**Cancelling a discontinued SKU is allowed.** `reserve` refuses a non-active SKU, but `cancel`
accepts one. The asymmetry is intentional: `discontinued` means "no new reservations", not "this
stock ceases to exist". Refusing the return would pin the cancelled order's units in the reserved
state forever — the exact stock loss this module exists to prevent. `cancel` still validates that
every SKU on the order resolves in the catalog before writing anything, so lifecycle is enforced
where it can be enforced without destroying stock.

**Re-reserving a cancelled order id throws rather than succeeding.** Silently reviving a cancelled
order would make the reservation state depend on call ordering. A new reservation should get a new
id.

**Replaying a reserve for a since-discontinued SKU succeeds as a no-op.** The idempotency check
runs before the lifecycle check, by design: a retry of an already-committed reservation must not
start failing because the SKU's lifecycle moved on afterwards. Only *new* reservations are gated.

**An inverted `history` range throws rather than returning `[]`.** `fromSeq > toSeq` cannot
describe a valid inclusive window, so it is a caller bug and should be loud. An empty result is
still returned for a valid range that happens to contain nothing.

### Remaining risks — not covered by tests

**No concurrency control beyond the JS event loop.** Every method is synchronous, so a single call
cannot interleave. That guarantee ends at this module's edge: two processes, or one process with a
database behind it, will race on check-then-write. `reserve`'s "check availability, then commit" is
only atomic *within* one synchronous call. Before this controls real stock, the reservation must
land in a store with a real transaction and a uniqueness constraint on `orderId` — the in-process
ledger is not a substitute. **This is the single largest gap.**

**No persistence.** All state is in memory. A restart loses every reservation and every movement,
and availability silently resets to `initial`. The `Movement` log is shaped like an event log and
could be the source of truth, but nothing currently writes it anywhere.

**Unbounded memory.** Both `movements` and the order ledger grow forever; nothing is compacted or
evicted. At warehouse volume this is a slow leak. Deliberately not addressed: any eviction policy
has to be designed together with persistence, and evicting an order record would silently destroy
the idempotency guarantee.

**`history` is a full scan.** O(total movements) per call, not O(result). Correct but linear;
it will need a per-SKU index or a store-side query before it is called on a hot path.

**`available()` allocates.** It goes through `catalog.get()`, which builds and freezes a copy on
every call. Deliberate: I chose encapsulation over allocation. If it shows up in a profile, the
fix is an internal accessor, not relaxing the copy.

**`seq` is per-`Inventory`, starting at 0.** It is unique and monotonic within one instance only.
It is not a global identifier and will collide across instances or across a restart. Left as-is
because changing it is meaningless until persistence exists — but callers must not treat it as a
durable key.

**Partial cancellation is not supported.** `cancel` is all-or-nothing for the whole order. Real
warehouse flows usually need per-line cancellation and partial fulfilment. Deliberately out of
scope — it changes the order model, not just this method.

**No fulfilment/shipping state.** Stock is either available or reserved; there is no notion of
stock leaving the building. A cancel today returns stock that may physically have shipped. This
module cannot detect that, and the `Movement` sign convention (negative = reserved, positive =
returned) has no third state for it.

**Rounding is half-away-from-zero, applied per line.** `Math.round` on the discount. Summing
rounded lines will not always equal rounding the summed order — a real reconciliation
discrepancy at scale. The current rule is at least exact, documented and consistent; picking
between per-line and per-order rounding is a finance decision, not an engineering one, so I did
not make it unilaterally.

**Money has no currency.** `unitPrice` is a bare integer. Nothing prevents mixing currencies
across SKUs in one order total.

### What I deliberately did not change

- **`inventory.test.ts`** — left exactly as inherited, so the original suite keeps working as a
  regression baseline against my own assumptions.
- **The `Movement` sign convention and field names** — the existing contract is sound and likely
  has consumers.
- **`seq` starting at 0** — see above; renumbering has no benefit without durable identity.
- **`Line` as a mutable interface** — it is caller-owned input, and `reserve` copies it into
  internal state immediately, so later mutation by the caller cannot affect us.
- **Whitespace-only ids** (`" "`) are accepted — they are non-empty strings and used consistently
  as keys. Trimming or rejecting them risks breaking legitimate upstream id schemes.
- **`Map` rather than plain objects for all keyed state** — kept, and worth noting: it means a SKU
  or order id of `__proto__` or `constructor` is handled as ordinary data, so there is no
  prototype-pollution path through user-supplied ids.

---

## 3. Final test status

Real output of `npx vitest run` in this directory:

```
 RUN  v4.1.10 <repo>/runs/opus-5-2

 Test Files  2 passed (2)
      Tests  38 passed (38)
   Start at  15:45:22
   Duration  1.17s (transform 329ms, setup 0ms, import 411ms, tests 50ms, environment 0ms)
```

- `inventory.test.ts` — 5 passed (inherited suite, unmodified; 1 was failing on arrival).
- `hardening.test.ts` — 33 passed (new: validation, atomicity, idempotency, lifecycle,
  encapsulation, `cancel`, `history`, monetary arithmetic, and the
  `available() === initial + Σ movements` invariant).

`npx tsc --noEmit` is also clean under `strict: true`.
