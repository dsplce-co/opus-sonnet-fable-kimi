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
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new Error(`invalid quantity: ${qty}`);
    }
    if (!Number.isInteger(discountPct) || discountPct < 0 || discountPct > 100) {
      throw new Error(`invalid discount percentage: ${discountPct}`);
    }
    const gross = this.catalog.get(sku).unitPrice * qty;
    const discount = Math.round((gross * discountPct) / 100);
    return gross - discount;
  }
}
