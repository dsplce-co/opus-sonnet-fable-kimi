import { Catalog } from "./catalog";
import { Movement, Qty } from "./types";

export interface Line {
  sku: string;
  qty: Qty;
}

interface OrderRecord {
  // Canonical (sorted) lines, used to detect conflicting reuse of an orderId.
  lines: Line[];
  cancelled: boolean;
}

function canonicalLines(lines: Line[]): Line[] {
  return lines
    .map((l) => ({ sku: l.sku, qty: l.qty }))
    .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : a.qty - b.qty));
}

function sameLines(a: Line[], b: Line[]): boolean {
  return a.length === b.length && a.every((l, i) => l.sku === b[i].sku && l.qty === b[i].qty);
}

export class Inventory {
  private movements: Movement[] = [];
  private nextSeq = 0;
  private orders = new Map<string, OrderRecord>();

  constructor(private catalog: Catalog) {}

  // Reserve stock for an order: one movement per line.
  //
  // Atomic: every line is validated (known + active SKU, positive whole-unit
  // qty, aggregated stock sufficiency) before any movement is appended; a
  // failure leaves no partial reservation behind.
  //
  // Retry-safe: repeating the call with the same orderId and the same lines
  // is a no-op; reusing the orderId with different lines (or after a cancel)
  // throws instead of double-reserving.
  reserve(orderId: string, lines: Line[]): void {
    if (typeof orderId !== "string" || orderId.length === 0) {
      throw new Error("orderId must be a non-empty string");
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new Error(`order ${orderId} must have at least one line`);
    }

    const canonical = canonicalLines(lines);
    const existing = this.orders.get(orderId);
    if (existing !== undefined) {
      if (!existing.cancelled && sameLines(existing.lines, canonical)) {
        return; // idempotent retry of the same reservation
      }
      throw new Error(
        existing.cancelled
          ? `order ${orderId} was cancelled and cannot be reserved again`
          : `order ${orderId} already reserved with different lines`,
      );
    }

    // Aggregate demand per SKU so duplicate lines for one SKU are checked
    // against their combined total, not line by line.
    const demand = new Map<string, Qty>();
    for (const line of lines) {
      if (!Number.isSafeInteger(line.qty) || line.qty <= 0) {
        throw new Error(`qty for ${line.sku} must be a positive whole number of units`);
      }
      const sku = this.catalog.get(line.sku); // throws on unknown SKU
      if (sku.state !== "active") {
        throw new Error(`sku ${line.sku} is ${sku.state} and cannot be reserved`);
      }
      demand.set(line.sku, (demand.get(line.sku) ?? 0) + line.qty);
    }
    for (const [sku, qty] of demand) {
      if (qty > this.available(sku)) {
        throw new Error(`insufficient stock for ${sku}`);
      }
    }

    // Validation complete — from here nothing can fail, so the append is atomic.
    for (const line of lines) {
      this.movements.push({
        seq: this.nextSeq++,
        orderId,
        sku: line.sku,
        qty: -line.qty,
      });
    }
    this.orders.set(orderId, { lines: canonical, cancelled: false });
  }

  // Cancel a reserved order, returning its stock to availability.
  //
  // Idempotent: cancelling an already-cancelled order is a no-op. Cancelling
  // an order that was never reserved throws. Cancellation is allowed for
  // discontinued SKUs — the stock must still come back — and is atomic:
  // all returns are computed before any movement is appended.
  cancel(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order === undefined) {
      throw new Error(`no such order: ${orderId}`);
    }
    if (order.cancelled) {
      return;
    }

    const returns = new Map<string, Qty>();
    for (const m of this.movements) {
      if (m.orderId === orderId && m.qty < 0) {
        returns.set(m.sku, (returns.get(m.sku) ?? 0) + -m.qty);
      }
    }

    // Nothing above can fail mid-way; append all returns atomically.
    for (const [sku, qty] of returns) {
      this.movements.push({ seq: this.nextSeq++, orderId, sku, qty });
    }
    order.cancelled = true;
  }

  // Movements for a SKU whose seq falls within the inclusive [fromSeq, toSeq]
  // range. Returns copies; mutating the result does not affect the ledger.
  history(sku: string, fromSeq: number, toSeq: number): Movement[] {
    this.catalog.get(sku); // throws on unknown SKU
    if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq)) {
      throw new Error("history range bounds must be integers");
    }
    if (fromSeq > toSeq) {
      return [];
    }
    return this.movements
      .filter((m) => m.sku === sku && m.seq >= fromSeq && m.seq <= toSeq)
      .map((m) => ({ ...m }));
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

  // A defensive copy of the ledger; callers cannot mutate internal state.
  getMovements(): Movement[] {
    return this.movements.map((m) => ({ ...m }));
  }
}
