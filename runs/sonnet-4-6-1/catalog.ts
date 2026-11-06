import { Sku, Qty } from "./types";

export class Catalog {
  private bySku = new Map<string, Sku>();

  add(id: string, initial: Qty, unitPrice: number): Sku {
    if (!id) throw new Error("sku id must be non-empty");
    if (!Number.isInteger(initial) || initial < 0)
      throw new Error(`initial qty must be a non-negative integer: ${initial}`);
    if (!Number.isInteger(unitPrice) || unitPrice <= 0)
      throw new Error(`unitPrice must be a positive integer: ${unitPrice}`);
    if (this.bySku.has(id)) throw new Error(`sku already exists: ${id}`);

    const sku: Sku = { id, state: "active", initial, unitPrice };
    this.bySku.set(id, sku);
    return { ...sku };
  }

  discontinue(id: string): void {
    const sku = this.bySku.get(id);
    if (sku === undefined) throw new Error(`no such sku: ${id}`);
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
