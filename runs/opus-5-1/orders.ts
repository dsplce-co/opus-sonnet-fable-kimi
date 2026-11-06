import { Inventory } from "./inventory";
import { Catalog } from "./catalog";
import { assertPositiveQty, assertSafeInteger } from "./types";

export class OrderService {
  constructor(private inventory: Inventory, private catalog: Catalog) {}

  /**
   * Reserve `qty` units of a single SKU as one order.
   *
   * Inherits `Inventory.reserve`'s guarantees: atomic, validated, and safe to
   * replay with the same orderId and quantity.
   */
  place(orderId: string, sku: string, qty: number): void {
    this.inventory.reserve(orderId, [{ sku, qty }]);
  }

  /**
   * Value of an order line in minor units, after a whole-percent discount.
   *
   * Returns an integer. The previous implementation computed
   * `gross - gross * (discountPct / 100)` in floating point and returned
   * fractional minor units: 3 x 999 less 10% yielded 2697.3, and 999 less 33%
   * yielded 669.3299999999999. Money that is not a whole number of minor units
   * cannot be charged, and such values accumulate binary rounding error as
   * they are summed across a basket.
   *
   * Rounding policy: the discount amount is rounded half-up to the nearest
   * minor unit and then subtracted, so the discount never exceeds its exact
   * value by more than half a unit and the customer-facing net is exact. All
   * intermediate arithmetic is integer-only.
   */
  lineValue(sku: string, qty: number, discountPct: number): number {
    assertPositiveQty(qty, "qty");
    assertSafeInteger(discountPct, "discountPct");
    if (discountPct < 0 || discountPct > 100) {
      // A negative discount would silently inflate the price above list, and
      // one over 100 would produce a negative line value (a refund).
      throw new RangeError(`discountPct must be between 0 and 100, got ${discountPct}`);
    }

    const unitPrice = this.catalog.get(sku).unitPrice;
    const gross = unitPrice * qty;
    assertSafeInteger(gross, `gross value for ${sku}`);

    const scaled = gross * discountPct;
    assertSafeInteger(scaled, `discount basis for ${sku}`);

    const discount = Math.round(scaled / 100);
    return gross - discount;
  }
}
