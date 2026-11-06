import { Inventory, Line } from "./inventory";
import { Catalog } from "./catalog";
import { assertInteger } from "./types";

export class OrderService {
  constructor(private inventory: Inventory, private catalog: Catalog) {}

  // Reserve `qty` units of a single SKU as one order. Same guarantees as
  // Inventory.reserve (atomic, validated, idempotent per order id).
  place(orderId: string, sku: string, qty: number): void {
    const lines: Line[] = [{ sku, qty }];
    this.inventory.reserve(orderId, lines);
  }

  // Value of an order line in integer minor units, after a whole-percent
  // discount in [0, 100]. Computed entirely in integer arithmetic; the result
  // is rounded half-up to the nearest minor unit. Throws on invalid input or
  // if the intermediate product would leave the safe-integer range.
  lineValue(sku: string, qty: number, discountPct: number): number {
    assertInteger(qty, "qty", 0);
    assertInteger(discountPct, "discountPct", 0);
    if (discountPct > 100) {
      throw new Error(`discountPct must be <= 100, got ${discountPct}`);
    }
    const gross = this.catalog.get(sku).unitPrice * qty;
    assertInteger(gross, "gross line value", 0);
    const scaled = gross * (100 - discountPct);
    assertInteger(scaled, "discounted line value", 0);
    return divideRoundHalfUp(scaled, 100);
  }
}

// Integer division of non-negative safe integers, rounding half-up.
function divideRoundHalfUp(numerator: number, denominator: number): number {
  const quotient = Math.floor(numerator / denominator);
  const remainder = numerator - quotient * denominator;
  return remainder * 2 >= denominator ? quotient + 1 : quotient;
}
