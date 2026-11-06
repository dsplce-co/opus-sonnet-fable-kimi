import { Sku, Qty, assertNonEmptyString, assertNonNegativeInteger } from "./types";

export class Catalog {
  private readonly bySku = new Map<string, Sku>();

  // Register a new SKU. Adding an id that already exists is an error: it
  // would otherwise silently reset that SKU's on-hand quantity and price.
  add(id: string, initial: Qty, unitPrice: number): Sku {
    assertNonEmptyString("sku id", id);
    assertNonNegativeInteger("initial", initial);
    assertNonNegativeInteger("unitPrice", unitPrice);
    if (this.bySku.has(id)) {
      throw new Error(`sku already exists: ${id}`);
    }
    const sku: Sku = { id, state: "active", initial, unitPrice };
    this.bySku.set(id, sku);
    return { ...sku };
  }

  // Mark a SKU discontinued. Idempotent: discontinuing twice is a no-op.
  discontinue(id: string): void {
    const sku = this.lookup(id);
    if (sku.state !== "discontinued") {
      this.bySku.set(id, { ...sku, state: "discontinued" });
    }
  }

  // Returns a snapshot copy; mutating it does not affect the catalog.
  get(id: string): Sku {
    return { ...this.lookup(id) };
  }

  private lookup(id: string): Sku {
    const sku = this.bySku.get(id);
    if (sku === undefined) {
      throw new Error(`no such sku: ${id}`);
    }
    return sku;
  }
}
