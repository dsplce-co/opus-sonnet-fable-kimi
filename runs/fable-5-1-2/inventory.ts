import { Catalog } from "./catalog";
import { Movement, Qty } from "./types";

export interface Line {
  sku: string;
  qty: Qty;
}

interface OrderRecord {
  status: "reserved" | "cancelled";
  // Per-SKU totals of the original request, used to recognise a retry.
  totals: Map<string, Qty>;
  // The reservation movements written for this order, in seq order.
  movements: Movement[];
}

function assertPositiveInt(value: number, what: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${what} must be a positive safe integer, got ${String(value)}`);
  }
}

function assertNonEmptyString(value: string, what: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${what} must be a non-empty string`);
  }
}

function assertNumber(value: number, what: string): void {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${what} must be a number, got ${String(value)}`);
  }
}

function sameTotals(a: Map<string, Qty>, b: Map<string, Qty>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [sku, qty] of a) {
    if (b.get(sku) !== qty) {
      return false;
    }
  }
  return true;
}

export class Inventory {
  // Append-only ledger, ordered by seq. Entries are frozen once written.
  private movements: Movement[] = [];
  private nextSeq = 0;
  // Net units currently reserved per SKU (= -sum of that SKU's movement qtys).
  // Maintained by append() so available() is O(1) instead of a ledger scan.
  private reservedBySku = new Map<string, Qty>();
  // Every order ever reserved, keyed by orderId. Makes reserve() retry-safe.
  private orders = new Map<string, OrderRecord>();

  constructor(private catalog: Catalog) {}

  // Reserve stock for an order: one movement per line.
  //
  // All-or-nothing: every line is validated (ids, quantities, SKU existence and
  // lifecycle, and stock — checked on the per-SKU total when an order lists a
  // SKU more than once) before any movement is written, so a rejected order
  // leaves no partial reservation behind. Discontinued SKUs cannot be reserved.
  //
  // Retry-safe: orderId acts as an idempotency key. Re-submitting an order
  // whose per-SKU totals match the reservation already held is a no-op;
  // re-using an orderId with different lines, or one that has since been
  // cancelled, is rejected so stock is never reserved twice for one order.
  reserve(orderId: string, lines: Line[]): void {
    assertNonEmptyString(orderId, "orderId");
    const { totals: wanted, lines: snapshot } = this.normalize(lines);
    const existing = this.orders.get(orderId);
    if (existing !== undefined) {
      if (existing.status === "reserved" && sameTotals(existing.totals, wanted)) {
        return;
      }
      throw new Error(`order already exists: ${orderId} (${existing.status})`);
    }
    for (const [sku, qty] of wanted) {
      const record = this.catalog.get(sku);
      if (record.state !== "active") {
        throw new Error(`sku ${sku} is ${record.state}`);
      }
      if (qty > this.available(sku)) {
        throw new Error(`insufficient stock for ${sku}`);
      }
    }
    const movements = snapshot.map((line) => this.append(orderId, line.sku, -line.qty));
    this.orders.set(orderId, { status: "reserved", totals: wanted, movements });
  }

  // Cancel a reserved order, returning every unit it reserved to availability.
  //
  // Atomic: each of the order's SKUs is re-checked against the catalog before
  // any movement is written, so a cancel either fully applies or changes
  // nothing. Idempotent: cancelling an already-cancelled order is a no-op.
  // Cancelling an unknown order is an error, since there is nothing to return.
  //
  // Lifecycle: the returned units belong to the SKU regardless of its state.
  // Discontinuation only forbids *new* reservations, so cancelling an order
  // for a discontinued SKU still returns its stock (which then cannot be
  // reserved again). Silently dropping those units would lose stock.
  cancel(orderId: string): void {
    assertNonEmptyString(orderId, "orderId");
    const order = this.orders.get(orderId);
    if (order === undefined) {
      throw new Error(`no such order: ${orderId}`);
    }
    if (order.status === "cancelled") {
      return;
    }
    for (const sku of order.totals.keys()) {
      this.catalog.get(sku);
    }
    for (const reserved of order.movements) {
      this.append(orderId, reserved.sku, -reserved.qty);
    }
    order.status = "cancelled";
  }

  // Movements of one SKU whose seq lies in the inclusive range
  // [fromSeq, toSeq], in seq order. An empty range (fromSeq > toSeq) yields
  // an empty array. The result is a fresh array of frozen entries.
  history(sku: string, fromSeq: number, toSeq: number): Movement[] {
    assertNonEmptyString(sku, "sku");
    this.catalog.get(sku);
    assertNumber(fromSeq, "fromSeq");
    assertNumber(toSeq, "toSeq");
    return this.movements.filter((m) => m.sku === sku && m.seq >= fromSeq && m.seq <= toSeq);
  }

  // Units of a SKU currently available (initial on-hand minus net reserved).
  available(sku: string): Qty {
    return this.catalog.get(sku).initial - (this.reservedBySku.get(sku) ?? 0);
  }

  // Snapshot of the ledger in seq order. The array is a copy and each entry is
  // frozen, so callers cannot alter the ledger through it.
  getMovements(): Movement[] {
    return [...this.movements];
  }

  // Validate lines, aggregate quantities per SKU, and copy each line into a
  // plain object. Only the copies are written later, so the caller's objects
  // are read exactly once (a getter cannot report one qty to validation and
  // another to the ledger). Throws on the first invalid line; nothing has
  // been written at that point.
  private normalize(lines: Line[]): { totals: Map<string, Qty>; lines: Line[] } {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new Error("an order must have at least one line");
    }
    const totals = new Map<string, Qty>();
    const copies: Line[] = [];
    for (const line of lines) {
      if (line === null || typeof line !== "object") {
        throw new Error("each line must be an object with sku and qty");
      }
      const { sku, qty } = line;
      assertNonEmptyString(sku, "line sku");
      assertPositiveInt(qty, `quantity for ${sku}`);
      const total = (totals.get(sku) ?? 0) + qty;
      if (!Number.isSafeInteger(total)) {
        throw new Error(`total quantity for ${sku} exceeds the safe integer range`);
      }
      totals.set(sku, total);
      copies.push({ sku, qty });
    }
    return { totals, lines: copies };
  }

  private append(orderId: string, sku: string, qty: Qty): Movement {
    const movement: Movement = Object.freeze({ seq: this.nextSeq++, orderId, sku, qty });
    this.movements.push(movement);
    this.reservedBySku.set(sku, (this.reservedBySku.get(sku) ?? 0) - qty);
    return movement;
  }
}
