import { Catalog } from "./catalog";
import { Movement, Qty } from "./types";

export interface Line {
  sku: string;
  qty: Qty;
}

interface OrderRecord {
  lines: Line[];
  cancelled: boolean;
}

export class Inventory {
  private movements: Movement[] = [];
  private nextSeq = 0;
  private orders = new Map<string, OrderRecord>();

  constructor(private catalog: Catalog) {}

  // Reserve stock for an order: one movement per line.
  // Validates and checks availability for every line before committing any
  // movement, so a failing line never leaves a partial reservation behind.
  // Calling this again with the same orderId and lines is a no-op (safe to retry).
  reserve(orderId: string, lines: Line[]): void {
    if (lines.length === 0) {
      throw new Error("reserve requires at least one line");
    }

    const existing = this.orders.get(orderId);
    if (existing !== undefined) {
      if (existing.cancelled) {
        throw new Error(`order ${orderId} was already cancelled`);
      }
      if (this.linesEqual(existing.lines, lines)) {
        return;
      }
      throw new Error(`order ${orderId} already reserved with different lines`);
    }

    const demand = new Map<string, number>();
    for (const line of lines) {
      if (!Number.isInteger(line.qty) || line.qty <= 0) {
        throw new Error(`invalid quantity for ${line.sku}: ${line.qty}`);
      }
      const sku = this.catalog.get(line.sku);
      if (sku.state !== "active") {
        throw new Error(`sku is not active: ${line.sku}`);
      }
      demand.set(line.sku, (demand.get(line.sku) ?? 0) + line.qty);
    }

    for (const [sku, qty] of demand) {
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
    this.orders.set(orderId, {
      lines: lines.map((l) => ({ ...l })),
      cancelled: false,
    });
  }

  // Cancel a previously reserved order, returning its stock to availability.
  // Atomic (all lines are reversed together) and idempotent: cancelling an
  // already-cancelled order is a no-op, so it is safe to call more than once.
  cancel(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order === undefined) {
      throw new Error(`no such order: ${orderId}`);
    }
    if (order.cancelled) {
      return;
    }
    for (const line of order.lines) {
      this.movements.push({
        seq: this.nextSeq++,
        orderId,
        sku: line.sku,
        qty: line.qty,
      });
    }
    order.cancelled = true;
  }

  private linesEqual(a: Line[], b: Line[]): boolean {
    if (a.length !== b.length) {
      return false;
    }
    const norm = (lines: Line[]) =>
      [...lines].sort((x, y) => (x.sku < y.sku ? -1 : x.sku > y.sku ? 1 : 0));
    const na = norm(a);
    const nb = norm(b);
    return na.every((l, i) => l.sku === nb[i].sku && l.qty === nb[i].qty);
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

  // Movements for a SKU with seq in the inclusive [fromSeq, toSeq] range.
  history(sku: string, fromSeq: number, toSeq: number): Movement[] {
    this.catalog.get(sku);
    return this.movements.filter(
      (m) => m.sku === sku && m.seq >= fromSeq && m.seq <= toSeq
    );
  }
}
