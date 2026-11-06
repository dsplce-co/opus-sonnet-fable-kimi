import { Catalog } from "./catalog";
import { Movement, Qty, assertId, assertInteger } from "./types";

export interface Line {
  sku: string;
  qty: Qty;
}

interface OrderRecord {
  // Lines exactly as reserved (validated copies), in order.
  readonly lines: readonly Line[];
  cancelled: boolean;
}

export class Inventory {
  private movements: Movement[] = [];
  private nextSeq = 0;
  // Net of all movements per SKU (sum of signed qty). Maintained in lock-step
  // with `movements` by `append`, so `available` is O(1).
  private net = new Map<string, Qty>();
  // Every order id ever reserved, including cancelled ones. Order ids are
  // never reused: a reserve with a known id and identical lines is a no-op
  // (a safe retry); a known id with different lines is rejected.
  private orders = new Map<string, OrderRecord>();

  constructor(private catalog: Catalog) {}

  // Reserve stock for an order: one movement per line.
  //
  // Atomic: every line is validated (SKU exists and is active, qty is a
  // positive integer, the order's total per SKU fits in what is available)
  // before any movement is recorded. If any line fails, nothing is recorded.
  //
  // Idempotent: reserving an order id that was already reserved with the same
  // lines (same SKUs and quantities in the same sequence) does nothing and does
  // not throw, so a retry after a lost acknowledgement is safe. The same id
  // with different lines throws. This holds even after the order is cancelled:
  // the id stays consumed and a late retry of the reserve does not resurrect it.
  // A retry is recognised before lifecycle checks, so it stays a no-op even if
  // a SKU in the order was discontinued after the original reservation.
  reserve(orderId: string, lines: Line[]): void {
    assertId(orderId, "orderId");
    const validated = this.validateLines(lines);
    const existing = this.orders.get(orderId);
    if (existing !== undefined) {
      if (!sameLines(existing.lines, validated)) {
        throw new Error(`order already exists with different lines: ${orderId}`);
      }
      return;
    }
    const totals = new Map<string, Qty>();
    for (const line of validated) {
      if (this.catalog.get(line.sku).state !== "active") {
        throw new Error(`sku is discontinued: ${line.sku}`);
      }
      const total = (totals.get(line.sku) ?? 0) + line.qty;
      assertInteger(total, `total quantity for ${line.sku}`, 1);
      totals.set(line.sku, total);
    }
    for (const [sku, total] of totals) {
      if (total > this.available(sku)) {
        throw new Error(`insufficient stock for ${sku}`);
      }
    }
    // Commit. Nothing below can throw, so the order lands whole or not at all.
    for (const line of validated) {
      this.append(orderId, line.sku, -line.qty);
    }
    this.orders.set(orderId, { lines: validated, cancelled: false });
  }

  // Cancel a previously reserved order, returning every unit it reserved to
  // availability as one positive movement per reserved line.
  //
  // Atomic: all of the order's lines are returned or none are.
  // Idempotent: cancelling an order that is already cancelled does nothing.
  // Throws if the order id was never successfully reserved.
  //
  // SKU lifecycle: stock is returned even if the SKU has been discontinued
  // since the reservation. The units physically exist and the ledger must
  // balance; a discontinued SKU simply cannot be reserved again (see reserve).
  // Because a cancel returns exactly what was reserved, `available` can never
  // exceed the SKU's initial on-hand quantity.
  cancel(orderId: string): void {
    assertId(orderId, "orderId");
    const order = this.orders.get(orderId);
    if (order === undefined) {
      throw new Error(`no such order: ${orderId}`);
    }
    if (order.cancelled) {
      return;
    }
    // Commit. Nothing below can throw.
    for (const line of order.lines) {
      this.append(orderId, line.sku, line.qty);
    }
    order.cancelled = true;
  }

  // Units of a SKU currently available (initial on-hand plus all movements).
  // Throws if the SKU does not exist.
  available(sku: string): Qty {
    return this.catalog.get(sku).initial + (this.net.get(sku) ?? 0);
  }

  // Movements of `sku` whose seq lies within the inclusive [fromSeq, toSeq]
  // range, in seq order. Both bounds must be safe integers with
  // fromSeq <= toSeq; a range that covers no movements returns []. Throws if
  // the SKU does not exist or the bounds are invalid. Returns a fresh array of
  // frozen movements.
  //
  // Relies on the ledger invariant that seq === array index (seq starts at 0,
  // increases by exactly 1 per append, and nothing is ever removed).
  history(sku: string, fromSeq: number, toSeq: number): Movement[] {
    assertId(sku, "sku");
    this.catalog.get(sku);
    assertInteger(fromSeq, "fromSeq", Number.MIN_SAFE_INTEGER);
    assertInteger(toSeq, "toSeq", Number.MIN_SAFE_INTEGER);
    if (fromSeq > toSeq) {
      throw new Error(`fromSeq (${fromSeq}) must be <= toSeq (${toSeq})`);
    }
    if (toSeq < 0 || fromSeq >= this.movements.length) {
      return [];
    }
    return this.movements
      .slice(Math.max(fromSeq, 0), toSeq + 1)
      .filter((m) => m.sku === sku);
  }

  // Snapshot of the whole ledger in seq order. The array is a fresh copy and
  // each movement is frozen, so callers cannot alter the ledger through it.
  getMovements(): Movement[] {
    return this.movements.slice();
  }

  // Shape validation only (no catalog lookups). Copies each line into a fresh
  // object of primitives so the commit phase cannot observe different values
  // than the validation phase (e.g. getters).
  private validateLines(lines: Line[]): Line[] {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new Error("an order must contain at least one line");
    }
    const validated: Line[] = [];
    for (const line of lines) {
      if (line === null || typeof line !== "object") {
        throw new Error("each line must be an object with sku and qty");
      }
      const sku = line.sku;
      const qty = line.qty;
      assertId(sku, "sku");
      assertInteger(qty, "qty", 1);
      validated.push({ sku, qty });
    }
    return validated;
  }

  private append(orderId: string, sku: string, qty: Qty): void {
    const movement: Movement = Object.freeze({ seq: this.nextSeq++, orderId, sku, qty });
    this.movements.push(movement);
    this.net.set(sku, (this.net.get(sku) ?? 0) + qty);
  }
}

function sameLines(a: readonly Line[], b: readonly Line[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i].sku !== b[i].sku || a[i].qty !== b[i].qty) {
      return false;
    }
  }
  return true;
}
