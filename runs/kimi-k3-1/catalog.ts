import { Sku, Qty } from "./types";

export class Catalog {
  private bySku = new Map<string, Sku>();

  add(id: string, initial: Qty, unitPrice: number): Sku {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("sku id must be a non-empty string");
    }
    if (this.bySku.has(id)) {
      throw new Error(`duplicate sku: ${id}`);
    }
    if (!Number.isInteger(initial) || initial < 0) {
      throw new Error(`initial quantity for ${id} must be a non-negative integer`);
    }
    if (!Number.isInteger(unitPrice) || unitPrice < 0) {
      throw new Error(`unit price for ${id} must be a non-negative integer (minor units)`);
    }
    const sku: Sku = { id, state: "active", initial, unitPrice };
    this.bySku.set(id, sku);
    return { ...sku };
  }

  discontinue(id: string): void {
    this.mustGet(id).state = "discontinued";
  }

  // Returns a copy so callers cannot mutate catalog state.
  get(id: string): Sku {
    return { ...this.mustGet(id) };
  }

  private mustGet(id: string): Sku {
    const sku = this.bySku.get(id);
    if (sku === undefined) {
      throw new Error(`no such sku: ${id}`);
    }
    return sku;
  }
}
