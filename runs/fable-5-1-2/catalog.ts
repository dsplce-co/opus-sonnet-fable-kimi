import { Sku, Qty } from "./types";

function assertNonNegativeInt(value: number, what: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${what} must be a non-negative safe integer, got ${String(value)}`);
  }
}

function assertId(id: string, what: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${what} must be a non-empty string`);
  }
}

export class Catalog {
  private bySku = new Map<string, Sku>();

  // Register a new SKU. Duplicate ids are rejected: silently re-adding a SKU
  // would reset its on-hand quantity underneath any existing reservations.
  // Returns a snapshot of the stored record (see get()).
  add(id: string, initial: Qty, unitPrice: number): Sku {
    assertId(id, "sku id");
    assertNonNegativeInt(initial, "initial quantity");
    assertNonNegativeInt(unitPrice, "unit price");
    if (this.bySku.has(id)) {
      throw new Error(`sku already exists: ${id}`);
    }
    const sku: Sku = { id, state: "active", initial, unitPrice };
    this.bySku.set(id, sku);
    return { ...sku };
  }

  // Idempotent: discontinuing an already-discontinued SKU is a no-op.
  discontinue(id: string): void {
    this.require(id).state = "discontinued";
  }

  // Returns a snapshot. Mutating the returned object does not affect the
  // catalog; the only way to change a SKU is through Catalog methods.
  get(id: string): Sku {
    return { ...this.require(id) };
  }

  private require(id: string): Sku {
    const sku = this.bySku.get(id);
    if (sku === undefined) {
      throw new Error(`no such sku: ${id}`);
    }
    return sku;
  }
}
