// Quantities are whole units of stock: non-negative safe integers.
// Fractional, NaN, Infinite or negative quantities are never valid.
export type Qty = number;

export type SkuState = "active" | "discontinued";

// A catalog entry. Fields are readonly: values returned by `Catalog.get` are
// frozen snapshots, so mutating them is both a type error and a runtime error.
// Re-read from the catalog rather than holding a Sku across a state change.
export interface Sku {
  readonly id: string;
  readonly state: SkuState;
  // On-hand quantity when the SKU was added, in whole units. Immutable once set.
  readonly initial: Qty;
  // Price per unit in integer minor units (e.g. cents).
  readonly unitPrice: number;
}

// An append-only stock movement. Signed:
//   negative = stock reserved out of availability,
//   positive = stock returned to availability (a cancel).
// `seq` is unique and strictly increasing across the whole ledger (all SKUs),
// so it orders movements globally, not per SKU. Movements are frozen and are
// never rewritten or removed once appended.
export interface Movement {
  readonly seq: number;
  readonly orderId: string;
  readonly sku: string;
  readonly qty: Qty;
}
