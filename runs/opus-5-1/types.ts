// Quantities are whole units of stock.
export type Qty = number;

export type SkuState = "active" | "discontinued";

export interface Sku {
  id: string;
  state: SkuState;
  // On-hand quantity when the SKU was added, in whole units.
  initial: Qty;
  // Price per unit in integer minor units (e.g. cents).
  unitPrice: number;
}

// An append-only stock movement. Signed:
//   negative = stock reserved out of availability,
//   positive = stock returned to availability (a cancel).
export interface Movement {
  seq: number;
  orderId: string;
  sku: string;
  qty: Qty;
}

// ---------------------------------------------------------------------------
// Runtime guards.
//
// This module is the system of record for physical stock, so every value that
// crosses a public boundary is validated here rather than trusted. TypeScript
// types are erased at runtime and callers may be untyped (JSON bodies, JS
// callers, `any`), so `number` alone guarantees nothing: NaN, Infinity,
// fractions and negatives all satisfy it and each one silently corrupts the
// ledger. See REPORT.md for the failures these prevent.
// ---------------------------------------------------------------------------

// Largest magnitude accepted for any quantity or money value. Staying well
// inside Number.MAX_SAFE_INTEGER keeps sums exact: beyond 2^53-1, integer
// addition silently stops being associative and stock totals drift.
export const MAX_SAFE_UNITS = Number.MAX_SAFE_INTEGER;

/** Throws unless `value` is a finite, whole, safe integer. */
export function assertSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number, got ${String(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new RangeError(`${label} must be a whole number, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} exceeds the safe integer range, got ${value}`);
  }
}

/** Throws unless `value` is a whole number of units >= 0. */
export function assertNonNegativeQty(value: unknown, label: string): asserts value is Qty {
  assertSafeInteger(value, label);
  if (value < 0) {
    throw new RangeError(`${label} must not be negative, got ${value}`);
  }
}

/** Throws unless `value` is a whole number of units >= 1. */
export function assertPositiveQty(value: unknown, label: string): asserts value is Qty {
  assertNonNegativeQty(value, label);
  if (value === 0) {
    throw new RangeError(`${label} must be greater than zero`);
  }
}

/** Throws unless `value` is a non-empty string identifier. */
export function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string, got ${typeof value}`);
  }
  if (value.length === 0) {
    throw new RangeError(`${label} must not be empty`);
  }
}
