import { Sku, Qty } from "./types";

export class Catalog {
  private bySku = new Map<string, Sku>();

  add(id: string, initial: Qty, unitPrice: number): Sku {
    if (!id || id.trim() === "") {
      throw new Error("SKU id cannot be empty");
    }
    if (this.bySku.has(id)) {
      throw new Error(`SKU ${id} already exists`);
    }
    if (typeof initial !== "number" || !Number.isInteger(initial)) {
      throw new Error("initial quantity must be an integer");
    }
    if (initial < 0) {
      throw new Error("initial quantity cannot be negative");
    }
    if (typeof unitPrice !== "number" || !Number.isInteger(unitPrice)) {
      throw new Error("unitPrice must be an integer (minor units)");
    }
    if (unitPrice < 0) {
      throw new Error("unitPrice cannot be negative");
    }

    const sku: Sku = { id, state: "active", initial, unitPrice };
    this.bySku.set(id, sku);
    return { ...sku };
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
    return { ...sku };
  }
}
