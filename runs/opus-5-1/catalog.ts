import { Sku, Qty, assertId, assertNonNegativeQty } from "./types";

export class Catalog {
  private bySku = new Map<string, Sku>();

  /**
   * Register a new SKU.
   *
   * Re-adding an existing id is rejected. Overwriting a SKU that already has
   * movements against it would silently redefine the `initial` on-hand figure
   * that `Inventory.available` is derived from, retroactively creating or
   * destroying stock (and driving availability negative). Correcting a live
   * SKU is a deliberate, auditable operation, not a side effect of `add`.
   *
   * Returns a frozen snapshot; see `get` for why.
   */
  add(id: string, initial: Qty, unitPrice: number): Sku {
    assertId(id, "sku id");
    assertNonNegativeQty(initial, `initial quantity for ${id}`);
    assertNonNegativeQty(unitPrice, `unit price for ${id}`);
    if (this.bySku.has(id)) {
      throw new Error(`sku already exists: ${id}`);
    }
    const sku: Sku = { id, state: "active", initial, unitPrice };
    this.bySku.set(id, sku);
    return Object.freeze({ ...sku });
  }

  /**
   * Mark a SKU discontinued. Idempotent: discontinuing twice is a no-op, so
   * the call is safe to retry.
   */
  discontinue(id: string): void {
    const sku = this.lookup(id);
    sku.state = "discontinued";
  }

  /**
   * Look up a SKU.
   *
   * Returns a frozen copy, not the stored object. Handing out the live record
   * let any caller write `catalog.get(id).initial = 1e9` or flip `state` back
   * to "active", corrupting stock arithmetic from outside the module with no
   * audit trail. Mutating the returned object now throws (ES modules are
   * strict mode) instead of silently succeeding.
   *
   * BREAKING: callers that mutated the result of `get` must use `discontinue`.
   */
  get(id: string): Sku {
    return Object.freeze({ ...this.lookup(id) });
  }

  /** Internal live-record access. Never escapes the class. */
  private lookup(id: string): Sku {
    assertId(id, "sku id");
    const sku = this.bySku.get(id);
    if (sku === undefined) {
      throw new Error(`no such sku: ${id}`);
    }
    return sku;
  }
}
