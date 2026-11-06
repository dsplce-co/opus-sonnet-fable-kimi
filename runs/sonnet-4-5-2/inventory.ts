import { Catalog } from "./catalog";
import { Movement, Qty } from "./types";

export interface Line {
  sku: string;
  qty: Qty;
}

export class Inventory {
  private movements: Movement[] = [];
  private nextSeq = 0;
  private canceledOrders = new Set<string>();

  constructor(private catalog: Catalog) {}

  // Reserve stock for an order: one movement per line.
  reserve(orderId: string, lines: Line[]): void {
    if (!orderId || typeof orderId !== "string") {
      throw new Error("orderId is required");
    }
    if (lines.length === 0) {
      throw new Error("cannot reserve empty order");
    }
    if (this.canceledOrders.has(orderId)) {
      throw new Error(`cannot reuse canceled order ID: ${orderId}`);
    }
    // Validate and check all lines BEFORE recording any movements (atomicity).
    const deltas = new Map<string, number>();
    for (const line of lines) {
      if (!Number.isInteger(line.qty) || line.qty <= 0) {
        throw new Error(`invalid quantity for ${line.sku}: ${line.qty}`);
      }
      const sku = this.catalog.get(line.sku);
      if (sku.state !== "active") {
        throw new Error(`cannot reserve discontinued SKU: ${line.sku}`);
      }
      // Accumulate total demand per SKU across all lines.
      deltas.set(line.sku, (deltas.get(line.sku) || 0) + line.qty);
    }
    // Check availability for accumulated demand.
    for (const [sku, totalQty] of deltas) {
      if (totalQty > this.available(sku)) {
        throw new Error(`insufficient stock for ${sku}`);
      }
    }
    // All checks passed; record movements atomically.
    for (const line of lines) {
      this.movements.push({
        seq: this.nextSeq++,
        orderId,
        sku: line.sku,
        qty: -line.qty,
      });
    }
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

  getMovements(): Movement[] {
    // Return a defensive copy to prevent external mutation.
    return [...this.movements];
  }

  // Cancel a previously reserved order, returning its stock to availability.
  // Idempotent: safe to call multiple times for the same orderId.
  cancel(orderId: string): void {
    if (!orderId || typeof orderId !== "string") {
      throw new Error("orderId is required");
    }
    // Check if this order has already been canceled.
    if (this.canceledOrders.has(orderId)) {
      return; // Already canceled; idempotent no-op.
    }
    // Find all reservation movements for this order.
    const reservations = this.movements.filter(m => m.orderId === orderId && m.qty < 0);
    if (reservations.length === 0) {
      return; // No reservations found; idempotent no-op.
    }
    // Validate all SKUs still exist before recording any cancellation movements.
    for (const res of reservations) {
      this.catalog.get(res.sku); // Throws if SKU doesn't exist.
    }
    // Record cancellation movements (reversing the sign).
    for (const res of reservations) {
      this.movements.push({
        seq: this.nextSeq++,
        orderId,
        sku: res.sku,
        qty: -res.qty, // Positive, returning stock.
      });
    }
    // Mark this order as canceled.
    this.canceledOrders.add(orderId);
  }

  // Return movements for a SKU within an inclusive seq range.
  history(sku: string, fromSeq: number, toSeq: number): Movement[] {
    return this.movements.filter(
      m => m.sku === sku && m.seq >= fromSeq && m.seq <= toSeq
    );
  }
}
