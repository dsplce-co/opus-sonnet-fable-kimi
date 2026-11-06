import { Catalog } from "./catalog";
import {
  Movement,
  Qty,
  assertId,
  assertPositiveQty,
  assertSafeInteger,
} from "./types";

export interface Line {
  sku: string;
  qty: Qty;
}

type OrderStatus = "reserved" | "cancelled";

interface OrderRecord {
  lines: ReadonlyArray<Readonly<Line>>;
  status: OrderStatus;
}

/** A movement that has been validated but not yet written to the ledger. */
type PendingMovement = Omit<Movement, "seq">;

export class Inventory {
  private movements: Movement[] = [];
  private nextSeq = 0;

  /** Every order ever seen, so reserve/cancel can be made retry-safe. */
  private orders = new Map<string, OrderRecord>();

  /**
   * Availability index: `initial` plus the signed sum of that SKU's movements.
   * Maintained incrementally so `available` is O(1) instead of a full ledger
   * scan; `reserve` previously rescanned every movement for every line, which
   * is O(lines x ledger) and degrades without bound as the ledger grows.
   *
   * This cache is only sound because `Catalog` now refuses to redefine a SKU
   * and hands out frozen copies, so `initial` cannot change underneath it, and
   * because `commit` is the single writer of both the ledger and this map.
   */
  private availableBySku = new Map<string, Qty>();

  constructor(private catalog: Catalog) {}

  /**
   * Reserve stock for an order: one movement per line.
   *
   * Atomic: every line is validated against the catalog, the SKU lifecycle and
   * the *combined* demand per SKU before anything is written. A failure on a
   * later line leaves no trace of the earlier ones. Previously each line was
   * appended as it was checked, so a rejected line stranded the stock already
   * reserved by the lines before it.
   *
   * Retry-safe: replaying the identical call is a no-op rather than a second
   * reservation, so a client that retries after a timeout cannot double-book.
   * Reusing an orderId for *different* lines, or for an order that has been
   * cancelled, is rejected as a caller bug.
   */
  reserve(orderId: string, lines: Line[]): void {
    assertId(orderId, "orderId");
    const requested = this.normalizeLines(lines);

    const existing = this.orders.get(orderId);
    if (existing !== undefined) {
      if (existing.status === "cancelled") {
        throw new Error(`order ${orderId} was cancelled; order ids are not reusable`);
      }
      if (!sameLines(existing.lines, requested)) {
        throw new Error(`order ${orderId} already reserved with different lines`);
      }
      return; // Idempotent replay of an identical reservation.
    }

    // --- validation phase: no state is mutated below this point on failure ---

    // Demand is summed per SKU first. Checking each line in isolation lets an
    // order reserve the same SKU twice over, e.g. two 60-unit lines against
    // 100 units on hand.
    const demand = new Map<string, Qty>();
    for (const line of requested) {
      const sku = this.catalog.get(line.sku); // throws on unknown SKU
      if (sku.state !== "active") {
        throw new Error(`cannot reserve ${line.sku}: sku is ${sku.state}`);
      }
      const total = (demand.get(line.sku) ?? 0) + line.qty;
      assertSafeInteger(total, `total quantity for ${line.sku}`);
      demand.set(line.sku, total);
    }
    for (const [sku, qty] of demand) {
      if (qty > this.availabilityOf(sku)) {
        throw new Error(`insufficient stock for ${sku}`);
      }
    }

    // --- commit phase ---
    this.commit(requested.map((line) => ({ orderId, sku: line.sku, qty: -line.qty })));
    this.orders.set(orderId, { lines: requested, status: "reserved" });
  }

  /**
   * Cancel a reserved order, returning its stock to availability.
   *
   * Atomic: if any of the order's SKUs is no longer active, nothing is
   * returned and the order stays reserved.
   *
   * Safe to call more than once: cancelling an already-cancelled order is a
   * no-op, so a retried cancel cannot return the same stock twice. Cancelling
   * an unknown order is an error, not a no-op, because that indicates the
   * caller has the wrong id rather than a duplicate delivery.
   */
  cancel(orderId: string): void {
    assertId(orderId, "orderId");
    const order = this.orders.get(orderId);
    if (order === undefined) {
      throw new Error(`no such order: ${orderId}`);
    }
    if (order.status === "cancelled") {
      return; // Idempotent.
    }

    // Validate the whole order before returning any of it.
    for (const line of order.lines) {
      const sku = this.catalog.get(line.sku);
      if (sku.state !== "active") {
        throw new Error(`cannot cancel ${orderId}: sku ${line.sku} is ${sku.state}`);
      }
    }

    this.commit(order.lines.map((line) => ({ orderId, sku: line.sku, qty: line.qty })));
    this.orders.set(orderId, { lines: order.lines, status: "cancelled" });
  }

  /**
   * That SKU's movements with `seq` in the inclusive range [fromSeq, toSeq].
   *
   * Returns copies, so the caller cannot edit the ledger through the result.
   * An inverted range yields an empty array rather than throwing, so paging
   * loops terminate cleanly. History is readable for discontinued SKUs: the
   * lifecycle restricts what you may *do* to stock, not what you may audit.
   */
  history(sku: string, fromSeq: number, toSeq: number): Movement[] {
    assertId(sku, "sku");
    this.catalog.get(sku); // throws on unknown SKU
    assertSafeInteger(fromSeq, "fromSeq");
    assertSafeInteger(toSeq, "toSeq");
    if (fromSeq > toSeq) {
      return [];
    }
    const out: Movement[] = [];
    for (const m of this.movements) {
      if (m.sku === sku && m.seq >= fromSeq && m.seq <= toSeq) {
        out.push({ ...m });
      }
    }
    return out;
  }

  /** Units of a SKU currently available (initial on-hand plus all movements). */
  available(sku: string): Qty {
    assertId(sku, "sku");
    return this.availabilityOf(sku);
  }

  /**
   * The ledger, as copies.
   *
   * This previously returned the live internal array: callers could push,
   * splice or edit movements in place and drive stock negative with no record
   * of how.
   */
  getMovements(): Movement[] {
    return this.movements.map((m) => ({ ...m }));
  }

  /**
   * The single writer of the ledger and the availability index.
   *
   * Projects the full batch first and only mutates once every entry is known
   * to be safe, so a batch is all-or-nothing. The non-negative check is a
   * backstop against a validation gap upstream, not the primary guard.
   */
  private commit(pending: ReadonlyArray<PendingMovement>): void {
    const projected = new Map<string, Qty>();
    for (const p of pending) {
      const base = projected.get(p.sku) ?? this.availabilityOf(p.sku);
      const next = base + p.qty;
      assertSafeInteger(next, `availability for ${p.sku}`);
      if (next < 0) {
        throw new Error(`internal invariant: ${p.sku} availability would go negative`);
      }
      projected.set(p.sku, next);
    }
    // Nothing below can throw.
    for (const p of pending) {
      this.movements.push({ seq: this.nextSeq++, orderId: p.orderId, sku: p.sku, qty: p.qty });
    }
    for (const [sku, qty] of projected) {
      this.availableBySku.set(sku, qty);
    }
  }

  private availabilityOf(sku: string): Qty {
    const cached = this.availableBySku.get(sku);
    if (cached !== undefined) {
      return cached;
    }
    const initial = this.catalog.get(sku).initial; // throws on unknown SKU
    this.availableBySku.set(sku, initial);
    return initial;
  }

  /**
   * Validate and defensively copy the caller's lines.
   *
   * The copy matters: the stored order record drives `cancel`, so keeping the
   * caller's objects would let them mutate what gets returned later.
   */
  private normalizeLines(lines: Line[]): ReadonlyArray<Readonly<Line>> {
    if (!Array.isArray(lines)) {
      throw new TypeError("lines must be an array");
    }
    if (lines.length === 0) {
      throw new RangeError("an order must have at least one line");
    }
    return lines.map((line, i) => {
      if (line === null || typeof line !== "object") {
        throw new TypeError(`line ${i} must be an object`);
      }
      assertId(line.sku, `line ${i} sku`);
      // Rejects negative (which would mint stock by flipping the movement
      // sign), zero, fractional and NaN/Infinity quantities. A single NaN
      // makes every later availability total NaN, permanently.
      assertPositiveQty(line.qty, `line ${i} quantity`);
      return Object.freeze({ sku: line.sku, qty: line.qty });
    });
  }
}

function sameLines(
  a: ReadonlyArray<Readonly<Line>>,
  b: ReadonlyArray<Readonly<Line>>,
): boolean {
  return (
    a.length === b.length &&
    a.every((line, i) => line.sku === b[i].sku && line.qty === b[i].qty)
  );
}
