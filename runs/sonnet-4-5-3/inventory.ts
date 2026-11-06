import { Catalog } from "./catalog";
import { Movement, Qty } from "./types";

export interface Line {
  sku: string;
  qty: Qty;
}

export class Inventory {
  private movements: Movement[] = [];
  private nextSeq = 0;

  constructor(private catalog: Catalog) {}

  // Reserve stock for an order: one movement per line.
  reserve(orderId: string, lines: Line[]): void {
    // Validate orderId
    if (!orderId || typeof orderId !== "string") {
      throw new Error("orderId is required");
    }

    // Validate all lines first (atomic check)
    const skuDemand = new Map<string, Qty>();
    for (const line of lines) {
      // Validate quantity is a positive integer
      if (!Number.isInteger(line.qty) || line.qty <= 0) {
        throw new Error(`invalid quantity for ${line.sku}: ${line.qty}`);
      }

      // Check SKU exists and is active
      const sku = this.catalog.get(line.sku);
      if (sku.state === "discontinued") {
        throw new Error(`cannot reserve discontinued sku: ${line.sku}`);
      }

      // Accumulate demand per SKU
      skuDemand.set(line.sku, (skuDemand.get(line.sku) || 0) + line.qty);
    }

    // Check availability for all SKUs
    for (const [sku, qty] of skuDemand) {
      if (qty > this.available(sku)) {
        throw new Error(`insufficient stock for ${sku}`);
      }
    }

    // All checks passed - now commit the movements
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
    // Return a defensive copy to prevent external mutation
    return [...this.movements];
  }

  // Cancel a previously reserved order, returning stock to availability.
  // Safe to call multiple times (idempotent).
  cancel(orderId: string): void {
    if (!orderId || typeof orderId !== "string") {
      throw new Error("orderId is required");
    }

    // Find all reservation movements for this order (negative qty)
    const reservations = this.movements.filter(
      (m) => m.orderId === orderId && m.qty < 0
    );

    // Check if already fully canceled by looking for matching positive movements
    const cancellations = this.movements.filter(
      (m) => m.orderId === orderId && m.qty > 0
    );

    // Group by SKU to check if already canceled
    const reservedBySku = new Map<string, Qty>();
    const canceledBySku = new Map<string, Qty>();

    for (const m of reservations) {
      reservedBySku.set(m.sku, (reservedBySku.get(m.sku) || 0) + Math.abs(m.qty));
    }

    for (const m of cancellations) {
      canceledBySku.set(m.sku, (canceledBySku.get(m.sku) || 0) + m.qty);
    }

    // Add cancellation movements for any remaining reservations
    for (const [sku, reserved] of reservedBySku) {
      const canceled = canceledBySku.get(sku) || 0;
      const remaining = reserved - canceled;

      if (remaining > 0) {
        // Verify SKU still exists in catalog
        this.catalog.get(sku);

        this.movements.push({
          seq: this.nextSeq++,
          orderId,
          sku,
          qty: remaining,
        });
      }
    }
  }

  // Return movements for a SKU within a sequence range (inclusive).
  history(sku: string, fromSeq: number, toSeq: number): Movement[] {
    if (!Number.isInteger(fromSeq) || fromSeq < 0) {
      throw new Error("fromSeq must be a non-negative integer");
    }
    if (!Number.isInteger(toSeq) || toSeq < 0) {
      throw new Error("toSeq must be a non-negative integer");
    }
    if (fromSeq > toSeq) {
      throw new Error("fromSeq cannot be greater than toSeq");
    }

    // Verify SKU exists
    this.catalog.get(sku);

    return this.movements
      .filter((m) => m.sku === sku && m.seq >= fromSeq && m.seq <= toSeq)
      .map((m) => ({ ...m })); // Return copies to prevent mutation
  }
}
