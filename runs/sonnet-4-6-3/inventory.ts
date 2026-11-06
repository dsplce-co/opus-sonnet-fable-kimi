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
  // Idempotent: calling again with the same orderId is a no-op.
  reserve(orderId: string, lines: Line[]): void {
    if (this.movements.some((m) => m.orderId === orderId)) {
      return;
    }

    const pending: { sku: string; qty: Qty }[] = [];

    for (const line of lines) {
      const sku = this.catalog.get(line.sku);
      if (sku.state === "discontinued") {
        throw new Error(`sku ${line.sku} is discontinued`);
      }
      if (!Number.isInteger(line.qty) || line.qty <= 0) {
        throw new Error(`invalid quantity for ${line.sku}: must be a positive integer`);
      }

      // Compute available considering both committed movements and those
      // already staged for this same reserve call.
      let avail = sku.initial;
      for (const m of this.movements) {
        if (m.sku === line.sku) avail += m.qty;
      }
      for (const p of pending) {
        if (p.sku === line.sku) avail -= p.qty;
      }

      if (line.qty > avail) {
        throw new Error(`insufficient stock for ${line.sku}`);
      }

      pending.push({ sku: line.sku, qty: line.qty });
    }

    // All lines validated — commit atomically.
    for (const p of pending) {
      this.movements.push({ seq: this.nextSeq++, orderId, sku: p.sku, qty: -p.qty });
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

  // Cancel a previously reserved order, returning its stock to availability.
  // Idempotent: safe to call more than once.
  cancel(orderId: string): void {
    const reservations = this.movements.filter(
      (m) => m.orderId === orderId && m.qty < 0,
    );
    if (reservations.length === 0) return;

    // Idempotency guard: cancellation movements already exist.
    const alreadyCancelled = this.movements.some(
      (m) => m.orderId === orderId && m.qty > 0,
    );
    if (alreadyCancelled) return;

    // Atomically push one return movement per reservation.
    for (const m of reservations) {
      this.movements.push({ seq: this.nextSeq++, orderId, sku: m.sku, qty: -m.qty });
    }
  }

  // Return movements for a SKU whose seq falls in [fromSeq, toSeq] inclusive.
  history(sku: string, fromSeq: number, toSeq: number): Movement[] {
    this.catalog.get(sku); // throws if SKU doesn't exist
    return this.movements
      .filter((m) => m.sku === sku && m.seq >= fromSeq && m.seq <= toSeq)
      .map((m) => ({ ...m }));
  }

  getMovements(): Movement[] {
    return [...this.movements];
  }
}
