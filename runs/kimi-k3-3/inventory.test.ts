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
  });
});

describe("reserve safety", () => {
  it("is atomic: a failing multi-line order reserves nothing", () => {
    const catalog = new Catalog();
    catalog.add("a", 5, 100);
    catalog.add("b", 5, 100);
    const inv = new Inventory(catalog);
    expect(() => inv.reserve("o1", [{ sku: "a", qty: 3 }, { sku: "b", qty: 10 }])).toThrow();
    expect(inv.available("a")).toBe(5);
    expect(inv.available("b")).toBe(5);
    expect(inv.getMovements()).toHaveLength(0);
  });

  it("a failed reserve does not consume sequence numbers and can be retried", () => {
    const catalog = new Catalog();
    catalog.add("a", 5, 100);
    const inv = new Inventory(catalog);
    expect(() => inv.reserve("o1", [{ sku: "a", qty: 99 }])).toThrow();
    inv.reserve("o1", [{ sku: "a", qty: 2 }]);
    expect(inv.getMovements()[0].seq).toBe(0);
    expect(inv.available("a")).toBe(3);
  });

  it("rejects zero, negative, fractional, and non-numeric quantities", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 100);
    const inv = new Inventory(catalog);
    for (const qty of [0, -1, 1.5, NaN, Infinity, "2" as unknown as number]) {
      expect(() => inv.reserve("o", [{ sku: "a", qty }])).toThrow();
    }
    expect(inv.available("a")).toBe(10);
  });

  it("checks duplicate lines for one SKU against their combined demand", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 100);
    const inv = new Inventory(catalog);
    expect(() => inv.reserve("o1", [{ sku: "a", qty: 6 }, { sku: "a", qty: 6 }])).toThrow();
    inv.reserve("o2", [{ sku: "a", qty: 6 }, { sku: "a", qty: 4 }]);
    expect(inv.available("a")).toBe(0);
  });

  it("rejects reserving a discontinued SKU", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 100);
    catalog.discontinue("a");
    const inv = new Inventory(catalog);
    expect(() => inv.reserve("o1", [{ sku: "a", qty: 1 }])).toThrow();
    expect(inv.available("a")).toBe(10);
  });

  it("is retry-safe: same orderId with same lines is a no-op", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 100);
    const inv = new Inventory(catalog);
    const lines = [{ sku: "a", qty: 3 }];
    inv.reserve("o1", lines);
    inv.reserve("o1", lines);
    expect(inv.available("a")).toBe(7);
    expect(inv.getMovements()).toHaveLength(1);
  });

  it("rejects reusing an orderId with different lines", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 100);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 3 }]);
    expect(() => inv.reserve("o1", [{ sku: "a", qty: 4 }])).toThrow();
    expect(inv.available("a")).toBe(7);
  });
});

describe("cancel", () => {
  it("returns the reserved stock to availability", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 100);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 4 }]);
    inv.cancel("o1");
    expect(inv.available("a")).toBe(10);
  });

  it("returns every line of a multi-line order", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 100);
    catalog.add("b", 20, 100);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 4 }, { sku: "b", qty: 7 }]);
    inv.cancel("o1");
    expect(inv.available("a")).toBe(10);
    expect(inv.available("b")).toBe(20);
  });

  it("is idempotent: a second cancel is a no-op", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 100);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 4 }]);
    inv.cancel("o1");
    inv.cancel("o1");
    expect(inv.available("a")).toBe(10);
    expect(inv.getMovements().filter((m) => m.qty > 0)).toHaveLength(1);
  });

  it("throws for an order that was never reserved", () => {
    const catalog = new Catalog();
    const inv = new Inventory(catalog);
    expect(() => inv.cancel("nope")).toThrow();
  });

  it("works for discontinued SKUs and blocks re-reserving the order", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 100);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 4 }]);
    catalog.discontinue("a");
    inv.cancel("o1");
    expect(inv.available("a")).toBe(10);
    expect(() => inv.reserve("o1", [{ sku: "a", qty: 4 }])).toThrow();
  });
});

describe("history", () => {
  it("returns movements in the inclusive seq range for that SKU only", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 100);
    catalog.add("b", 100, 100);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 10 }]); // seq 0
    inv.reserve("o2", [{ sku: "b", qty: 5 }]); // seq 1
    inv.reserve("o3", [{ sku: "a", qty: 20 }]); // seq 2
    inv.cancel("o1"); // seq 3

    expect(inv.history("a", 0, 1).map((m) => m.seq)).toEqual([0]);
    expect(inv.history("a", 0, 2).map((m) => m.seq)).toEqual([0, 2]);
    expect(inv.history("a", 2, 3).map((m) => m.qty)).toEqual([-20, 10]);
    expect(inv.history("a", 5, 9)).toEqual([]);
    expect(inv.history("a", 3, 1)).toEqual([]);
  });

  it("returns copies that cannot corrupt the ledger", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 100);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 10 }]);
    const h = inv.history("a", 0, 0);
    h[0].qty = 9999;
    h.push({ seq: 1, orderId: "x", sku: "a", qty: 9999 });
    expect(inv.available("a")).toBe(90);
  });

  it("throws for an unknown SKU", () => {
    const catalog = new Catalog();
    const inv = new Inventory(catalog);
    expect(() => inv.history("ghost", 0, 10)).toThrow();
  });
});

describe("ledger integrity", () => {
  it("getMovements returns a defensive copy", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 100);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 10 }]);
    const ms = inv.getMovements();
    ms[0].qty = 9999;
    ms.push({ seq: 99, orderId: "x", sku: "a", qty: 9999 });
    expect(inv.available("a")).toBe(90);
    expect(inv.getMovements()).toHaveLength(1);
  });
});

describe("lineValue", () => {
  it("returns integer minor units with the discount rounded half-up", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 999);
    const inv = new Inventory(catalog);
    const orders = new OrderService(inv, catalog);
    expect(orders.lineValue("a", 1, 33)).toBe(669); // 999 - round(329.67)
    expect(orders.lineValue("a", 3, 0)).toBe(2997);
    expect(orders.lineValue("a", 2, 100)).toBe(0);
    expect(Number.isInteger(orders.lineValue("a", 7, 13))).toBe(true);
  });

  it("rejects out-of-range discounts and invalid quantities", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 999);
    const inv = new Inventory(catalog);
    const orders = new OrderService(inv, catalog);
    expect(() => orders.lineValue("a", 1, -1)).toThrow();
    expect(() => orders.lineValue("a", 1, 101)).toThrow();
    expect(() => orders.lineValue("a", 1, NaN)).toThrow();
    expect(() => orders.lineValue("a", 0, 10)).toThrow();
    expect(() => orders.lineValue("a", 1.5, 10)).toThrow();
  });
});
