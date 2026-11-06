import { Inventory } from "./inventory";
import { Catalog } from "./catalog";
import { assertNonNegativeInteger } from "./types";

export class OrderService {
  constructor(private readonly inventory: Inventory, private readonly catalog: Catalog) {}

  // Reserve `qty` units of a single SKU as one order.
  // Validation, atomicity and retry semantics are those of Inventory.reserve.
  place(orderId: string, sku: string, qty: number): void {
    this.inventory.reserve(orderId, [{ sku, qty }]);
  }

  // Value of an order line in integer minor units, after a whole-percent
  // discount (0..100). Computed entirely in integers; the discounted value is
  // rounded half-up to the nearest minor unit.
  lineValue(sku: string, qty: number, discountPct: number): number {
    assertNonNegativeInteger("qty", qty);
    assertNonNegativeInteger("discountPct", discountPct);
    if (discountPct > 100) {
      throw new RangeError(`discountPct must be <= 100, got ${discountPct}`);
    }
    const unitPrice = this.catalog.get(sku).unitPrice;
    const gross = unitPrice * qty;
    // gross * (100 - pct) / 100, rounded half-up, without leaving the integers.
    const scaled = gross * (100 - discountPct) + 50;
    if (!Number.isSafeInteger(scaled)) {
      throw new RangeError(`line value for ${sku} exceeds the safe integer range`);
    }
    return (scaled - (scaled % 100)) / 100;
  }
}
