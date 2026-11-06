import { Inventory } from "./inventory";
import { Catalog } from "./catalog";

export class OrderService {
  constructor(private inventory: Inventory, private catalog: Catalog) {}

  // Reserve `qty` units of a single SKU as one order.
  place(orderId: string, sku: string, qty: number): void {
    this.inventory.reserve(orderId, [{ sku, qty }]);
  }

  // Value of an order line in minor units, after a whole-percent discount.
  lineValue(sku: string, qty: number, discountPct: number): number {
    const gross = this.catalog.get(sku).unitPrice * qty;
    // Use integer arithmetic: multiply by (100 - discountPct) then divide by 100,
    // rounding down to avoid fractional minor units.
    return Math.floor(gross * (100 - discountPct) / 100);
  }
}
