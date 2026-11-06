// Quantities are whole units of stock.
export type Qty = number;

export type SkuState = "active" | "discontinued";

// A snapshot of a catalog entry. Callers receive copies; mutating a copy
// never affects the catalog (use Catalog.discontinue to change state).
export interface Sku {
  readonly id: string;
  readonly state: SkuState;
  // On-hand quantity when the SKU was added, in whole units.
  readonly initial: Qty;
  // Price per unit in integer minor units (e.g. cents).
  readonly unitPrice: number;
}

// An append-only stock movement. Signed:
//   negative = stock reserved out of availability,
//   positive = stock returned to availability (a cancel).
// Movements are immutable once recorded.
export interface Movement {
  readonly seq: number;
  readonly orderId: string;
  readonly sku: string;
  readonly qty: Qty;
}

// ---- Input validation -------------------------------------------------
// All quantities and prices are whole numbers within the safe-integer range
// so that arithmetic on them is exact. Anything else (NaN, Infinity,
// fractions, values beyond 2^53) is rejected before it can reach the ledger.

export function assertInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer, got ${String(value)}`);
  }
}

export function assertNonNegativeInteger(name: string, value: unknown): asserts value is number {
  assertInteger(name, value);
  if (value < 0) {
    throw new RangeError(`${name} must be >= 0, got ${value}`);
  }
}

export function assertPositiveInteger(name: string, value: unknown): asserts value is number {
  assertInteger(name, value);
  if (value <= 0) {
    throw new RangeError(`${name} must be > 0, got ${value}`);
  }
}

export function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}
