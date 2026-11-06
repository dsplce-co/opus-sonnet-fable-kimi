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
  // Idempotent: a second call with the same orderId is a no-op.
  reserve(orderId: string, lines: Line[]): void {
    // Idempotency guard: if this orderId already has movements it was fully committed.
    if (this.movements.some((m) => m.orderId === orderId)) {
      return;
    }

    // Validate all lines and compute pending stock draw before touching state.
    const pending: Movement[] = [];
    const pendingDraw = new Map<string, number>(); // qty drawn from committed state so far

    for (const line of lines) {
      const sku = this.catalog.get(line.sku);
      if (sku.state !== "active") {
        throw new Error(`sku ${line.sku} is discontinued`);
      }
      if (!Number.isInteger(line.qty) || line.qty <= 0) {
        throw new Error(`invalid qty for ${line.sku}: must be a positive integer`);
      }
      const alreadyPending = pendingDraw.get(line.sku) ?? 0;
      if (line.qty + alreadyPending > this.available(line.sku)) {
        throw new Error(`insufficient stock for ${line.sku}`);
      }
      pendingDraw.set(line.sku, alreadyPending + line.qty);
      pending.push({ seq: -1, orderId, sku: line.sku, qty: -line.qty });
    }

    // All validations passed — commit atomically.
    for (const m of pending) {
      m.seq = this.nextSeq++;
      this.movements.push(m);
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

  // Return movements for a SKU whose seq falls within [fromSeq, toSeq] inclusive.
  history(sku: string, fromSeq: number, toSeq: number): Movement[] {
    this.catalog.get(sku); // throws for unknown SKU
    return this.movements.filter(
      (m) => m.sku === sku && m.seq >= fromSeq && m.seq <= toSeq
    );
  }

  // Cancel a previously reserved order, returning its stock to availability.
  // Idempotent: safe to call more than once; subsequent calls are no-ops.
  cancel(orderId: string): void {
    const reservations = this.movements.filter(
      (m) => m.orderId === orderId && m.qty < 0
    );
    if (reservations.length === 0) {
      return; // Never reserved (or already fully processed).
    }
    // Already cancelled if any positive movement exists for this orderId.
    if (this.movements.some((m) => m.orderId === orderId && m.qty > 0)) {
      return;
    }
    // Atomically push all reversals.
    for (const m of reservations) {
      this.movements.push({
        seq: this.nextSeq++,
        orderId,
        sku: m.sku,
        qty: -m.qty, // positive: return to availability
      });
    }
  }

  getMovements(): Movement[] {
    return [...this.movements];
  }
}
