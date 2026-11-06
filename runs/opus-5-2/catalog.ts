import { Sku, Qty, Mutable, assertId, assertWholeNumber } from "./types";

export class Catalog {
  private bySku = new Map<string, Mutable<Sku>>();

  // Register a new SKU. Ids are immutable once added: re-adding an existing id
  // is rejected, because silently replacing the entry would reset `initial`
  // underneath any movements already recorded against it.
  add(id: string, initial: Qty, unitPrice: number): Sku {
    assertId(id, "sku id");
    assertWholeNumber(initial, `initial on-hand for ${id}`, 0);
    assertWholeNumber(unitPrice, `unit price for ${id}`, 0);
    if (this.bySku.has(id)) {
      throw new Error(`sku already exists: ${id}`);
    }
    this.bySku.set(id, { id, state: "active", initial, unitPrice });
    return this.get(id);
  }

  // Move a SKU out of the active lifecycle state. Idempotent.
  discontinue(id: string): void {
    this.entry(id).state = "discontinued";
  }

  // Returns a frozen copy: callers cannot reach through the return value to
  // corrupt catalog state (notably `initial`, which anchors availability).
  get(id: string): Sku {
    return Object.freeze({ ...this.entry(id) });
  }

  has(id: string): boolean {
    assertId(id, "sku id");
    return this.bySku.has(id);
  }

  private entry(id: string): Mutable<Sku> {
    assertId(id, "sku id");
    const sku = this.bySku.get(id);
    if (sku === undefined) {
      throw new Error(`no such sku: ${id}`);
    }
    return sku;
  }
}
