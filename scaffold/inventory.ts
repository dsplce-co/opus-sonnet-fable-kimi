import { Catalog } from "./catalog";
import { Movement, Qty } from "./types";

export interface Line {
  sku: string;
  qty: Qty;
}

export class Inventory {
  private movements: Movement[] = [];
  private nextSeq = 0;

  constructor(private catalog: Catalog) {}

  // Reserve stock for an order: one movement per line.
  reserve(orderId: string, lines: Line[]): void {
    for (const line of lines) {
      this.catalog.get(line.sku);
      if (line.qty > this.available(line.sku)) {
        throw new Error(`insufficient stock for ${line.sku}`);
      }
      this.movements.push({
        seq: this.nextSeq++,
        orderId,
        sku: line.sku,
        qty: -line.qty,
      });
    }
  }

  // Units of a SKU currently available (initial on-hand plus all movements).
  available(sku: string): Qty {
    let q = this.catalog.get(sku).initial;
    for (const m of this.movements) {
      if (m.sku === sku) {
        q += m.qty;
      }
    }
    return q;
  }

  getMovements(): Movement[] {
    return this.movements;
  }
}
