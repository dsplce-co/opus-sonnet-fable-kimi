import { Catalog } from "./catalog";
import {
  Movement,
  Qty,
  assertInteger,
  assertNonEmptyString,
  assertPositiveInteger,
} from "./types";

export interface Line {
  readonly sku: string;
  readonly qty: Qty;
}

type OrderStatus = "reserved" | "cancelled";

interface OrderRecord {
  status: OrderStatus;
  // Requested units per SKU, aggregated across lines. Used to recognise a
  // retried identical reservation.
  readonly wanted: ReadonlyMap<string, Qty>;
  // The reservation movements this order created, in ledger order.
  readonly reserved: readonly Movement[];
}

export class Inventory {
  // Append-only ledger. Every entry is frozen; this array is never exposed.
  private readonly movements: Movement[] = [];
  private readonly orders = new Map<string, OrderRecord>();
  private nextSeq = 0;

  constructor(private readonly catalog: Catalog) {}

  // Reserve stock for an order: one movement per line.
  //
  // Atomic: every line is validated (SKU exists and is active, quantity is a
  // positive whole number, enough stock for the order as a whole) before any
  // movement is written, so a failing order leaves the ledger untouched.
  //
  // Retry-safe: reserving an orderId that is already reserved with the same
  // per-SKU quantities is a no-op. Reusing an orderId with different lines,
  // or after it was cancelled, is rejected.
  reserve(orderId: string, lines: readonly Line[]): void {
    assertNonEmptyString("orderId", orderId);
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new TypeError("lines must be a non-empty array");
    }

    // Phase 1: validate and normalise without mutating anything.
    const wanted = new Map<string, Qty>();
    for (const line of lines) {
      if (line === null || typeof line !== "object") {
        throw new TypeError("each line must be an object with sku and qty");
      }
      assertNonEmptyString("line.sku", line.sku);
      assertPositiveInteger("line.qty", line.qty);
      const sku = this.catalog.get(line.sku);
      if (sku.state !== "active") {
        throw new Error(`sku is ${sku.state}: ${line.sku}`);
      }
      wanted.set(line.sku, (wanted.get(line.sku) ?? 0) + line.qty);
    }

    const existing = this.orders.get(orderId);
    if (existing !== undefined) {
      if (existing.status === "reserved" && sameWanted(existing.wanted, wanted)) {
        return; // identical retry of an already-applied reservation
      }
      throw new Error(`order already exists: ${orderId}`);
    }

    for (const [sku, qty] of wanted) {
      if (qty > this.available(sku)) {
        throw new Error(`insufficient stock for ${sku}`);
      }
    }

    // Phase 2: commit. Nothing below can throw.
    const reserved: Movement[] = [];
    for (const line of lines) {
      reserved.push(this.append(orderId, line.sku, -line.qty));
    }
    this.orders.set(orderId, { status: "reserved", wanted, reserved });
  }

  // Cancel a reserved order, returning every unit it reserved to
  // availability: one positive movement per reservation movement, under the
  // same orderId.
  //
  // Atomic: the ledger is only written once the order has been resolved, and
  // the write loop cannot fail part-way. Idempotent: cancelling an order that
  // is already cancelled is a no-op. Cancelling an unknown orderId is an
  // error, so a typo cannot be mistaken for a successful retry.
  //
  // SKU lifecycle: cancellation succeeds even if a SKU on the order has been
  // discontinued since it was reserved. The units physically exist and must
  // be accounted for; they simply cannot be reserved again while the SKU is
  // discontinued. Cancelling never changes a SKU's state.
  cancel(orderId: string): void {
    assertNonEmptyString("orderId", orderId);
    const order = this.orders.get(orderId);
    if (order === undefined) {
      throw new Error(`no such order: ${orderId}`);
    }
    if (order.status === "cancelled") {
      return; // already applied
    }
    for (const m of order.reserved) {
      this.append(orderId, m.sku, -m.qty);
    }
    order.status = "cancelled";
  }

  // Units of a SKU currently available (initial on-hand plus all movements).
  available(sku: string): Qty {
    let q = this.catalog.get(sku).initial;
    for (const m of this.movements) {
      if (m.sku === sku) {
        q += m.qty;
      }
    }
    return q;
  }

  // Movements of `sku` whose seq lies within the inclusive range
  // [fromSeq, toSeq], in seq order. Unknown SKUs, non-integer bounds and
  // an inverted range (fromSeq > toSeq) are errors rather than silently
  // returning nothing, since each almost certainly indicates a caller bug.
  history(sku: string, fromSeq: number, toSeq: number): Movement[] {
    assertNonEmptyString("sku", sku);
    this.catalog.get(sku); // throws for an unknown SKU
    assertInteger("fromSeq", fromSeq);
    assertInteger("toSeq", toSeq);
    if (fromSeq > toSeq) {
      throw new RangeError(`fromSeq (${fromSeq}) must be <= toSeq (${toSeq})`);
    }
    return this.movements.filter((m) => m.sku === sku && m.seq >= fromSeq && m.seq <= toSeq);
  }

  // Snapshot of the ledger in seq order. The returned array is a copy and
  // its entries are frozen, so callers cannot alter recorded stock.
  getMovements(): Movement[] {
    return this.movements.slice();
  }

  private append(orderId: string, sku: string, qty: Qty): Movement {
    const m: Movement = Object.freeze({ seq: this.nextSeq++, orderId, sku, qty });
    this.movements.push(m);
    return m;
  }
}

function sameWanted(a: ReadonlyMap<string, Qty>, b: ReadonlyMap<string, Qty>): boolean {
  if (a.size !== b.size) return false;
  for (const [sku, qty] of a) {
    if (b.get(sku) !== qty) return false;
  }
  return true;
}
