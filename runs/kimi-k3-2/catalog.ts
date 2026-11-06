import { Sku, Qty } from "./types";

export class Catalog {
  private bySku = new Map<string, Sku>();

  add(id: string, initial: Qty, unitPrice: number): Sku {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`invalid sku id: ${String(id)}`);
    }
    if (!Number.isInteger(initial) || initial < 0) {
      throw new Error(`invalid initial quantity for ${id}: ${initial}`);
    }
    if (!Number.isInteger(unitPrice) || unitPrice < 0) {
      throw new Error(`invalid unit price for ${id}: ${unitPrice}`);
    }
    if (this.bySku.has(id)) {
      throw new Error(`duplicate sku: ${id}`);
    }
    const sku: Sku = { id, state: "active", initial, unitPrice };
    this.bySku.set(id, sku);
    // Return a copy so callers cannot mutate catalog state.
    return { ...sku };
  }

  discontinue(id: string): void {
    this.lookup(id).state = "discontinued";
  }

  get(id: string): Sku {
    // Return a copy so callers cannot mutate catalog state.
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
