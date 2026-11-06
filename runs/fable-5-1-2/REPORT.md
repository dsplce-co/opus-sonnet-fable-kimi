# Stock-reservation module: production-readiness hand-back

Files touched: `types.ts`, `catalog.ts`, `inventory.ts`, `orders.ts`, `inventory.test.ts` (5 original tests kept verbatim, 35 added). Export names and file structure are unchanged. `Inventory` gained `cancel()` and `history()`.

Every defect below was reproduced against the original code with a throwaway probe before it was fixed; the observed values are quoted where they make the failure concrete.

## 1. Changes

### catalog.ts

| # | Root cause | Fix |
|---|-----------|-----|
| 1 | `discontinue()` assigned `"active"` instead of `"discontinued"`, so a SKU could never leave the active state (the one originally failing test). | Assign `"discontinued"`. Idempotent: repeated calls are a no-op. |
| 2 | `add()` did `Map.set` with no existence check. Re-adding an existing id silently replaced its record and reset `initial` underneath live reservations. Probe: SKU with 10 on hand and 5 reserved, re-added with `initial` 999, reported 994 available: phantom stock. | `add()` throws `sku already exists` on a duplicate id. |
| 3 | `add()` accepted any number for `initial` and `unitPrice`: negative, fractional, `NaN`, `Infinity`, values beyond the safe-integer range. Empty ids were accepted. | Both must be non-negative safe integers; id must be a non-empty string. Validation runs before anything is stored, so a rejected `add` leaves nothing behind. |
| 4 | `get()` and `add()` returned the internal mutable record. Any caller could set `initial`, `state` or `unitPrice` directly. Probe: setting `initial = 1e9` on the returned object made `available()` report 1e9. | Both return a shallow copy. The only way to change a SKU is through `Catalog` methods. **Breaking:** code that mutated the object returned by `get()` no longer affects the catalog. |

### inventory.ts

| # | Root cause | Fix |
|---|-----------|-----|
| 5 | `reserve()` was not atomic. Each line was checked and written inside the same loop, so when line 2 failed, line 1's movement had already been appended, with no order record to cancel it against. Probe: a two-line order that failed on the second line left 5 units permanently reserved and 1 orphan movement. | All lines are validated first (ids, quantities, SKU existence, lifecycle, stock); movements are written only after every check passes. A rejected order changes nothing. |
| 6 | No quantity validation. A negative qty became a positive movement and *created* stock (probe: qty −50 raised availability from 100 to 150). `NaN` passed the `qty > available` check (the comparison is false) and poisoned `available()` to `NaN` forever. Fractional, zero and `−Infinity` quantities were also accepted. | Line qty must be a positive safe integer. Line sku and orderId must be non-empty strings. `lines` must be a non-empty array of objects. |
| 7 | With validate-then-write, per-line stock checks would let `[{widget,60},{widget,60}]` through on 100 units, because each line is checked against the same untouched availability. | Stock is checked against the per-SKU **total** of the order. One movement per line is still written, so ledger granularity is unchanged. |
| 8 | SKU lifecycle was ignored: discontinued SKUs could still be reserved. | `reserve()` rejects any SKU whose state is not `active`. **Breaking** for callers relying on reserving discontinued stock. |
| 9 | Not safe to retry. Calling `reserve("o1", …)` twice (a retried request whose first response was lost) reserved the stock twice. | An order registry keyed by `orderId` makes the id an idempotency key: a replay whose per-SKU totals match the held reservation is a no-op; reusing an id with different lines, or an id that was cancelled, throws `order already exists`. Validation runs before the replay short-circuit, so garbage never passes as a retry. **Breaking:** reusing an orderId used to stack reservations. |
| 10 | `getMovements()` returned the live internal array and its entries were mutable. Probe: `getMovements().length = 0` wiped the ledger and availability jumped back to `initial`. | Returns a copy; every movement is `Object.freeze`d when written. `history()` follows the same rule. |
| 11 | `reserve()` read the caller's `lines` twice (validate, then write). A line whose `qty` is a getter could report `1` to validation and `1_000_000` to the ledger. | Lines are copied into plain objects during validation and only the copies are written. Covered by a test using exactly that getter. |
| 12 | `available()` scanned the whole ledger on every call, and every line of every `reserve()` calls it. | A per-SKU net-reserved tally is maintained in the single `append()` path; `available()` is O(1). The invariant `available == initial + Σ movements(sku)` is asserted after every operation in the tests. |
| 13 | Empty orders (`lines: []`) were silently accepted as a no-op. | Rejected. **Breaking**, deliberately: an empty order is almost certainly a caller bug and would otherwise occupy an orderId with nothing to cancel. |

### orders.ts

| # | Root cause | Fix |
|---|-----------|-----|
| 14 | `lineValue()` computed `gross − gross × (pct/100)` in floating point and returned fractional minor units (probe: 7 × 1999 at 7 % gave `13013.49` cents). Inputs were unchecked: a negative discount **added** value (−50 % on 1000 gave 1500), >100 % went negative, `NaN` propagated. | Integer formula `unitPrice × qty × (100 − pct)` (exact), then one division by 100 rounded **half-up** to the nearest minor unit. `discountPct` must be an integer in [0, 100]; `qty` a non-negative safe integer; the intermediate must stay within the safe-integer range or the call throws rather than return an imprecise amount. **Breaking:** previously fractional results are now rounded, and invalid inputs throw. |

### types.ts

| # | Root cause | Fix |
|---|-----------|-----|
| 15 | `Movement` was declared mutable although the comment calls the ledger append-only. | All four fields are `readonly`, matching the runtime freeze. |

### New capabilities (inventory.ts)

- **`cancel(orderId)`** returns every unit an order reserved, writing one positive movement per original reservation line (new seq numbers, same orderId). Atomic: the order's SKUs are re-checked against the catalog before any write. Idempotent: a second cancel is a no-op. Unknown or empty orderId throws. Lifecycle: discontinuation forbids *new* reservations only, so cancelling an order for a since-discontinued SKU still returns the stock (dropping it would lose stock); that stock then cannot be reserved again. A cancelled orderId cannot be re-reserved.
- **`history(sku, fromSeq, toSeq)`** returns that SKU's movements with `fromSeq ≤ seq ≤ toSeq`, in seq order, as a fresh array of frozen entries. Bounds may exceed the ledger or be `±Infinity`; an inverted range yields `[]`. Unknown SKU or `NaN` bound throws, consistent with `available()`.

### Summary of breaking changes

Duplicate `Catalog.add` throws; `Catalog.get`/`add` return copies; reserving a discontinued SKU throws; reusing an orderId no longer stacks (replay no-op or conflict error); empty orders throw; non-positive/non-integer quantities throw; `lineValue` rounds and validates. All are cases where the old behaviour lost, duplicated or corrupted stock or money.

## 2. Production-readiness review

### Remaining risks (not covered by tests)

- **No persistence or crash recovery.** Ledger, order registry and seq counter live in memory; a process crash loses every reservation, and seq restarts at 0 per instance. Before this controls real stock it needs durable, transactional storage (or a write-ahead log) and seq that survives restarts.
- **Single-process, synchronous atomicity only.** All-or-nothing behaviour relies on JavaScript's single thread and on every method being synchronous. Two processes, or an async wrapper that awaits between check and write, would reintroduce check-then-act races. There is no locking or versioning. Not testable in this module.
- **Unbounded order registry.** Idempotency requires remembering every orderId ever seen, so memory grows with order count. A real deployment needs a retention window or external idempotency store.
- **Only reservation and cancellation exist.** There is no way to receive stock, record shrinkage, or consume a reservation on shipment. `initial` is the only inflow, and because the O(1) tally assumes `initial` is immutable, any future "adjust stock" feature must go through `Inventory` (as a movement), never by editing the catalog record.
- **Catalog has no delete**, so the lifecycle re-check in `cancel()` cannot currently fail. It is there so that adding deletion later cannot silently break cancel.
- **Errors are plain `Error`s distinguished by message.** Callers cannot programmatically tell "insufficient stock" from "invalid input" without string matching (the tests do). A typed error hierarchy is an API decision for the module owners.
- **Rounding policy is half-up.** That is a defensible default but finance or tax rules may require a different policy (banker's rounding, per-jurisdiction rules). Confirm before invoicing from this number.
- **"Available" includes returned stock of discontinued SKUs**, which can never be reserved. Reporting may need a separate "sellable" figure.
- **`history()` is a linear filter** over the full ledger. Correct, but since seq is monotonic a binary search would be the upgrade if ledgers get large.
- **No property-based, fuzz, concurrency or persistence tests.** The suite is example-based; the ledger-balance invariant is checked on a handful of scripted sequences only.

### Deliberately not changed, and why

- **One movement per line** (not aggregated per SKU). Preserves the documented ledger granularity and existing behaviour; `cancel` mirrors it line for line. Stock checks use per-SKU totals, which is what matters for correctness.
- **`available()` throws for unknown SKUs.** Existing behaviour; `history()` was made consistent with it rather than returning `[]` and hiding typos.
- **`Sku` type stays mutable at the type level.** Only snapshots are handed out, so runtime is safe; making the fields `readonly` would break consumers that construct `Sku` objects, for no runtime gain.
- **`getMovements()` keeps its name and array shape.** It now returns a copy; nothing else changed.
- **`OrderService` gained no `cancel`.** Not requested; `Inventory.cancel` works for orders placed through it (tested).
- **`seq` still starts at 0 per instance.** Changing it is meaningless without persistence.
- **No persistence, locking or error classes were added.** Each is a design decision with API and infrastructure consequences that the owning team should make explicitly; they are listed above as risks rather than papered over.

## 3. Final test status

Real output of `npx vitest run` on the final code:

```
 RUN  v4.1.10 <repo>/runs/fable-5-1-2

 Test Files  1 passed (1)
      Tests  40 passed (40)
```

`npx tsc -p tsconfig.json` (strict) exits 0.
