import { Catalog } from "./catalog";
import { Movement, Qty, assertId, assertWholeNumber } from "./types";

export interface Line {
  sku: string;
  qty: Qty;
}

type OrderState = "reserved" | "cancelled";

interface OrderRecord {
  // Net demand per SKU, after folding duplicate lines of the same order.
  readonly lines: ReadonlyMap<string, Qty>;
  state: OrderState;
}

export class Inventory {
  private movements: Movement[] = [];
  private nextSeq = 0;
  // Net effect of all recorded movements, per SKU. Maintained in lockstep with
  // `movements` by the single writer `commit`, so `available` stays O(1)
  // instead of scanning an append-only log that only ever grows.
  private net = new Map<string, Qty>();
  // Per-order ledger. This is what makes reserve and cancel retry-safe: the
  // outcome for an order id is remembered, so a repeated call is recognised
  // rather than replayed.
  private orders = new Map<string, OrderRecord>();

  constructor(private catalog: Catalog) {}

  // Reserve stock for an order: one movement per distinct SKU.
  //
  // Atomic - every line is validated and the whole order checked against
  // availability before any movement is written, so a rejected reserve leaves
  // no trace and can never strand stock.
  //
  // Idempotent - replaying the same order id with the same lines is a no-op,
  // so a caller retrying after a timeout cannot double-reserve. Reusing an
  // order id for different lines is rejected rather than silently applied.
  reserve(orderId: string, lines: Line[]): void {
    assertId(orderId, "order id");
    const wanted = this.normalise(lines);

    const existing = this.orders.get(orderId);
    if (existing !== undefined) {
      if (!sameLines(existing.lines, wanted)) {
        throw new Error(`order ${orderId} already exists with different lines`);
      }
      if (existing.state === "cancelled") {
        throw new Error(`order ${orderId} was cancelled and cannot be re-reserved`);
      }
      return; // exact replay of a live reservation
    }

    for (const [sku, qty] of wanted) {
      const entry = this.catalog.get(sku); // throws on unknown sku
      if (entry.state !== "active") {
        throw new Error(`cannot reserve discontinued sku: ${sku}`);
      }
      const have = this.available(sku);
      if (qty > have) {
        throw new Error(`insufficient stock for ${sku}: wanted ${qty}, available ${have}`);
      }
    }

    this.commit(orderId, wanted, -1);
    this.orders.set(orderId, { lines: wanted, state: "reserved" });
  }

  // Units of a SKU currently available: initial on-hand plus the net of all
  // movements. Throws for an unknown SKU.
  available(sku: string): Qty {
    return this.catalog.get(sku).initial + (this.net.get(sku) ?? 0);
  }

  // Cancel a reservation, returning the stock it holds to availability.
  //
  // Atomic - the whole order is validated before any movement is written, so a
  // rejected cancel returns nothing at all rather than half the order.
  //
  // Idempotent - cancelling an already-cancelled order is a no-op, so a retry
  // cannot return the same stock twice. Cancelling an unknown order id is an
  // error, because that is a caller bug rather than a retry.
  //
  // Lifecycle - every SKU on the order must still resolve in the catalog.
  // Discontinued SKUs are deliberately still cancellable: "discontinued"
  // blocks *new* reservations, and refusing the return would strand this
  // order's stock as reserved forever, which is exactly the stock loss this
  // module exists to prevent.
  cancel(orderId: string): void {
    assertId(orderId, "order id");
    const record = this.orders.get(orderId);
    if (record === undefined) {
      throw new Error(`no such order: ${orderId}`);
    }
    if (record.state === "cancelled") {
      return;
    }
    for (const sku of record.lines.keys()) {
      this.catalog.get(sku); // throws before anything is written
    }
    this.commit(orderId, record.lines, 1);
    record.state = "cancelled";
  }

  // This SKU's movements whose seq falls in the inclusive range
  // [fromSeq, toSeq], in the order they were recorded. Returns frozen
  // movements in a fresh array, so the caller cannot edit the log.
  history(sku: string, fromSeq: number, toSeq: number): Movement[] {
    this.catalog.get(sku); // throws on unknown sku
    assertWholeNumber(fromSeq, "fromSeq", 0);
    assertWholeNumber(toSeq, "toSeq", 0);
    if (fromSeq > toSeq) {
      throw new Error(`invalid seq range: fromSeq ${fromSeq} is greater than toSeq ${toSeq}`);
    }
    return this.movements.filter((m) => m.sku === sku && m.seq >= fromSeq && m.seq <= toSeq);
  }

  // A defensive copy of the append-only log. Both the array and its elements
  // are detached from internal state, so callers cannot forge movements.
  getMovements(): Movement[] {
    return this.movements.slice();
  }

  // Collapse an order's lines into net demand per SKU, rejecting anything that
  // could drive stock negative or poison the arithmetic: non-integers, NaN,
  // Infinity, zero, negatives, and values outside exact integer range.
  //
  // Duplicate lines for one SKU are summed, so the availability check sees the
  // order's true total rather than checking each line in isolation.
  private normalise(lines: Line[]): ReadonlyMap<string, Qty> {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new Error("an order must contain at least one line");
    }
    const wanted = new Map<string, Qty>();
    for (const line of lines) {
      if (line === null || typeof line !== "object") {
        throw new Error(`invalid order line: ${String(line)}`);
      }
      assertId(line.sku, "line sku");
      assertWholeNumber(line.qty, `qty for ${line.sku}`, 1);
      const total = (wanted.get(line.sku) ?? 0) + line.qty;
      assertWholeNumber(total, `total qty for ${line.sku}`, 1);
      wanted.set(line.sku, total);
    }
    return wanted;
  }

  // The only writer of stock state. Appending the movement and moving the
  // aggregate happen together here, so the log and the aggregate cannot drift
  // apart. Callers must complete all validation before calling it.
  private commit(orderId: string, lines: ReadonlyMap<string, Qty>, sign: 1 | -1): void {
    for (const [sku, qty] of lines) {
      const signed = sign * qty;
      this.movements.push(Object.freeze({ seq: this.nextSeq++, orderId, sku, qty: signed }));
      this.net.set(sku, (this.net.get(sku) ?? 0) + signed);
    }
  }
}

function sameLines(a: ReadonlyMap<string, Qty>, b: ReadonlyMap<string, Qty>): boolean {
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
