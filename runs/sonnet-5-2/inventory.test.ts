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
