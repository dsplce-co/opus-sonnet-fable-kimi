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
    // Validate inputs
    if (!Number.isInteger(qty) || qty < 0) {
      throw new Error("quantity must be a non-negative integer");
    }
    if (!Number.isInteger(discountPct) || discountPct < 0 || discountPct > 100) {
      throw new Error("discountPct must be an integer between 0 and 100");
    }

    const gross = this.catalog.get(sku).unitPrice * qty;
    // Use integer arithmetic to avoid floating point precision issues
    const discount = Math.floor((gross * discountPct) / 100);
    return gross - discount;
  }
}
