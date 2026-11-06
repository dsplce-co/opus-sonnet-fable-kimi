import { describe, it, expect } from "vitest";
import { Catalog } from "./catalog";
import { Inventory } from "./inventory";
import { OrderService } from "./orders";
import { Movement } from "./types";

// Assertions check OBSERVABLE END-STATE (availability, movement-log invariants) —
// never exception type or mechanism, so any correct resolution (validate-first,
// rollback, reject) passes equally.
function skuNet(inv: Inventory, sku: string): number {
  return inv
    .getMovements()
    .filter((m) => m.sku === sku)
    .reduce((s, m) => s + Number(m.qty), 0);
}
function tryOp(fn: () => void): void {
  try {
    fn();
  } catch {
    // failure is an acceptable resolution; we assert end-state below
  }
}

describe("hidden: silent defects", () => {
  it("D1: an order with a later invalid line leaves earlier lines unapplied", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 500);
    const inv = new Inventory(catalog);
    const before = inv.available("a");
    tryOp(() =>
      inv.reserve("o1", [
        { sku: "a", qty: 10 },
        { sku: "ghost", qty: 5 },
      ])
    );
    expect(inv.available("a")).toBe(before); // no partial reservation left behind
    expect(skuNet(inv, "a")).toBe(0);
  });

  it("D2: mutating the array from getMovements() does not corrupt availability", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 10 }]);
    const before = inv.available("a");
    const leaked = inv.getMovements();
    leaked.push({ seq: 9999, orderId: "hack", sku: "a", qty: -999999 } as Movement);
    expect(inv.available("a")).toBe(before);
  });

  it("D3: invalid quantities never corrupt stock", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 500);
    const inv = new Inventory(catalog);
    const before = inv.available("a");
    tryOp(() => inv.reserve("o1", [{ sku: "a", qty: 0.5 }]));
    tryOp(() => inv.reserve("o2", [{ sku: "a", qty: NaN }]));
    tryOp(() => inv.reserve("o3", [{ sku: "a", qty: -20 }]));
    for (const m of inv.getMovements()) {
      expect(Number.isInteger(Number(m.qty))).toBe(true);
    }
    expect(inv.available("a")).toBe(before); // no change, and no inflation from a negative qty
    expect(inv.available("a")).toBeLessThanOrEqual(100);
  });

  it("D4: reserving a discontinued SKU makes no change", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 500);
    catalog.discontinue("a");
    const inv = new Inventory(catalog);
    tryOp(() => inv.reserve("o1", [{ sku: "a", qty: 10 }]));
    expect(inv.available("a")).toBe(100);
  });

  it("D5: reserving the same order twice does not double-reserve", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 10 }]);
    tryOp(() => inv.reserve("o1", [{ sku: "a", qty: 10 }]));
    expect(inv.available("a")).toBe(90);
  });

  it("D6: a multi-line order that oversells one line reserves nothing", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 500);
    catalog.add("b", 5, 500);
    const inv = new Inventory(catalog);
    tryOp(() =>
      inv.reserve("o1", [
        { sku: "a", qty: 10 },
        { sku: "b", qty: 50 },
      ])
    );
    expect(inv.available("a")).toBe(100);
    expect(inv.available("b")).toBe(5);
  });

  it("D7: reserving exactly the available quantity succeeds", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 10 }]);
    expect(inv.available("a")).toBe(0);
  });

  it("D8: a discounted line value is an exact integer number of minor units", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 333);
    const inv = new Inventory(catalog);
    const orders = new OrderService(inv, catalog);
    expect(Number.isInteger(orders.lineValue("a", 1, 10))).toBe(true);
  });

  it("D9: two lines of the same SKU that together oversell reserve nothing", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 500);
    const inv = new Inventory(catalog);
    tryOp(() =>
      inv.reserve("o1", [
        { sku: "a", qty: 60 },
        { sku: "a", qty: 60 },
      ])
    );
    expect(inv.available("a")).toBe(100); // aggregate demand (120) exceeds stock (100)
    expect(inv.available("a")).toBeGreaterThanOrEqual(0);
  });
});
