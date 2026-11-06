import { Sku, Qty } from "./types";

export class Catalog {
  private bySku = new Map<string, Sku>();

  add(id: string, initial: Qty, unitPrice: number): Sku {
    if (!id) {
      throw new Error("sku id must be a non-empty string");
    }
    if (this.bySku.has(id)) {
      throw new Error(`sku already exists: ${id}`);
    }
    if (!Number.isInteger(initial) || initial < 0) {
      throw new Error(`invalid initial quantity for ${id}: ${initial}`);
    }
    if (!Number.isInteger(unitPrice) || unitPrice < 0) {
      throw new Error(`invalid unit price for ${id}: ${unitPrice}`);
    }
    const sku: Sku = { id, state: "active", initial, unitPrice };
    this.bySku.set(id, sku);
    return { ...sku };
  }

  discontinue(id: string): void {
    this.getInternal(id).state = "discontinued";
  }

  get(id: string): Sku {
    return { ...this.getInternal(id) };
  }

  // Returns the live record so internal mutation (discontinue) can act on
  // it. Never expose this reference to callers outside the class.
  private getInternal(id: string): Sku {
    const sku = this.bySku.get(id);
    if (sku === undefined) {
      throw new Error(`no such sku: ${id}`);
    }
    return sku;
  }
}
