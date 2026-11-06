# Stock-reservation module — handover report

## 1. Changes

| # | File | Root cause | Fix |
|---|------|-----------|-----|
| 1 | `catalog.ts` | `discontinue()` assigned `state = "active"` — a typo that made discontinuation a no-op (and would silently *revive* a SKU). | Assign `"discontinued"`. |
| 2 | `catalog.ts` | `add()` silently overwrote an existing SKU id, orphaning any inventory movements recorded against the old definition. | `add()` throws on duplicate id. |
| 3 | `catalog.ts` | No validation: negative/fractional/NaN `initial` or `unitPrice` poisoned every downstream quantity and money computation. | `add()` validates non-empty string id, non-negative integer `initial` and `unitPrice`. |
| 4 | `catalog.ts` | `get()` and `add()` returned the live internal `Sku` record, so any caller could rewrite `initial`, `unitPrice`, or `state` and corrupt availability math. | Internal mutation goes through a private `lookup()`; public `get()`/`add()` return shallow copies. |
| 5 | `inventory.ts` | `reserve()` validated and committed line-by-line, so a multi-line order failing on line N left lines 1..N-1 reserved — stock stranded against an order that "failed". | Two-phase reserve: validate everything (ids, quantities, SKU existence/lifecycle, aggregated availability) first, then commit movements in a section that cannot throw. A rejected order reserves nothing and its orderId stays reusable. |
| 6 | `inventory.ts` | No quantity validation: a negative `qty` pushed a *positive* movement (fabricating stock); fractional/NaN/Infinity quantities corrupted the ledger and made `available()` meaningless. | Every line's `qty` must be a positive integer; orderId must be a non-empty string; the lines array must be non-empty. |
| 7 | `inventory.ts` | No per-order identity: retrying a `reserve` (client timeout, queue redelivery) double-reserved stock. | Reservations are recorded per `orderId`. An exact retry (same lines, any order) is a no-op; the same id with different lines throws. Retries can never double-reserve. |
| 8 | `inventory.ts` | Multiple lines for the same SKU were each checked against availability independently, so `60 + 60` against 100 on-hand could oversell (and previously half-commit). | Demand is aggregated per SKU and checked once against `available()`. |
| 9 | `inventory.ts` | SKU lifecycle ignored: discontinued SKUs remained reservable. | `reserve()` throws for discontinued SKUs. **Breaking change:** callers that relied on reserving discontinued stock will now get an error. |
| 10 | `inventory.ts` | `getMovements()` returned the live ledger array; callers could push/splice/rewrite movements and drive availability negative or fabricate stock. | Returns copies of the movement records. |
| 11 | `inventory.ts` | (new capability) | `cancel(orderId)`: appends positive return-movements for all of the order's lines in a section that cannot throw (atomic), then marks the order cancelled. Idempotent — a second cancel is a no-op; an unknown orderId throws. Works on discontinued SKUs (stock returns but cannot be re-reserved, per #9). |
| 12 | `inventory.ts` | (new capability) | `history(sku, fromSeq, toSeq)`: returns copies of that SKU's movements with `seq` in the inclusive range; throws on unknown SKU, non-integer bounds, or `fromSeq > toSeq`. |
| 13 | `orders.ts` | `lineValue()` computed `gross - gross * (pct / 100)` in floating point, producing fractional minor units (e.g. 33% off 500 → 334.99999999999997) — unusable for money. | Integer arithmetic: `discount = Math.round(gross * pct / 100)`, result `gross - discount`, always an integer. Rounding policy: discount rounded to nearest minor unit, half-up. |
| 14 | `orders.ts` | No validation: negative discounts inflated value, >100% made it negative, fractional/negative quantities produced fractional money. | `qty` must be a non-negative integer; `discountPct` must be finite and within [0, 100]. |
| 15 | `inventory.test.ts` | Test suite did not cover any of the above. | Added 22 tests covering atomicity, validation, idempotent reserve/cancel, lifecycle rules, encapsulation, `history` range semantics, and integer money math. Original 5 tests unchanged. |

File/export structure is unchanged: same files, same exported class names (`Catalog`, `Inventory`, `OrderService`), same existing method signatures. New surface: `Inventory.cancel`, `Inventory.history`.

## 2. Production-readiness review

**Remaining risks and honest limitations**

- **In-memory only.** All state (movements, orders, catalog) lives in process memory. A crash loses every reservation; there is no persistence, snapshot, or WAL. For real warehouse stock this module must sit behind a durable event store — the append-only `Movement` ledger was clearly designed for that, but the replay/persistence layer does not exist here.
- **Single-threaded assumption.** Atomicity of `reserve`/`cancel` rests on JavaScript's run-to-completion semantics: the commit loops contain no `await` and nothing that can throw. That holds today, but a future maintainer adding an async call (e.g. a catalog lookup becoming async) inside those sections would silently break atomicity. This is documented in the code comments but not enforceable by the type system.
- **No cross-instance coordination.** Two processes sharing one warehouse would each keep their own ledger and oversell. There is no locking, fencing, or optimistic-concurrency token.
- **Unbounded growth.** `movements` and `orders` grow forever, and `available()` is O(total movements) per call, so `reserve` is O(lines × movements). Fine at this scale; at production volume it needs a per-SKU running balance and movement compaction/snapshotting.
- **`Catalog.get` returns copies, but `Sku` is shallow.** A future nested field would leak. Today all fields are primitives, so the copy is sufficient.
- **`lineValue` rounding at exact half-minor-unit boundaries** depends on floating-point representation for fractional percents (e.g. 29.995%). Integer percents are exact; exotic fractional percents near a .5 boundary could round either way. If the business needs guaranteed behavior there, discount should be computed in basis points with an explicit rounding mode.
- **Idempotent-retry semantics for `cancel`:** cancelling an order that *this instance* never saw throws, but after a restart with an empty ledger there is no way to distinguish "never existed" from "already cancelled" — another consequence of the missing persistence layer.
- **`orderId` reuse after cancel** throws ("order already exists") rather than silently re-reserving. Deliberate: reusing a cancelled order id is almost always a caller bug, and silent acceptance could mask duplicate-order bugs upstream.
- **Not covered by tests:** concurrent interleavings (not meaningful single-threaded, but no regression guard if the API becomes async), persistence/replay (doesn't exist), and performance under large ledgers.

**Deliberately NOT changed**

- **`available()`'s fold-over-movements implementation.** O(n) but simple and obviously correct; the ledger is the source of truth. A cached balance would be a premature optimization and a new corruption vector.
- **`Catalog.discontinue` on an already-discontinued SKU** is a harmless no-op; making it throw would add a failure mode without protecting anything.
- **`OrderService.place` signature.** Validation lives in `Inventory.reserve`, which is the right single chokepoint — every reservation path gets it.
- **Movement `seq` starts at 0.** Internally consistent; changing it would break any consumer of `history` ranges.

**Breaking changes introduced (called out per instructions)**

1. `reserve()` now throws for discontinued SKUs (was allowed).
2. `reserve()` now throws for non-positive/non-integer quantities, empty line arrays, and duplicate orderIds with different lines (was accepted/double-reserved).
3. `Catalog.add()` now throws for duplicate ids and invalid `initial`/`unitPrice` (was silent overwrite/acceptance).
4. `Catalog.get()`/`add()` and `Inventory.getMovements()`/`history()` return copies, not live references — code that mutated those objects to change state will no longer have any effect (that mutation was always corruption, but it is observable).
5. `lineValue()` now rounds to integer minor units and rejects out-of-range discounts.

## 3. Final test status

```
$ npx vitest run

 Test Files  1 passed (1)
      Tests  27 passed (27)
```

(5 original tests — all passing, unchanged — plus 22 added tests. `npx tsc --noEmit` is clean under `strict`.)
