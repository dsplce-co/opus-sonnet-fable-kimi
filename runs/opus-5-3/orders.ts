import { Inventory } from "./inventory";
import { Catalog, assertWholeUnits } from "./catalog";

export class OrderService {
  constructor(private inventory: Inventory, private catalog: Catalog) {}

  // Reserve `qty` units of a single SKU as one order.
  // Inherits the atomicity and retry-safety of Inventory.reserve: placing the
  // same orderId twice with the same qty is a no-op, not a second reservation.
  place(orderId: string, sku: string, qty: number): void {
    this.inventory.reserve(orderId, [{ sku, qty }]);
  }

  // Value of an order line in minor units, after a whole-percent discount.
  //
  // Always returns an exact integer number of minor units. The discount is
  // computed in integer arithmetic and rounded half-up, so the result never
  // carries a fraction of a cent that would later be silently truncated by a
  // payment or ledger system.
  //
  // Valuing a discontinued SKU is allowed: historical lines still need pricing.
  lineValue(sku: string, qty: number, discountPct: number): number {
    assertWholeUnits(`qty for ${sku}`, qty);
    if (
      typeof discountPct !== "number" ||
      !Number.isInteger(discountPct) ||
      discountPct < 0 ||
      discountPct > 100
    ) {
      throw new Error(
        `discountPct must be a whole percent between 0 and 100, got ${String(discountPct)}`,
      );
    }

    const gross = this.catalog.get(sku).unitPrice * qty;
    // Guard both the line total and the intermediate used for the discount:
    // beyond the safe range, integer arithmetic silently loses units.
    if (!Number.isSafeInteger(gross) || !Number.isSafeInteger(gross * discountPct)) {
      throw new Error(`line value for ${sku} exceeds the exactly representable range`);
    }

    // Exact integer half-up rounding: `%` and the multiple-of-100 division are
    // both exact for safe integers, so no floating point error can creep in.
    const scaled = gross * discountPct;
    const remainder = scaled % 100;
    const discount = (scaled - remainder) / 100 + (remainder * 2 >= 100 ? 1 : 0);
    return gross - discount;
  }
}
