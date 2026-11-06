// Quantities are whole units of stock: non-negative safe integers.
export type Qty = number;

export type SkuState = "active" | "discontinued";

// Public, immutable view of a SKU. The catalog hands out copies; mutating a
// copy never affects catalog state.
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
// Movements are immutable once recorded; `seq` is strictly increasing in
// insertion order and unique across the whole ledger.
export interface Movement {
  readonly seq: number;
  readonly orderId: string;
  readonly sku: string;
  readonly qty: Qty;
}

// Throws unless `value` is a safe integer >= min.
export function assertInteger(value: number, name: string, min: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got ${String(value)}`);
  }
}

// Throws unless `value` is a non-empty string.
export function assertId(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}
