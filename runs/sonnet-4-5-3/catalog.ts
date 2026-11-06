import { Sku, Qty } from "./types";

export class Catalog {
  private bySku = new Map<string, Sku>();

  add(id: string, initial: Qty, unitPrice: number): Sku {
    if (!id || typeof id !== "string") {
      throw new Error("SKU id is required");
    }
    if (!Number.isInteger(initial) || initial < 0) {
      throw new Error("initial stock must be a non-negative integer");
    }
    if (!Number.isInteger(unitPrice) || unitPrice < 0) {
      throw new Error("unitPrice must be a non-negative integer");
    }
    if (this.bySku.has(id)) {
      throw new Error(`SKU ${id} already exists`);
    }

    const sku: Sku = { id, state: "active", initial, unitPrice };
    this.bySku.set(id, sku);
    return { ...sku }; // Return a copy to prevent mutation
  }

  discontinue(id: string): void {
    const sku = this.bySku.get(id);
    if (sku === undefined) {
      throw new Error(`no such sku: ${id}`);
    }
    sku.state = "discontinued";
  }

  get(id: string): Sku {
    const sku = this.bySku.get(id);
    if (sku === undefined) {
      throw new Error(`no such sku: ${id}`);
    }
    // Return a defensive copy to prevent external mutation
    return { ...sku };
  }
}
