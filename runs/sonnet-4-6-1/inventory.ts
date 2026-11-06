import { Catalog } from "./catalog";
import { Movement, Qty } from "./types";

export interface Line {
  sku: string;
  qty: Qty;
}

export class Inventory {
  private movements: Movement[] = [];
  private nextSeq = 0;
  private reservedOrders = new Set<string>();
  private cancelledOrders = new Set<string>();

  constructor(private catalog: Catalog) {}

  // Reserve stock for an order: one movement per line.
  // Atomic: either all lines succeed or no stock is changed.
  reserve(orderId: string, lines: Line[]): void {
    if (!orderId) throw new Error("orderId must be non-empty");
    if (this.reservedOrders.has(orderId))
      throw new Error(`orderId already reserved: ${orderId}`);

    // Validate all lines before touching state.
    for (const line of lines) {
      const sku = this.catalog.get(line.sku);
      if (sku.state === "discontinued")
        throw new Error(`sku is discontinued: ${line.sku}`);
      if (!Number.isInteger(line.qty) || line.qty <= 0)
        throw new Error(`qty must be a positive integer for ${line.sku}: ${line.qty}`);
    }

    // Check availability across all lines in one pass, accounting for
    // multiple lines targeting the same SKU within this order.
    const projected = new Map<string, number>();
    for (const line of lines) {
      const current = projected.has(line.sku)
        ? projected.get(line.sku)!
        : this.available(line.sku);
      if (line.qty > current)
        throw new Error(`insufficient stock for ${line.sku}`);
      projected.set(line.sku, current - line.qty);
    }

    // All checks passed — apply atomically.
    for (const line of lines) {
      this.movements.push({
        seq: this.nextSeq++,
        orderId,
        sku: line.sku,
        qty: -line.qty,
      });
    }
    this.reservedOrders.add(orderId);
  }

  // Cancel a previously reserved order, returning its stock to availability.
  // Idempotent: safe to call more than once.
  cancel(orderId: string): void {
    if (!this.reservedOrders.has(orderId))
      throw new Error(`orderId was never reserved: ${orderId}`);
    if (this.cancelledOrders.has(orderId)) return; // already cancelled

    for (const m of this.movements) {
      if (m.orderId === orderId && m.qty < 0) {
        this.movements.push({
          seq: this.nextSeq++,
          orderId,
          sku: m.sku,
          qty: -m.qty, // positive: return stock
        });
      }
    }
    this.cancelledOrders.add(orderId);
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

  // Movements for a SKU whose seq falls in [fromSeq, toSeq] inclusive.
  history(sku: string, fromSeq: number, toSeq: number): Movement[] {
    this.catalog.get(sku); // validate SKU exists
    return this.movements
      .filter(m => m.sku === sku && m.seq >= fromSeq && m.seq <= toSeq)
      .map(m => ({ ...m }));
  }

  getMovements(): Movement[] {
    return this.movements.map(m => ({ ...m }));
  }
}
