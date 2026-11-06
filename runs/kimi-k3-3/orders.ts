import { Inventory } from "./inventory";
import { Catalog } from "./catalog";

export class OrderService {
  constructor(private inventory: Inventory, private catalog: Catalog) {}

  // Reserve `qty` units of a single SKU as one order.
  place(orderId: string, sku: string, qty: number): void {
    this.inventory.reserve(orderId, [{ sku, qty }]);
  }

  // Value of an order line in integer minor units, after a whole-percent
  // discount. The discount amount is rounded to the nearest minor unit
  // (half up), so the result is always an exact integer.
  lineValue(sku: string, qty: number, discountPct: number): number {
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      throw new Error(`qty for ${sku} must be a positive whole number of units`);
    }
    if (typeof discountPct !== "number" || !(discountPct >= 0) || discountPct > 100) {
      throw new Error("discountPct must be between 0 and 100");
    }
    const gross = this.catalog.get(sku).unitPrice * qty;
    const discount = Math.round((gross * discountPct) / 100);
    return gross - discount;
  }
}
