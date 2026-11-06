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

  it("cancel returns stock to availability", () => {
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
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
  });

  it("cancel handles multi-line orders", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    catalog.add("gadget", 50, 300);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [
      { sku: "widget", qty: 20 },
      { sku: "gadget", qty: 10 },
    ]);
    expect(inv.available("widget")).toBe(80);
    expect(inv.available("gadget")).toBe(40);
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
    expect(inv.available("gadget")).toBe(50);
  });

  it("history returns movements in sequence range", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 10 }]);
    inv.reserve("o2", [{ sku: "widget", qty: 20 }]);
    inv.reserve("o3", [{ sku: "widget", qty: 5 }]);

    const moves = inv.history("widget", 0, 1);
    expect(moves.length).toBe(2);
    expect(moves[0].qty).toBe(-10);
    expect(moves[1].qty).toBe(-20);
  });

  it("cannot reserve discontinued SKU", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    catalog.discontinue("widget");
    const inv = new Inventory(catalog);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 10 }])).toThrow(
      "cannot reserve discontinued sku"
    );
  });

  it("rejects invalid quantity", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: -5 }])).toThrow(
      "invalid quantity"
    );
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 1.5 }])).toThrow(
      "invalid quantity"
    );
  });

  it("handles multiple lines of same SKU in one order", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    expect(() =>
      inv.reserve("o1", [
        { sku: "widget", qty: 60 },
        { sku: "widget", qty: 50 },
      ])
    ).toThrow("insufficient stock");
  });

  it("reserve is atomic - fails without partial reservation", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    catalog.add("gadget", 10, 300);
    const inv = new Inventory(catalog);

    expect(() =>
      inv.reserve("o1", [
        { sku: "widget", qty: 50 },
        { sku: "gadget", qty: 20 }, // This will fail
      ])
    ).toThrow("insufficient stock");

    // Widget should not have been reserved
    expect(inv.available("widget")).toBe(100);
  });

  it("external mutation of Sku does not affect catalog", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const sku = catalog.get("widget");
    sku.unitPrice = 999999; // Attempt to mutate
    sku.state = "discontinued"; // Attempt to mutate

    // Verify catalog is unaffected
    const unchanged = catalog.get("widget");
    expect(unchanged.unitPrice).toBe(500);
    expect(unchanged.state).toBe("active");
  });

  it("external mutation of movements does not affect inventory", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 10 }]);

    const movements = inv.getMovements();
    movements.push({
      seq: 999,
      orderId: "fake",
      sku: "widget",
      qty: 100,
    });

    // Verify inventory is unaffected
    expect(inv.available("widget")).toBe(90);
    expect(inv.getMovements().length).toBe(1);
  });
});
