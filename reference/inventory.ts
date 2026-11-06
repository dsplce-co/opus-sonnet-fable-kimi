import { Catalog } from "./catalog";
import { Movement, Qty } from "./types";

export interface Line {
  sku: string;
  qty: Qty;
}

export class Inventory {
  private movements: Movement[] = [];
  private nextSeq = 0;
  // Active (uncancelled) reservations, by orderId — for retry-idempotency and cancel.
  private orders = new Map<string, Line[]>();

  constructor(private catalog: Catalog) {}

  // Reserve stock for an order. Atomic: either every line is applied or none is.
  reserve(orderId: string, lines: Line[]): void {
    const existing = this.orders.get(orderId);
    if (existing) {
      // Retry-safe: an identical re-reservation is a no-op; a conflicting one is rejected.
      if (sameLines(existing, lines)) {
        return;
      }
      throw new Error(`order already exists with different lines: ${orderId}`);
    }
    // Validate every line before applying any.
    const demand = new Map<string, number>();
    for (const line of lines) {
      const sku = this.catalog.get(line.sku); // unknown sku throws before anything is applied
      if (sku.state !== "active") {
        throw new Error(`sku not active: ${line.sku}`);
      }
      if (!Number.isInteger(line.qty) || line.qty <= 0) {
        throw new Error(`invalid quantity for ${line.sku}: ${line.qty}`);
      }
      demand.set(line.sku, (demand.get(line.sku) ?? 0) + line.qty);
    }
    for (const [sku, qty] of Array.from(demand.entries())) {
      if (qty > this.available(sku)) {
        throw new Error(`insufficient stock for ${sku}`);
      }
    }
    // Commit all lines together.
    for (const line of lines) {
      this.movements.push({ seq: this.nextSeq++, orderId, sku: line.sku, qty: -line.qty });
    }
    this.orders.set(orderId, lines.map((l) => ({ sku: l.sku, qty: l.qty })));
  }

  // Cancel a previously reserved order, returning its stock. Atomic and retry-safe.
  cancel(orderId: string): void {
    const lines = this.orders.get(orderId);
    if (!lines) {
      return; // unknown or already-cancelled order: no-op
    }
    for (const line of lines) {
      this.movements.push({ seq: this.nextSeq++, orderId, sku: line.sku, qty: line.qty });
    }
    this.orders.delete(orderId);
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

  // That SKU's movements whose seq is within the inclusive [fromSeq, toSeq] range.
  history(sku: string, fromSeq: number, toSeq: number): Movement[] {
    return this.movements.filter(
      (m) => m.sku === sku && m.seq >= fromSeq && m.seq <= toSeq
    );
  }

  getMovements(): Movement[] {
    return this.movements.slice();
  }
}

function sameLines(a: Line[], b: Line[]): boolean {
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
