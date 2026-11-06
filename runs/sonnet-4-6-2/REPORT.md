# Production-Readiness Report

## 1. Changes

### `catalog.ts` — `discontinue()` sets wrong state
**Root cause:** `this.get(id).state = "active"` — the assignment literal was wrong.  
**Fix:** Changed to `"discontinued"`.

---

### `inventory.ts` — `reserve()` is not atomic
**Root cause:** Each line was validated and immediately pushed to `this.movements` inside the same loop. If validation passed for line N and threw on line N+1, lines 0…N were already committed. Stock was removed from availability with no complete order record, making it unrecoverable.  
**Fix:** Split into two passes — validate all lines into a `pending` array first, commit atomically only after all pass.

---

### `inventory.ts` — `reserve()` allows negative / zero qty
**Root cause:** No input validation on `line.qty`. A caller passing `qty: -50` would generate a movement with `qty: +50`, effectively injecting stock. Zero qty would create a spurious movement record.  
**Fix:** Added `Number.isInteger(line.qty) && line.qty > 0` guard; throws on invalid input.

---

### `inventory.ts` — `reserve()` ignores SKU lifecycle state
**Root cause:** `this.catalog.get(line.sku)` was called but the returned `Sku` object was discarded. Discontinued SKUs could still be reserved.  
**Fix:** The result is now assigned and `sku.state !== "active"` causes a throw before any stock is touched.

---

### `inventory.ts` — `reserve()` is not idempotent
**Root cause:** Calling `reserve("o1", lines)` twice would push two full sets of movements, double-booking the stock.  
**Fix:** Added an early-return idempotency guard — if any movement already carries `orderId`, the call is a no-op.

---

### `inventory.ts` — `reserve()` allows duplicate SKUs in a single `lines` array to over-draw stock
**Root cause:** The per-line availability check called `this.available(sku)`, which only accounts for committed movements. Two entries for the same SKU in one `lines` call each passed the check independently but together exceeded available stock.  
**Fix:** `pendingDraw` accumulates qty already claimed by earlier lines in the same call; the check uses `line.qty + alreadyPending > this.available(line.sku)`.

---

### `inventory.ts` — `getMovements()` exposes internal array
**Root cause:** Returned `this.movements` directly. Any caller could `push`, `splice`, or otherwise corrupt the canonical movement log.  
**Fix:** Returns `[...this.movements]` — a shallow copy.

---

### `orders.ts` — `lineValue()` produces fractional minor-unit amounts
**Root cause:** `gross - gross * (discountPct / 100)` uses floating-point division. For some inputs (e.g. `gross=10, discountPct=10`) JavaScript produces `10 - 1.0000000000000002 = 8.999...` rather than `9`.  
**Fix:** `gross - Math.round(gross * discountPct / 100)` — all arithmetic stays in integers.

---

### New: `Inventory.cancel(orderId)`
Cancels a previously reserved order by pushing positive-qty reversal movements, one per reserved line.  
- Idempotent: if the orderId has no reservations (never placed, or already cancelled), the call is a no-op.  
- Atomic: all reversal movements are assembled before any are pushed; a future exception cannot leave a partial reversal.  
- SKU lifecycle: does not block on discontinued state — cancellation returns existing stock regardless; discontinuation governs new reservations only.

---

### New: `Inventory.history(sku, fromSeq, toSeq)`
Returns all movements for `sku` whose `seq` is within `[fromSeq, toSeq]` inclusive. Calls `catalog.get(sku)` first, which throws for unknown SKUs (consistent with `available()`). Returns a filtered subset of the internal array (no defensive copy needed — `Movement` objects are plain data and `seq` is assigned once).

---

## 2. Production-Readiness Review

### Risks the tests do NOT cover

**`available()` is O(n) in total movement count.** Every call scans the full movement history. With a long-running warehouse and many SKUs this degrades. A per-SKU running tally or indexed map would fix this — not changed here because it is a performance concern, not a correctness one, and the change would be disruptive.

**`Catalog.get()` returns the live stored object.** Callers who receive a `Sku` from `catalog.add()` or `catalog.get()` hold a direct reference to the stored object and can mutate `state`, `unitPrice`, or `initial` externally. This bypasses `discontinue()` and can silently corrupt `available()` (which reads `sku.initial`). Fixing this requires making `Sku` immutable (returning a copy or using `Object.freeze`) — a breaking change not made here because callers may depend on the existing reference semantics.

**`Catalog.add()` allows duplicate SKU IDs.** A second `add("widget", ...)` silently overwrites the first entry, discarding its `initial` quantity and all historical context. No deduplication guard exists.

**`Catalog.add()` accepts non-positive `initial` or `unitPrice`.** Negative initial stock or a negative unit price are not validated.

**`lineValue()` does not validate `discountPct`.** Values outside `[0, 100]` or non-integer percentages are accepted without error. A `discountPct > 100` produces a negative line value.

**`reserve()` idempotency uses orderId equality only.** If a retry passes a *different* `lines` array under the same `orderId`, the no-op is silently returned. The caller receives no signal that the originally committed lines differ. This is acceptable for true retry scenarios but would silently swallow logic errors.

**`cancel()` does not support partial cancellations.** The method restores all lines of an order. There is no mechanism to cancel only some SKUs from a multi-line order. This is a deliberate scope decision; partial cancel would require a different API surface.

**No persistence.** All state is in-memory. A process restart loses all movements, orders, and catalog data. This is by design (the module is in-memory), but callers integrating with a persistent store must ensure movement writes are durable before returning success.

**Single-threaded assumption.** The atomicity guarantee in `reserve()` and `cancel()` relies on JavaScript's single-threaded event loop. If the module is ever used from worker threads sharing state (e.g. SharedArrayBuffer), the two-phase commit provides no protection.

**`history()` does not validate `fromSeq`/`toSeq`.** Negative values or `fromSeq > toSeq` are silently accepted (the filter simply returns nothing). Whether to throw or return empty is a judgment call left to future callers.

### What was deliberately NOT changed

- **`Catalog.get()` returning a live reference** — changing to return copies would be a breaking change for callers that mutate state through the returned object (e.g. `catalog.add()` itself calls `get()` implicitly via `discontinue()`, and the existing state-mutation model is load-bearing).
- **The `Movement` type** — kept as defined in `types.ts`. Adding fields (e.g. `cancelledBy`, `timestamp`) would be useful but is out of scope.
- **`available()` performance** — correctness-only pass; algorithmic improvement is a separate concern.

---

## 3. Final Test Status

```
 RUN  v4.1.10 <repo>/runs/sonnet-4-6-2

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  16:24:18
   Duration  171ms (transform 27ms, setup 0ms, import 39ms, tests 3ms, environment 0ms)
```
