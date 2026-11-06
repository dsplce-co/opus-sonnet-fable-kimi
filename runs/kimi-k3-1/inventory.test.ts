import { describe, it, expect } from "vitest";
import { Catalog } from "./catalog";
import { Inventory } from "./inventory";
import { OrderService } from "./orders";

describe("inventory", () => {
  it("adds a SKU in the active state", () => {
    const catalog = new Catalog();
    const sku = catalog.add("widget", 100, 500);
    expect(sku.state).toBe("active");
  });

  it("discontinue marks the SKU discontinued", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    catalog.discontinue("widget");
    expect(catalog.get("widget").state).toBe("discontinued");
  });

  it("reserving stock reduces availability", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    const orders = new OrderService(inv, catalog);
    orders.place("o1", "widget", 30);
    expect(inv.available("widget")).toBe(70);
  });

  it("available reflects the initial on-hand quantity", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    expect(inv.available("widget")).toBe(100);
  });

  it("an order cannot reserve more than is available", () => {
    const catalog = new Catalog();
    catalog.add("widget", 10, 500);
    const inv = new Inventory(catalog);
    const orders = new OrderService(inv, catalog);
    expect(() => orders.place("o1", "widget", 25)).toThrow();
  });
});

describe("catalog integrity", () => {
  it("rejects a duplicate SKU id", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    expect(() => catalog.add("widget", 50, 300)).toThrow();
  });

  it("rejects negative or fractional initial stock and price", () => {
    const catalog = new Catalog();
    expect(() => catalog.add("a", -1, 500)).toThrow();
    expect(() => catalog.add("b", 1.5, 500)).toThrow();
    expect(() => catalog.add("c", 10, -500)).toThrow();
    expect(() => catalog.add("d", 10, 4.99)).toThrow();
  });

  it("get returns a copy; mutating it does not corrupt catalog state", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    catalog.get("widget").state = "discontinued";
    expect(catalog.get("widget").state).toBe("active");
  });
});

describe("reserve hardening", () => {
  it("a failed multi-line order reserves nothing (atomic)", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 100);
    catalog.add("b", 1, 100);
    const inv = new Inventory(catalog);
    expect(() =>
      inv.reserve("o1", [
        { sku: "a", qty: 5 },
        { sku: "b", qty: 5 },
      ]),
    ).toThrow();
    expect(inv.available("a")).toBe(10);
    expect(inv.available("b")).toBe(1);
    expect(inv.getMovements()).toHaveLength(0);
  });

  it("rejects zero, negative, and fractional quantities", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 0 }])).toThrow();
    expect(() => inv.reserve("o2", [{ sku: "widget", qty: -5 }])).toThrow();
    expect(() => inv.reserve("o3", [{ sku: "widget", qty: 1.5 }])).toThrow();
    expect(inv.available("widget")).toBe(100);
  });

  it("retrying the same order with the same lines is a no-op", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    expect(inv.available("widget")).toBe(70);
    expect(inv.getMovements()).toHaveLength(1);
  });

  it("reusing an order id with different lines throws", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 10 }])).toThrow();
    expect(inv.available("widget")).toBe(70);
  });

  it("cannot reserve a discontinued SKU", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    catalog.discontinue("widget");
    const inv = new Inventory(catalog);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 1 }])).toThrow();
  });

  it("getMovements returns copies; mutating them does not corrupt state", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    const movements = inv.getMovements();
    movements[0].qty = -100;
    movements.length = 0;
    expect(inv.available("widget")).toBe(70);
    expect(inv.getMovements()).toHaveLength(1);
  });
});

describe("cancel", () => {
  it("returns the reserved stock to availability", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
  });

  it("is safe to call more than once", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.cancel("o1");
    inv.cancel("o1");
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
    expect(inv.getMovements()).toHaveLength(2);
  });

  it("throws for an unknown order id", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    expect(() => inv.cancel("nope")).toThrow();
  });

  it("works after the SKU has been discontinued", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    catalog.discontinue("widget");
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
  });

  it("frees the stock for a subsequent order", () => {
    const catalog = new Catalog();
    catalog.add("widget", 10, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 10 }]);
    inv.cancel("o1");
    inv.reserve("o2", [{ sku: "widget", qty: 10 }]);
    expect(inv.available("widget")).toBe(0);
  });
});

describe("history", () => {
  it("returns movements in the inclusive [fromSeq, toSeq] range", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 10 }]); // seq 0
    inv.reserve("o2", [{ sku: "widget", qty: 20 }]); // seq 1
    inv.cancel("o1"); // seq 2
    const h = inv.history("widget", 1, 2);
    expect(h.map((m) => m.seq)).toEqual([1, 2]);
    expect(h.map((m) => m.qty)).toEqual([-20, 10]);
  });

  it("excludes other SKUs and out-of-range seqs", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 100);
    catalog.add("b", 100, 100);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [
      { sku: "a", qty: 5 }, // seq 0
      { sku: "b", qty: 5 }, // seq 1
    ]);
    inv.reserve("o2", [{ sku: "a", qty: 5 }]); // seq 2
    expect(inv.history("a", 0, 1).map((m) => m.seq)).toEqual([0]);
    expect(inv.history("a", 5, 9)).toEqual([]);
  });

  it("rejects an inverted or non-integer range", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    expect(() => inv.history("widget", 3, 1)).toThrow();
    expect(() => inv.history("widget", 0, 1.5)).toThrow();
  });
});

describe("lineValue", () => {
  it("rounds the discounted total to integer minor units", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 999);
    const inv = new Inventory(catalog);
    const orders = new OrderService(inv, catalog);
    expect(orders.lineValue("widget", 1, 15)).toBe(849); // 999 * 0.85 = 849.15
    expect(orders.lineValue("widget", 2, 0)).toBe(1998);
    expect(orders.lineValue("widget", 3, 100)).toBe(0);
  });

  it("rejects invalid qty and discount", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 999);
    const inv = new Inventory(catalog);
    const orders = new OrderService(inv, catalog);
    expect(() => orders.lineValue("widget", -1, 10)).toThrow();
    expect(() => orders.lineValue("widget", 1.5, 10)).toThrow();
    expect(() => orders.lineValue("widget", 1, -5)).toThrow();
    expect(() => orders.lineValue("widget", 1, 101)).toThrow();
    expect(() => orders.lineValue("widget", 1, NaN)).toThrow();
  });
});
