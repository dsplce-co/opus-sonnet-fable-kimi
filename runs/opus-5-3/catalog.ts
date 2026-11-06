import { Sku, Qty } from "./types";

// Validates a value that must be a whole, non-negative, exactly-representable
// integer. Rejects NaN, Infinity, fractions, negatives and non-numbers (which
// untyped JavaScript callers can still pass).
export function assertWholeUnits(label: string, value: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${label} must be a whole number of units between 0 and ${Number.MAX_SAFE_INTEGER}, got ${String(value)}`,
    );
  }
}

export function assertId(label: string, id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} must be a non-empty string, got ${String(id)}`);
  }
}

export class Catalog {
  // Values are frozen. `discontinue` replaces the entry rather than mutating
  // it, so a Sku already handed to a caller can never be edited from outside.
  private bySku = new Map<string, Sku>();

  // Registers a new SKU. Throws if `id` is already registered: silently
  // overwriting an entry would retroactively change `initial`, and every
  // availability figure derived from it, for stock that has already moved.
  add(id: string, initial: Qty, unitPrice: number): Sku {
    assertId("sku id", id);
    assertWholeUnits(`initial for ${id}`, initial);
    assertWholeUnits(`unitPrice for ${id}`, unitPrice);
    if (this.bySku.has(id)) {
      throw new Error(`sku already exists: ${id}`);
    }
    const sku: Sku = Object.freeze({ id, state: "active" as const, initial, unitPrice });
    this.bySku.set(id, sku);
    return sku;
  }

  // Marks a SKU discontinued. Idempotent. Discontinuing blocks new
  // reservations; it does not block returning already-reserved stock.
  discontinue(id: string): void {
    const current = this.get(id);
    if (current.state === "discontinued") {
      return;
    }
    this.bySku.set(id, Object.freeze({ ...current, state: "discontinued" as const }));
  }

  // Returns the current immutable snapshot for `id`, or throws if unknown.
  // NOTE: the returned value is a snapshot. A reference held across a
  // `discontinue` call keeps reporting the old state; re-read to see changes.
  get(id: string): Sku {
    const sku = this.bySku.get(id);
    if (sku === undefined) {
      throw new Error(`no such sku: ${id}`);
    }
    return sku;
  }

  // True if `id` is registered. Lets callers probe without catching.
  has(id: string): boolean {
    return this.bySku.has(id);
  }
}
