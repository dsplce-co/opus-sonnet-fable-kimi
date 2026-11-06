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
    // Input validation
    if (!orderId || orderId.trim() === "") {
      throw new Error("orderId cannot be empty");
    }
    if (!lines || lines.length === 0) {
      throw new Error("lines cannot be empty");
    }

    // Check for duplicate orderId (idempotency guard)
    for (const m of this.movements) {
      if (m.orderId === orderId) {
        throw new Error(`order ${orderId} already exists`);
      }
    }

    // Track provisional reservations per SKU for atomic validation
    const provisional = new Map<string, Qty>();

    // Validate all lines first
    for (const line of lines) {
      // Validate quantity
      if (typeof line.qty !== "number" || !Number.isInteger(line.qty)) {
        throw new Error(`quantity must be an integer for ${line.sku}`);
      }
      if (line.qty <= 0) {
        throw new Error(`quantity must be positive for ${line.sku}`);
      }

      const sku = this.catalog.get(line.sku); // Throws if SKU doesn't exist

      // Check SKU lifecycle
      if (sku.state !== "active") {
        throw new Error(`cannot reserve discontinued sku: ${line.sku}`);
      }

      const alreadyReserved = provisional.get(line.sku) || 0;
      const totalNeeded = alreadyReserved + line.qty;

      if (totalNeeded > this.available(line.sku)) {
        throw new Error(`insufficient stock for ${line.sku}`);
      }

      provisional.set(line.sku, totalNeeded);
    }

    // All validations passed, now record movements
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
    return [...this.movements];
  }

  // Cancel a previously reserved order, returning stock to availability.
  // Safe to call multiple times (idempotent).
  cancel(orderId: string): void {
    if (!orderId || orderId.trim() === "") {
      throw new Error("orderId cannot be empty");
    }

    // Find all movements for this order
    const orderMovements = this.movements.filter((m) => m.orderId === orderId);

    if (orderMovements.length === 0) {
      // Idempotent: already cancelled or never existed
      return;
    }

    // Check if already cancelled
    const hasCancellation = orderMovements.some((m) => m.qty > 0);
    if (hasCancellation) {
      // Already cancelled - idempotent
      return;
    }

    // Record cancellation movements (reversing the reservations)
    for (const original of orderMovements) {
      const sku = this.catalog.get(original.sku);

      // Respect SKU lifecycle: only restore stock if SKU still exists
      // (catalog.get throws if SKU doesn't exist, which is correct behavior)

      this.movements.push({
        seq: this.nextSeq++,
        orderId,
        sku: original.sku,
        qty: -original.qty, // Reverses the negative reservation
      });
    }
  }

  // Return movements for a SKU within an inclusive sequence range.
  history(sku: string, fromSeq: number, toSeq: number): Movement[] {
    // Validate SKU exists
    this.catalog.get(sku);

    // Validate sequence range
    if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq)) {
      throw new Error("fromSeq and toSeq must be integers");
    }
    if (fromSeq < 0 || toSeq < 0) {
      throw new Error("sequence numbers cannot be negative");
    }
    if (fromSeq > toSeq) {
      throw new Error("fromSeq cannot be greater than toSeq");
    }

    // Filter and return movements for this SKU in the sequence range
    return this.movements
      .filter((m) => m.sku === sku && m.seq >= fromSeq && m.seq <= toSeq)
      .map((m) => ({ ...m })); // Return defensive copies
  }
}
