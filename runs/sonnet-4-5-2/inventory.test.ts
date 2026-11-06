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

  it("cancel returns reserved stock to availability", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    const orders = new OrderService(inv, catalog);
    orders.place("o1", "widget", 30);
    expect(inv.available("widget")).toBe(70);
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
  });

  it("cancel is idempotent", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    const orders = new OrderService(inv, catalog);
    orders.place("o1", "widget", 30);
    inv.cancel("o1");
    inv.cancel("o1"); // Second call should be no-op
    expect(inv.available("widget")).toBe(100);
  });

  it("history returns movements in seq range", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    catalog.add("gadget", 50, 300);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 10 }]); // seq 0
    inv.reserve("o2", [{ sku: "gadget", qty: 5 }]);  // seq 1
    inv.reserve("o3", [{ sku: "widget", qty: 20 }]); // seq 2
    const widgetHistory = inv.history("widget", 0, 2);
    expect(widgetHistory.length).toBe(2);
    expect(widgetHistory[0].seq).toBe(0);
    expect(widgetHistory[1].seq).toBe(2);
  });
});
