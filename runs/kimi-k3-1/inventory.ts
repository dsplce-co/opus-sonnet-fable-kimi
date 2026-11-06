import { Catalog } from "./catalog";
import { Movement, Qty } from "./types";

export interface Line {
  sku: string;
  qty: Qty;
}

type OrderStatus = "active" | "cancelled";

interface OrderRecord {
  // Lines normalized at reserve time: one entry per SKU, quantities aggregated.
  lines: Line[];
  status: OrderStatus;
}

export class Inventory {
  private movements: Movement[] = [];
  private nextSeq = 0;
  private orders = new Map<string, OrderRecord>();

  constructor(private catalog: Catalog) {}

  // Reserve stock for an order: one movement per line.
  //
  // Atomic: either every line is reserved or none are (a failure leaves no
  // movements behind). Idempotent on retry: re-reserving the same orderId
  // with the same lines is a no-op; the same orderId with different lines
  // throws. Discontinued SKUs cannot be reserved.
  reserve(orderId: string, lines: Line[]): void {
    if (typeof orderId !== "string" || orderId.length === 0) {
      throw new Error("orderId must be a non-empty string");
    }
    if (!Array.isArray(lines)) {
      throw new Error("lines must be an array");
    }
    const normalized = this.normalize(lines);

    const existing = this.orders.get(orderId);
    if (existing !== undefined) {
      if (sameLines(existing.lines, normalized)) {
        return; // retry of an already-applied reservation
      }
      throw new Error(`order ${orderId} already reserved with different lines`);
    }

    // Validate everything before mutating anything.
    for (const line of normalized) {
      const sku = this.catalog.get(line.sku); // throws if unknown
      if (sku.state === "discontinued") {
        throw new Error(`sku ${line.sku} is discontinued`);
      }
      if (line.qty > this.available(line.sku)) {
        throw new Error(`insufficient stock for ${line.sku}`);
      }
    }

    for (const line of normalized) {
      this.movements.push({
        seq: this.nextSeq++,
        orderId,
        sku: line.sku,
        qty: -line.qty,
      });
    }
    this.orders.set(orderId, { lines: normalized, status: "active" });
  }

  // Cancel a previously reserved order, returning its stock to availability.
  //
  // Idempotent: cancelling an already-cancelled order is a no-op. Cancelling
  // an unknown orderId throws. Cancel is allowed on discontinued SKUs —
  // returning stock to availability is always safe. Atomic: the order's
  // lines were validated at reserve time, so the return movements below
  // cannot fail part-way.
  cancel(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order === undefined) {
      throw new Error(`no such order: ${orderId}`);
    }
    if (order.status === "cancelled") {
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
    order.status = "cancelled";
  }

  // This SKU's movements with seq in the inclusive range [fromSeq, toSeq].
  history(sku: string, fromSeq: number, toSeq: number): Movement[] {
    if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq) || fromSeq > toSeq) {
      throw new Error("history requires integer fromSeq <= toSeq");
    }
    return this.movements
      .filter((m) => m.sku === sku && m.seq >= fromSeq && m.seq <= toSeq)
      .map((m) => ({ ...m }));
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

  // Returns copies so callers cannot mutate the movement log.
  getMovements(): Movement[] {
    return this.movements.map((m) => ({ ...m }));
  }

  // Validate lines and merge duplicate SKUs into one line each.
  private normalize(lines: Line[]): Line[] {
    const bySku = new Map<string, Qty>();
    for (const line of lines) {
      if (line === null || typeof line !== "object" || typeof line.sku !== "string") {
        throw new Error("each line must be an object with a sku string");
      }
      if (!Number.isInteger(line.qty) || line.qty <= 0) {
        throw new Error(`qty for ${line.sku} must be a positive integer`);
      }
      bySku.set(line.sku, (bySku.get(line.sku) ?? 0) + line.qty);
    }
    return [...bySku.entries()].map(([sku, qty]) => ({ sku, qty }));
  }
}

function sameLines(a: Line[], b: Line[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const qtyBySku = new Map(a.map((l) => [l.sku, l.qty]));
  return b.every((l) => qtyBySku.get(l.sku) === l.qty);
}
