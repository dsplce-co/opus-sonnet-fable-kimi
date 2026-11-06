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
