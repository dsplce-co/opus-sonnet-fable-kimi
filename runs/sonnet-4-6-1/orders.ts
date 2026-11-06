import { Inventory } from "./inventory";
import { Catalog } from "./catalog";

export class OrderService {
  constructor(private inventory: Inventory, private catalog: Catalog) {}

  // Reserve `qty` units of a single SKU as one order.
  place(orderId: string, sku: string, qty: number): void {
    this.inventory.reserve(orderId, [{ sku, qty }]);
  }

  // Value of an order line in minor units, after a whole-percent discount.
  // Discount is floored (fractional cents favour the merchant).
  lineValue(sku: string, qty: number, discountPct: number): number {
    if (!Number.isInteger(qty) || qty <= 0)
      throw new Error(`qty must be a positive integer: ${qty}`);
    if (!Number.isInteger(discountPct) || discountPct < 0 || discountPct > 100)
      throw new Error(`discountPct must be an integer in [0, 100]: ${discountPct}`);
    const gross = this.catalog.get(sku).unitPrice * qty;
    // Use integer arithmetic: floor the discount amount to avoid float drift.
    const discount = Math.floor((gross * discountPct) / 100);
    return gross - discount;
  }
}
