import { Inventory } from "./inventory";
import { Catalog } from "./catalog";

function assertNonNegativeInt(value: number, what: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${what} must be a non-negative safe integer, got ${String(value)}`);
  }
}

export class OrderService {
  constructor(private inventory: Inventory, private catalog: Catalog) {}

  // Reserve `qty` units of a single SKU as one order.
  place(orderId: string, sku: string, qty: number): void {
    this.inventory.reserve(orderId, [{ sku, qty }]);
  }

  // Value of an order line in minor units, after a whole-percent discount.
  //
  // Computed in integers: unitPrice * qty * (100 - discountPct) is exact, and
  // only the final division by 100 can produce a fraction. That last step is
  // rounded half-up to the nearest minor unit, so the result is always a
  // whole number of minor units. discountPct must be an integer in [0, 100].
  lineValue(sku: string, qty: number, discountPct: number): number {
    assertNonNegativeInt(qty, "qty");
    assertNonNegativeInt(discountPct, "discountPct");
    if (discountPct > 100) {
      throw new Error(`discountPct must be between 0 and 100, got ${discountPct}`);
    }
    const gross = this.catalog.get(sku).unitPrice * qty;
    const scaled = gross * (100 - discountPct);
    if (!Number.isSafeInteger(gross) || !Number.isSafeInteger(scaled)) {
      throw new Error(`line value for ${sku} exceeds the safe integer range`);
    }
    return Math.round(scaled / 100);
  }
}
