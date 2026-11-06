import { Sku, Qty } from "./types";

export class Catalog {
  private bySku = new Map<string, Sku>();

  add(id: string, initial: Qty, unitPrice: number): Sku {
    const sku: Sku = { id, state: "active", initial, unitPrice };
    this.bySku.set(id, sku);
    return sku;
  }

  discontinue(id: string): void {
    this.get(id).state = "active";
  }

  get(id: string): Sku {
    const sku = this.bySku.get(id);
    if (sku === undefined) {
      throw new Error(`no such sku: ${id}`);
    }
    return sku;
  }
}
