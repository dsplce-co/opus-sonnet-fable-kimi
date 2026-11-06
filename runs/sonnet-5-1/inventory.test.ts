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

  it("catalog.get returns a defensive copy that cannot corrupt internal state", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const copy = catalog.get("widget");
    copy.state = "discontinued";
    copy.initial = 999999;
    expect(catalog.get("widget").state).toBe("active");
    expect(catalog.get("widget").initial).toBe(100);
  });

  it("adding a SKU that already exists is rejected, not silently overwritten", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    expect(() => catalog.add("widget", 5, 1)).toThrow();
    expect(catalog.get("widget").initial).toBe(100);
  });

  it("rejects invalid initial stock and unit price", () => {
    const catalog = new Catalog();
    expect(() => catalog.add("bad1", -1, 500)).toThrow();
    expect(() => catalog.add("bad2", 1.5, 500)).toThrow();
    expect(() => catalog.add("bad3", 100, -500)).toThrow();
  });

  it("a multi-line reserve is all-or-nothing: a failing line rolls back earlier lines", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 100);
    catalog.add("b", 5, 100);
    const inv = new Inventory(catalog);
    expect(() =>
      inv.reserve("o1", [
        { sku: "a", qty: 10 },
        { sku: "b", qty: 999 },
      ])
    ).toThrow();
    expect(inv.available("a")).toBe(10);
    expect(inv.available("b")).toBe(5);
  });

  it("rejects zero, negative, and non-integer quantities", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 0 }])).toThrow();
    expect(() => inv.reserve("o2", [{ sku: "widget", qty: -5 }])).toThrow();
    expect(() => inv.reserve("o3", [{ sku: "widget", qty: 1.5 }])).toThrow();
    expect(inv.available("widget")).toBe(100);
  });

  it("cannot reserve stock for a discontinued SKU", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    catalog.discontinue("widget");
    const inv = new Inventory(catalog);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 1 }])).toThrow();
  });

  it("retrying reserve with the same orderId and lines is a no-op", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    expect(inv.available("widget")).toBe(70);
    expect(inv.getMovements().length).toBe(1);
  });

  it("retrying reserve with the same orderId but different lines is a conflict", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 40 }])).toThrow();
    expect(inv.available("widget")).toBe(70);
  });

  it("getMovements returns a defensive copy that cannot corrupt the ledger", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    const movements = inv.getMovements();
    movements.push({ seq: 999, orderId: "fake", sku: "widget", qty: -1000 });
    movements[0].qty = 0;
    expect(inv.getMovements().length).toBe(1);
    expect(inv.available("widget")).toBe(70);
  });

  it("cancel returns reserved stock to availability", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
  });

  it("cancel is safe to call more than once", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.cancel("o1");
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
  });

  it("cancel throws for an order that was never reserved", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    expect(() => inv.cancel("nope")).toThrow();
  });

  it("cancel still works after the SKU is discontinued", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    catalog.discontinue("widget");
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
  });

  it("history returns a SKU's movements within an inclusive seq range", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 500);
    catalog.add("b", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 10 }]); // seq 0
    inv.reserve("o2", [{ sku: "b", qty: 5 }]); // seq 1
    inv.reserve("o3", [{ sku: "a", qty: 20 }]); // seq 2
    inv.cancel("o1"); // seq 3, sku a

    const all = inv.history("a", 0, 3);
    expect(all.map((m) => m.seq)).toEqual([0, 2, 3]);

    const middle = inv.history("a", 1, 2);
    expect(middle.map((m) => m.seq)).toEqual([2]);
  });

  it("lineValue rounds monetary results to whole minor units", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 333);
    const inv = new Inventory(catalog);
    const orders = new OrderService(inv, catalog);
    const value = orders.lineValue("widget", 3, 10);
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBe(899); // 999 gross - round(99.9) = 899
  });

  it("lineValue rejects invalid quantity and discount inputs", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    const orders = new OrderService(inv, catalog);
    expect(() => orders.lineValue("widget", 0, 10)).toThrow();
    expect(() => orders.lineValue("widget", 3, -1)).toThrow();
    expect(() => orders.lineValue("widget", 3, 101)).toThrow();
  });
});
