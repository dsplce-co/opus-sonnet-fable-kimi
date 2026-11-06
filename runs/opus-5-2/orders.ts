import { Inventory } from "./inventory";
import { Catalog } from "./catalog";
import { assertWholeNumber } from "./types";

export class OrderService {
  constructor(private inventory: Inventory, private catalog: Catalog) {}

  // Reserve `qty` units of a single SKU as one order. Inherits reserve's
  // atomicity, idempotency and validation.
  place(orderId: string, sku: string, qty: number): void {
    this.inventory.reserve(orderId, [{ sku, qty }]);
  }

  // Cancel a previously placed order, returning its stock to availability.
  cancel(orderId: string): void {
    this.inventory.cancel(orderId);
  }

  // Value of an order line in minor units, after a whole-percent discount.
  //
  // Money stays in integer minor units end to end. The discount is rounded to
  // a whole minor unit (half away from zero) and subtracted, rather than
  // scaling the gross by a float: that keeps the result an exact integer, and
  // guarantees 0% returns the full gross and 100% returns exactly zero.
  lineValue(sku: string, qty: number, discountPct: number): number {
    const unitPrice = this.catalog.get(sku).unitPrice;
    assertWholeNumber(qty, `qty for ${sku}`, 0);
    assertWholeNumber(discountPct, "discount percent", 0);
    if (discountPct > 100) {
      throw new Error(`discount percent must be <= 100, got ${discountPct}`);
    }

    const gross = unitPrice * qty;
    if (!Number.isSafeInteger(gross)) {
      throw new Error(`line value for ${sku} exceeds safe integer range`);
    }
    const discount = Math.round((gross * discountPct) / 100);
    return gross - discount;
  }
}
