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

describe("catalog hardening", () => {
  it("rejects a duplicate SKU id", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    expect(() => catalog.add("widget", 50, 300)).toThrow();
  });

  it("rejects negative or fractional initial quantity and price", () => {
    const catalog = new Catalog();
    expect(() => catalog.add("a", -1, 500)).toThrow();
    expect(() => catalog.add("b", 1.5, 500)).toThrow();
    expect(() => catalog.add("c", 10, -500)).toThrow();
    expect(() => catalog.add("d", 10, 4.99)).toThrow();
    expect(() => catalog.add("e", NaN, 500)).toThrow();
  });

  it("get returns a copy: callers cannot mutate catalog state", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    const leaked = catalog.get("widget");
    leaked.initial = 0;
    leaked.unitPrice = 0;
    expect(inv.available("widget")).toBe(100);
    expect(catalog.get("widget").unitPrice).toBe(500);
  });
});

describe("reserve hardening", () => {
  it("is atomic: a failing multi-line order reserves nothing", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 100);
    catalog.add("b", 10, 100);
    const inv = new Inventory(catalog);
    expect(() =>
      inv.reserve("o1", [
        { sku: "a", qty: 5 },
        { sku: "b", qty: 25 },
      ]),
    ).toThrow();
    expect(inv.available("a")).toBe(10);
    expect(inv.available("b")).toBe(10);
    expect(inv.getMovements()).toHaveLength(0);
    // the failed orderId is not recorded and can be reused
    inv.reserve("o1", [{ sku: "a", qty: 5 }]);
    expect(inv.available("a")).toBe(5);
  });

  it("checks multiple lines for the same SKU as one demand", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    expect(() =>
      inv.reserve("o1", [
        { sku: "widget", qty: 60 },
        { sku: "widget", qty: 60 },
      ]),
    ).toThrow();
    expect(inv.available("widget")).toBe(100);
  });

  it("rejects non-positive and non-integer quantities", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 0 }])).toThrow();
    expect(() => inv.reserve("o2", [{ sku: "widget", qty: -5 }])).toThrow();
    expect(() => inv.reserve("o3", [{ sku: "widget", qty: 2.5 }])).toThrow();
    expect(() => inv.reserve("o4", [{ sku: "widget", qty: NaN }])).toThrow();
    expect(() =>
      inv.reserve("o5", [{ sku: "widget", qty: Infinity }]),
    ).toThrow();
    expect(inv.available("widget")).toBe(100);
  });

  it("is safe to retry: same orderId and lines is a no-op", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    expect(inv.available("widget")).toBe(70);
    expect(inv.getMovements()).toHaveLength(1);
  });

  it("rejects reuse of an orderId with different lines", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 10 }])).toThrow();
    expect(inv.available("widget")).toBe(70);
  });

  it("rejects reserving a discontinued SKU", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    catalog.discontinue("widget");
    const inv = new Inventory(catalog);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 1 }])).toThrow();
    expect(inv.available("widget")).toBe(100);
  });

  it("getMovements returns copies: callers cannot corrupt the ledger", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    const leaked = inv.getMovements();
    leaked[0].qty = -100;
    leaked.push({ seq: 99, orderId: "evil", sku: "widget", qty: 1000 });
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
    expect(inv.available("widget")).toBe(70);
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
  });

  it("returns every line of a multi-line order atomically", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 100);
    catalog.add("b", 10, 100);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [
      { sku: "a", qty: 4 },
      { sku: "b", qty: 6 },
    ]);
    inv.cancel("o1");
    expect(inv.available("a")).toBe(10);
    expect(inv.available("b")).toBe(10);
  });

  it("is idempotent: cancelling twice does not double-return stock", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.cancel("o1");
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
    // one reserve movement + one return movement
    expect(inv.getMovements()).toHaveLength(2);
  });

  it("throws for an order that was never reserved", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    expect(() => inv.cancel("nope")).toThrow();
  });

  it("works after the SKU is discontinued, without reviving it", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    catalog.discontinue("widget");
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
    expect(catalog.get("widget").state).toBe("discontinued");
    // the returned stock cannot be reserved again
    expect(() => inv.reserve("o2", [{ sku: "widget", qty: 1 }])).toThrow();
  });

  it("frees the stock for a different order", () => {
    const catalog = new Catalog();
    catalog.add("widget", 50, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 50 }]);
    inv.cancel("o1");
    inv.reserve("o2", [{ sku: "widget", qty: 50 }]);
    expect(inv.available("widget")).toBe(0);
  });
});

describe("history", () => {
  function setup() {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    catalog.add("gadget", 50, 900);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 10 }]); // seq 0
    inv.reserve("o2", [
      { sku: "widget", qty: 20 }, // seq 1
      { sku: "gadget", qty: 5 }, // seq 2
    ]);
    inv.cancel("o1"); // seq 3 (+10 widget)
    return inv;
  }

  it("returns movements in the inclusive [fromSeq, toSeq] range", () => {
    const inv = setup();
    expect(inv.history("widget", 0, 1).map((m) => m.seq)).toEqual([0, 1]);
    expect(inv.history("widget", 0, 100).map((m) => m.seq)).toEqual([0, 1, 3]);
    expect(inv.history("widget", 3, 3).map((m) => m.qty)).toEqual([10]);
    expect(inv.history("widget", 5, 9)).toEqual([]);
  });

  it("only returns movements for the requested SKU", () => {
    const inv = setup();
    const seqs = inv.history("gadget", 0, 100).map((m) => m.seq);
    expect(seqs).toEqual([2]);
  });

  it("rejects an invalid range and an unknown SKU", () => {
    const inv = setup();
    expect(() => inv.history("widget", 3, 1)).toThrow();
    expect(() => inv.history("widget", 0, 1.5)).toThrow();
    expect(() => inv.history("nope", 0, 10)).toThrow();
  });

  it("returns copies: mutating the result does not corrupt the ledger", () => {
    const inv = setup();
    const h = inv.history("widget", 0, 100);
    h[0].qty = 999;
    expect(inv.available("widget")).toBe(80);
  });
});

describe("lineValue", () => {
  it("computes integer minor units with a fractional-looking discount", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    const orders = new OrderService(inv, catalog);
    expect(orders.lineValue("widget", 1, 33)).toBe(335);
    expect(Number.isInteger(orders.lineValue("widget", 3, 15))).toBe(true);
    expect(orders.lineValue("widget", 2, 0)).toBe(1000);
    expect(orders.lineValue("widget", 2, 100)).toBe(0);
  });

  it("rejects invalid quantities and discounts", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    const orders = new OrderService(inv, catalog);
    expect(() => orders.lineValue("widget", -1, 10)).toThrow();
    expect(() => orders.lineValue("widget", 1.5, 10)).toThrow();
    expect(() => orders.lineValue("widget", 1, -5)).toThrow();
    expect(() => orders.lineValue("widget", 1, 101)).toThrow();
    expect(() => orders.lineValue("widget", 1, NaN)).toThrow();
  });
});
