import { Inventory } from "./inventory";
import { Catalog } from "./catalog";

export class OrderService {
  constructor(private inventory: Inventory, private catalog: Catalog) {}

  // Reserve `qty` units of a single SKU as one order.
  place(orderId: string, sku: string, qty: number): void {
    this.inventory.reserve(orderId, [{ sku, qty }]);
  }

  // Value of an order line in integer minor units, after a whole- or
  // fractional-percent discount. The discounted total is rounded to the
  // nearest minor unit (half up); money is never returned as a fraction.
  lineValue(sku: string, qty: number, discountPct: number): number {
    if (!Number.isInteger(qty) || qty < 0) {
      throw new Error("qty must be a non-negative integer");
    }
    if (
      typeof discountPct !== "number" ||
      !Number.isFinite(discountPct) ||
      discountPct < 0 ||
      discountPct > 100
    ) {
      throw new Error("discountPct must be a finite number in [0, 100]");
    }
    const gross = this.catalog.get(sku).unitPrice * qty;
    return Math.round((gross * (100 - discountPct)) / 100);
  }
}
