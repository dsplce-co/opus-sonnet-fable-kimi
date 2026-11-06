// Quantities are whole units of stock.
export type Qty = number;

export type SkuState = "active" | "discontinued";

// A catalog entry. Public shape is deeply read-only: callers receive frozen
// copies, so catalog state can only change through Catalog's own methods.
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
export interface Movement {
  readonly seq: number;
  readonly orderId: string;
  readonly sku: string;
  readonly qty: Qty;
}

// Internal, writable view of a Sku. Never handed out past a module boundary.
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// ---------------------------------------------------------------------------
// Input validation
//
// Every public entry point validates its arguments before touching state. The
// module is assumed to sit behind an API boundary, so inputs are treated as
// untrusted: a rejected call must leave state exactly as it was.
// ---------------------------------------------------------------------------

function show(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

export function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string, got ${show(value)}`);
  }
}

// Whole units / integer minor units. Rejects NaN, Infinity, fractions, and
// magnitudes beyond exact float64 integer range (where +1 stops being +1).
export function assertWholeNumber(
  value: unknown,
  label: string,
  min: number,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a whole number within safe integer range, got ${show(value)}`);
  }
  if (value < min) {
    throw new Error(`${label} must be >= ${min}, got ${value}`);
  }
}
