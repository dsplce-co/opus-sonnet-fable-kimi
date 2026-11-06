import { Sku, Qty, assertId, assertInteger } from "./types";

type MutableSku = { -readonly [K in keyof Sku]: Sku[K] };

export class Catalog {
  private bySku = new Map<string, MutableSku>();

  // Register a new SKU. `initial` and `unitPrice` must be non-negative safe
  // integers. Throws if `id` is already registered: re-adding an existing SKU
  // would silently reset its on-hand quantity underneath any reservations.
  add(id: string, initial: Qty, unitPrice: number): Sku {
    assertId(id, "sku id");
    assertInteger(initial, "initial", 0);
    assertInteger(unitPrice, "unitPrice", 0);
    if (this.bySku.has(id)) {
      throw new Error(`sku already exists: ${id}`);
    }
    const sku: MutableSku = { id, state: "active", initial, unitPrice };
    this.bySku.set(id, sku);
    return { ...sku };
  }

  // Mark a SKU discontinued. Idempotent. Throws if the SKU does not exist.
  discontinue(id: string): void {
    this.lookup(id).state = "discontinued";
  }

  // Returns a snapshot of the SKU. Throws if it does not exist.
  get(id: string): Sku {
    return { ...this.lookup(id) };
  }

  private lookup(id: string): MutableSku {
    const sku = this.bySku.get(id);
    if (sku === undefined) {
      throw new Error(`no such sku: ${id}`);
    }
    return sku;
  }
}
