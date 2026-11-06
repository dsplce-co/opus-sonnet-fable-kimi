import { Catalog } from "./catalog";
import { Movement, Qty } from "./types";

export interface Line {
  sku: string;
  qty: Qty;
}

type OrderStatus = "reserved" | "cancelled";

export class Inventory {
  private movements: Movement[] = [];
  private nextSeq = 0;
  private orderStatus = new Map<string, OrderStatus>();

  constructor(private catalog: Catalog) {}

  // Reserve stock for an order: one movement per line.
  // Validates every line before committing any movement, so a failure
  // partway through never leaves a partial reservation.
  reserve(orderId: string, lines: Line[]): void {
    if (lines.length === 0) {
      throw new Error("order must have at least one line");
    }
    if (this.orderStatus.has(orderId)) {
      throw new Error(`order already exists: ${orderId}`);
    }

    const requestedBySku = new Map<string, Qty>();
    for (const line of lines) {
      if (!Number.isInteger(line.qty) || line.qty <= 0) {
        throw new Error(`invalid quantity for ${line.sku}: ${line.qty}`);
      }
      const sku = this.catalog.get(line.sku);
      if (sku.state !== "active") {
        throw new Error(`cannot reserve discontinued sku: ${line.sku}`);
      }
      requestedBySku.set(
        line.sku,
        (requestedBySku.get(line.sku) ?? 0) + line.qty
      );
    }

    for (const [sku, qty] of requestedBySku) {
      if (qty > this.available(sku)) {
        throw new Error(`insufficient stock for ${sku}`);
      }
    }

    for (const line of lines) {
      this.movements.push({
        seq: this.nextSeq++,
        orderId,
        sku: line.sku,
        qty: -line.qty,
      });
    }
    this.orderStatus.set(orderId, "reserved");
  }

  // Cancel a previously reserved order, returning its stock to availability.
  // Safe to call more than once: cancelling an already-cancelled order is a
  // no-op. Cancelling an unknown order id is an error.
  cancel(orderId: string): void {
    const status = this.orderStatus.get(orderId);
    if (status === undefined) {
      throw new Error(`no such order: ${orderId}`);
    }
    if (status === "cancelled") {
      return;
    }

    const reserved = this.movements.filter(
      (m) => m.orderId === orderId && m.qty < 0
    );
    for (const m of reserved) {
      this.movements.push({
        seq: this.nextSeq++,
        orderId,
        sku: m.sku,
        qty: -m.qty,
      });
    }
    this.orderStatus.set(orderId, "cancelled");
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

  // Movements for a SKU whose seq falls within the inclusive [fromSeq, toSeq] range.
  history(sku: string, fromSeq: number, toSeq: number): Movement[] {
    return this.movements
      .filter((m) => m.sku === sku && m.seq >= fromSeq && m.seq <= toSeq)
      .map((m) => ({ ...m }));
  }

  getMovements(): Movement[] {
    return this.movements.map((m) => ({ ...m }));
  }
}
