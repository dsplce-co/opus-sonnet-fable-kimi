import { Catalog, assertId, assertWholeUnits } from "./catalog";
import { Movement, Qty } from "./types";

export interface Line {
  sku: string;
  qty: Qty;
}

type OrderState = "reserved" | "cancelled";

interface OrderRecord {
  state: OrderState;
  // Net units reserved per SKU. Used to recognise a duplicate submission and
  // to reverse the order exactly, once, on cancel.
  totals: Map<string, Qty>;
}

function assertSeq(label: string, value: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a whole number, got ${String(value)}`);
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
  // The ledger. Append-only: entries are frozen, never rewritten or removed.
  private movements: Movement[] = [];
  private nextSeq = 0;
  // Per-SKU view of the ledger, in ascending seq order.
  private bySku = new Map<string, Movement[]>();
  // Running availability per SKU, kept in step with every append so that
  // `available` does not rescan the ledger. Seeded lazily from Sku.initial.
  private availableBySku = new Map<string, Qty>();
  private orders = new Map<string, OrderRecord>();

  constructor(private catalog: Catalog) {}

  // Reserve stock for an order: one movement per line.
  //
  // Atomic: every line is validated and the whole order is checked against
  // availability before any movement is appended, so a rejected order leaves
  // availability untouched.
  //
  // Retry-safe: re-submitting an order id that is already reserved, with the
  // same per-SKU totals, is a no-op rather than a second reservation. A
  // re-submission with different totals is a conflict and throws.
  reserve(orderId: string, lines: Line[]): void {
    assertId("orderId", orderId);
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new Error(`order ${orderId} must have at least one line`);
    }

    // Pass 1 - structural validation and aggregation. Values are copied into
    // `validated` and every later pass reads that copy, so a caller cannot
    // hand us an object whose getters return one qty to the check and another
    // to the commit. Deliberately does not touch the catalog, so that an
    // identical retry of an already-reserved order stays a no-op even if the
    // SKU was discontinued in the meantime.
    const totals = new Map<string, Qty>();
    const validated: Line[] = [];
    for (const line of lines) {
      if (line === null || typeof line !== "object") {
        throw new Error(`order ${orderId} has a malformed line: ${String(line)}`);
      }
      // Read each field exactly once, then validate the copy.
      const { sku, qty } = line;
      assertId(`sku in order ${orderId}`, sku);
      assertWholeUnits(`qty for ${sku} in order ${orderId}`, qty);
      if (qty === 0) {
        throw new Error(`qty for ${sku} in order ${orderId} must be at least 1`);
      }
      const running = (totals.get(sku) ?? 0) + qty;
      assertWholeUnits(`total qty for ${sku} in order ${orderId}`, running);
      totals.set(sku, running);
      validated.push({ sku, qty });
    }

    const existing = this.orders.get(orderId);
    if (existing !== undefined) {
      if (existing.state === "cancelled") {
        throw new Error(`order ${orderId} was cancelled and cannot be reserved again`);
      }
      if (!sameTotals(existing.totals, totals)) {
        throw new Error(`order ${orderId} already exists with different lines`);
      }
      return;
    }

    // Pass 2 - lifecycle and availability, checked against the order total so
    // that repeated lines for one SKU cannot overdraw it.
    for (const [sku, qty] of totals) {
      const entry = this.catalog.get(sku);
      if (entry.state !== "active") {
        throw new Error(`cannot reserve discontinued sku: ${sku}`);
      }
      const availableNow = this.available(sku);
      if (qty > availableNow) {
        throw new Error(
          `insufficient stock for ${sku}: requested ${qty}, available ${availableNow}`,
        );
      }
    }

    // Pass 3 - commit. Nothing below here can fail.
    for (const line of validated) {
      this.append(orderId, line.sku, -line.qty);
    }
    this.orders.set(orderId, { state: "reserved", totals });
  }

  // Cancel a reserved order, returning the stock it reserved to availability.
  //
  // Atomic: every SKU is re-checked before any movement is appended.
  // Idempotent: cancelling an already-cancelled order is a no-op, so the call
  // is safe to retry. Cancelling an unknown order id throws, because that is a
  // caller mistake rather than a repeat of work already done.
  //
  // Lifecycle: a discontinued SKU may still be cancelled. Discontinuing blocks
  // new reservations; refusing the return as well would strand the units in a
  // dead order forever, which is exactly the stock loss this module exists to
  // prevent. A SKU that is no longer registered at all does throw.
  //
  // The reversal is emitted per SKU, not per original line: an order with two
  // lines of the same SKU reserves twice and returns once, for the same net.
  cancel(orderId: string): void {
    assertId("orderId", orderId);
    const order = this.orders.get(orderId);
    if (order === undefined) {
      throw new Error(`no such order: ${orderId}`);
    }
    if (order.state === "cancelled") {
      return;
    }

    for (const sku of order.totals.keys()) {
      this.catalog.get(sku);
    }
    for (const [sku, qty] of order.totals) {
      this.append(orderId, sku, qty);
    }
    order.state = "cancelled";
  }

  // That SKU's movements whose seq falls in the inclusive range
  // [fromSeq, toSeq], in ascending seq order.
  //
  // seq is global across all SKUs, so a range is a window over the whole
  // ledger, not a count of this SKU's movements. An inverted range returns
  // empty. Use Number.MAX_SAFE_INTEGER as toSeq for "everything from here on".
  history(sku: string, fromSeq: number, toSeq: number): Movement[] {
    assertId("sku", sku);
    // An unknown SKU is a caller error, not an empty history.
    this.catalog.get(sku);
    assertSeq("fromSeq", fromSeq);
    assertSeq("toSeq", toSeq);
    if (fromSeq > toSeq) {
      return [];
    }
    const all = this.bySku.get(sku);
    if (all === undefined) {
      return [];
    }
    return all.filter((m) => m.seq >= fromSeq && m.seq <= toSeq);
  }

  // Units of a SKU currently available (initial on-hand plus all movements).
  available(sku: string): Qty {
    const entry = this.catalog.get(sku);
    const running = this.availableBySku.get(sku);
    return running === undefined ? entry.initial : running;
  }

  // A snapshot of the whole ledger, in ascending seq order. The array is a
  // copy and the movements are frozen, so callers cannot edit stock history.
  getMovements(): Movement[] {
    return [...this.movements];
  }

  private append(orderId: string, sku: string, qty: Qty): void {
    const next = this.available(sku) + qty;
    const movement: Movement = Object.freeze({ seq: this.nextSeq++, orderId, sku, qty });
    this.movements.push(movement);
    const forSku = this.bySku.get(sku);
    if (forSku === undefined) {
      this.bySku.set(sku, [movement]);
    } else {
      forSku.push(movement);
    }
    this.availableBySku.set(sku, next);
  }
}
