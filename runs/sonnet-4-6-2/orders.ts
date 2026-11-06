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
    // Integer arithmetic: avoids floating-point drift on fractional discounts.
    return gross - Math.round(gross * discountPct / 100);
  }
}
