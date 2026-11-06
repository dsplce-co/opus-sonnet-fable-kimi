import { Catalog } from "./catalog";
import { Movement, Qty } from "./types";

export interface Line {
  sku: string;
  qty: Qty;
}

type OrderStatus = "reserved" | "cancelled";

interface OrderRecord {
  lines: Line[];
  status: OrderStatus;
}

// Aggregates lines by SKU (order and per-SKU splitting don't matter for
// deciding whether a retried reserve() call describes the same order).
function linesBySku(lines: Line[]): [string, number][] {
  const totals = new Map<string, number>();
  for (const line of lines) {
    totals.set(line.sku, (totals.get(line.sku) ?? 0) + line.qty);
  }
  return [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function sameLines(a: Line[], b: Line[]): boolean {
  const na = linesBySku(a);
  const nb = linesBySku(b);
  if (na.length !== nb.length) {
    return false;
  }
  return na.every(([sku, qty], i) => nb[i][0] === sku && nb[i][1] === qty);
}

export class Inventory {
  private movements: Movement[] = [];
  private nextSeq = 0;
  private orders = new Map<string, OrderRecord>();

  constructor(private catalog: Catalog) {}

  // Reserve stock for an order: one movement per line, all-or-nothing.
  // Safe to retry: calling again with the same orderId and the same lines
  // is a no-op; calling with the same orderId and different lines is
  // rejected as a conflict.
  reserve(orderId: string, lines: Line[]): void {
    if (lines.length === 0) {
      throw new Error("reserve requires at least one line");
    }

    const existing = this.orders.get(orderId);
    if (existing !== undefined) {
      if (existing.status === "cancelled") {
        throw new Error(`order already cancelled: ${orderId}`);
      }
      if (sameLines(existing.lines, lines)) {
        return;
      }
      throw new Error(`order already exists with different lines: ${orderId}`);
    }

    // Validate every line before committing anything, so a failure on
    // line N never leaves lines 1..N-1 partially reserved. Quantities for
    // repeated SKUs are aggregated so multi-line same-SKU orders are
    // checked against actual available stock, not stale line-by-line
    // snapshots.
    const requested = new Map<string, number>();
    for (const line of lines) {
      if (!Number.isInteger(line.qty) || line.qty <= 0) {
        throw new Error(`invalid quantity for ${line.sku}: ${line.qty}`);
      }
      const sku = this.catalog.get(line.sku);
      if (sku.state !== "active") {
        throw new Error(`sku is not active: ${line.sku}`);
      }
      requested.set(line.sku, (requested.get(line.sku) ?? 0) + line.qty);
    }
    for (const [sku, qty] of requested) {
      if (qty > this.available(sku)) {
        throw new Error(`insufficient stock for ${sku}`);
      }
    }

    const committed: Movement[] = lines.map((line) => ({
      seq: this.nextSeq++,
      orderId,
      sku: line.sku,
      qty: -line.qty,
    }));
    this.movements.push(...committed);
    this.orders.set(orderId, {
      lines: lines.map((l) => ({ ...l })),
      status: "reserved",
    });
  }

  // Cancel a previously reserved order, returning its stock to
  // availability. Atomic (all lines reversed together), and safe to call
  // more than once: cancelling an already-cancelled order is a no-op.
  // Works regardless of the SKU's current lifecycle state, since it
  // reverses an existing reservation rather than creating a new one.
  cancel(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order === undefined) {
      throw new Error(`no such order: ${orderId}`);
    }
    if (order.status === "cancelled") {
      return;
    }

    const reversal: Movement[] = order.lines.map((line) => ({
      seq: this.nextSeq++,
      orderId,
      sku: line.sku,
      qty: line.qty,
    }));
    this.movements.push(...reversal);
    order.status = "cancelled";
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

  // Movements for a SKU whose seq falls within the inclusive range.
  history(sku: string, fromSeq: number, toSeq: number): Movement[] {
    this.catalog.get(sku);
    return this.movements
      .filter((m) => m.sku === sku && m.seq >= fromSeq && m.seq <= toSeq)
      .map((m) => ({ ...m }));
  }

  getMovements(): Movement[] {
    return this.movements.map((m) => ({ ...m }));
  }
}
