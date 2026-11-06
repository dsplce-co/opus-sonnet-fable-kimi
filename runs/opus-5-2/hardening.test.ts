// Regression suite for the production-hardening pass and the cancel/history
// capabilities. inventory.test.ts is left untouched as the inherited baseline.
import { describe, it, expect } from "vitest";
import { Catalog } from "./catalog";
import { Inventory } from "./inventory";
import { OrderService } from "./orders";

function setup(initial = 100, unitPrice = 500) {
  const catalog = new Catalog();
  catalog.add("widget", initial, unitPrice);
  const inv = new Inventory(catalog);
  return { catalog, inv, orders: new OrderService(inv, catalog) };
}

describe("catalog", () => {
  it("rejects re-adding an existing sku instead of resetting on-hand", () => {
    const { catalog, inv } = setup(10);
    inv.reserve("o1", [{ sku: "widget", qty: 10 }]);
    expect(() => catalog.add("widget", 10, 500)).toThrow(/already exists/);
    expect(inv.available("widget")).toBe(0);
  });

  it("rejects invalid ids, quantities and prices", () => {
    const catalog = new Catalog();
    expect(() => catalog.add("", 1, 1)).toThrow();
    expect(() => catalog.add("a", -1, 1)).toThrow();
    expect(() => catalog.add("a", 1.5, 1)).toThrow();
    expect(() => catalog.add("a", NaN, 1)).toThrow();
    expect(() => catalog.add("a", Infinity, 1)).toThrow();
    expect(() => catalog.add("a", 1, -1)).toThrow();
    expect(() => catalog.add("a", 1, 0.5)).toThrow();
  });

  it("hands out frozen copies that cannot corrupt catalog state", () => {
    const { catalog, inv } = setup(10);
    const sku = catalog.get("widget");
    expect(Object.isFrozen(sku)).toBe(true);
    expect(() => {
      (sku as { initial: number }).initial = 999999;
    }).toThrow();
    expect(inv.available("widget")).toBe(10);
    expect(catalog.get("widget")).not.toBe(catalog.get("widget"));
  });

  it("discontinues idempotently and rejects unknown skus", () => {
    const { catalog } = setup();
    catalog.discontinue("widget");
    catalog.discontinue("widget");
    expect(catalog.get("widget").state).toBe("discontinued");
    expect(() => catalog.discontinue("nope")).toThrow(/no such sku/);
    expect(() => catalog.get("nope")).toThrow(/no such sku/);
  });
});

describe("reserve validation", () => {
  it("rejects quantities that are not positive whole units", () => {
    const { inv } = setup(10);
    for (const qty of [0, -5, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => inv.reserve(`o-${qty}`, [{ sku: "widget", qty }])).toThrow();
    }
    expect(() => inv.reserve("o", [{ sku: "widget", qty: "3" as unknown as number }])).toThrow();
    expect(inv.available("widget")).toBe(10);
    expect(inv.getMovements()).toHaveLength(0);
  });

  it("rejects empty orders, bad order ids and bad lines", () => {
    const { inv } = setup(10);
    expect(() => inv.reserve("o1", [])).toThrow(/at least one line/);
    expect(() => inv.reserve("", [{ sku: "widget", qty: 1 }])).toThrow(/order id/);
    expect(() => inv.reserve("o1", [null as unknown as { sku: string; qty: number }])).toThrow();
    expect(() => inv.reserve("o1", [{ sku: "ghost", qty: 1 }])).toThrow(/no such sku/);
    expect(inv.getMovements()).toHaveLength(0);
  });

  it("refuses to reserve a discontinued sku", () => {
    const { catalog, inv } = setup(10);
    catalog.discontinue("widget");
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 1 }])).toThrow(/discontinued/);
    expect(inv.available("widget")).toBe(10);
  });
});

describe("reserve atomicity and retry safety", () => {
  it("writes nothing when a later line fails", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 1);
    catalog.add("b", 1, 1);
    const inv = new Inventory(catalog);
    expect(() => inv.reserve("o1", [{ sku: "a", qty: 5 }, { sku: "b", qty: 99 }])).toThrow();
    expect(inv.available("a")).toBe(10);
    expect(inv.available("b")).toBe(1);
    expect(inv.getMovements()).toHaveLength(0);
  });

  it("sums duplicate lines for one sku before checking availability", () => {
    const { inv } = setup(10);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 6 }, { sku: "widget", qty: 6 }])).toThrow(
      /insufficient/,
    );
    expect(inv.available("widget")).toBe(10);

    inv.reserve("o2", [{ sku: "widget", qty: 4 }, { sku: "widget", qty: 6 }]);
    expect(inv.available("widget")).toBe(0);
    expect(inv.getMovements()).toHaveLength(1); // one movement per distinct sku
  });

  it("rejects duplicate lines that overflow exact integer range", () => {
    const catalog = new Catalog();
    catalog.add("big", Number.MAX_SAFE_INTEGER, 1);
    const inv = new Inventory(catalog);
    expect(() =>
      inv.reserve("o1", [
        { sku: "big", qty: Number.MAX_SAFE_INTEGER },
        { sku: "big", qty: 1 },
      ]),
    ).toThrow();
    expect(inv.available("big")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("treats an identical replay as a no-op", () => {
    const { inv } = setup(100);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    expect(inv.available("widget")).toBe(70);
    expect(inv.getMovements()).toHaveLength(1);
  });

  it("recognises a replay regardless of line order", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 1);
    catalog.add("b", 10, 1);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 1 }, { sku: "b", qty: 2 }]);
    inv.reserve("o1", [{ sku: "b", qty: 2 }, { sku: "a", qty: 1 }]);
    expect(inv.available("a")).toBe(9);
    expect(inv.available("b")).toBe(8);
  });

  it("rejects reusing an order id for different lines", () => {
    const { inv } = setup(100);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 31 }])).toThrow(/different lines/);
    expect(inv.available("widget")).toBe(70);
  });

  it("allows reserving exactly the available stock but not one more", () => {
    const { inv } = setup(10);
    inv.reserve("o1", [{ sku: "widget", qty: 10 }]);
    expect(inv.available("widget")).toBe(0);
    expect(() => inv.reserve("o2", [{ sku: "widget", qty: 1 }])).toThrow(/insufficient/);
    expect(inv.available("widget")).toBe(0);
  });
});

describe("encapsulation", () => {
  it("returns a movement log callers cannot forge", () => {
    const { inv } = setup(10);
    inv.reserve("o1", [{ sku: "widget", qty: 1 }]);
    const log = inv.getMovements();
    log.push({ seq: 99, orderId: "hack", sku: "widget", qty: -100 });
    expect(inv.getMovements()).toHaveLength(1);
    expect(inv.available("widget")).toBe(9);
    expect(() => {
      (inv.getMovements()[0] as { qty: number }).qty = -100;
    }).toThrow();
    expect(inv.available("widget")).toBe(9);
  });
});

describe("cancel", () => {
  it("returns reserved stock to availability", () => {
    const { inv } = setup(100);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
    const log = inv.getMovements();
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ orderId: "o1", sku: "widget", qty: 30 });
  });

  it("is idempotent", () => {
    const { inv } = setup(100);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.cancel("o1");
    inv.cancel("o1");
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
    expect(inv.getMovements()).toHaveLength(2);
  });

  it("restores every sku of a multi-line order", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 1);
    catalog.add("b", 20, 1);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 3 }, { sku: "b", qty: 4 }]);
    inv.cancel("o1");
    expect(inv.available("a")).toBe(10);
    expect(inv.available("b")).toBe(20);
  });

  it("rejects an unknown order id", () => {
    const { inv } = setup();
    expect(() => inv.cancel("nope")).toThrow(/no such order/);
    expect(() => inv.cancel("")).toThrow(/order id/);
  });

  it("frees stock for a later order", () => {
    const { inv } = setup(10);
    inv.reserve("o1", [{ sku: "widget", qty: 10 }]);
    expect(() => inv.reserve("o2", [{ sku: "widget", qty: 10 }])).toThrow();
    inv.cancel("o1");
    inv.reserve("o2", [{ sku: "widget", qty: 10 }]);
    expect(inv.available("widget")).toBe(0);
  });

  it("refuses to re-reserve a cancelled order id", () => {
    const { inv } = setup(100);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.cancel("o1");
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 30 }])).toThrow(/cancelled/);
    expect(inv.available("widget")).toBe(100);
  });

  it("still returns stock for a sku discontinued after reservation", () => {
    const { catalog, inv } = setup(10);
    inv.reserve("o1", [{ sku: "widget", qty: 4 }]);
    catalog.discontinue("widget");
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(10);
    expect(() => inv.reserve("o2", [{ sku: "widget", qty: 1 }])).toThrow(/discontinued/);
  });

  it("keeps availability equal to initial plus the summed movement log", () => {
    const catalog = new Catalog();
    catalog.add("a", 50, 1);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 5 }]);
    inv.reserve("o2", [{ sku: "a", qty: 7 }]);
    inv.cancel("o1");
    const summed = inv
      .getMovements()
      .filter((m) => m.sku === "a")
      .reduce((acc, m) => acc + m.qty, 50);
    expect(inv.available("a")).toBe(summed);
    expect(inv.available("a")).toBe(43);
  });
});

describe("history", () => {
  function seeded() {
    const catalog = new Catalog();
    catalog.add("a", 100, 1);
    catalog.add("b", 100, 1);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 1 }]); // seq 0
    inv.reserve("o2", [{ sku: "b", qty: 2 }]); // seq 1
    inv.reserve("o3", [{ sku: "a", qty: 3 }]); // seq 2
    inv.cancel("o1"); // seq 3, sku a
    return inv;
  }

  it("returns only that sku's movements, inclusive of both bounds", () => {
    const inv = seeded();
    expect(inv.history("a", 0, 3).map((m) => m.seq)).toEqual([0, 2, 3]);
    expect(inv.history("b", 0, 3).map((m) => m.seq)).toEqual([1]);
    expect(inv.history("a", 0, 0).map((m) => m.seq)).toEqual([0]);
    expect(inv.history("a", 3, 3).map((m) => m.seq)).toEqual([3]);
    expect(inv.history("a", 1, 2).map((m) => m.seq)).toEqual([2]);
  });

  it("returns an empty array for a range with no movements", () => {
    const inv = seeded();
    expect(inv.history("b", 2, 3)).toEqual([]);
    expect(inv.history("a", 100, 200)).toEqual([]);
  });

  it("carries the signed quantities", () => {
    const inv = seeded();
    expect(inv.history("a", 0, 3).map((m) => m.qty)).toEqual([-1, -3, 1]);
  });

  it("rejects unknown skus and invalid ranges", () => {
    const inv = seeded();
    expect(() => inv.history("ghost", 0, 1)).toThrow(/no such sku/);
    expect(() => inv.history("a", 3, 1)).toThrow(/invalid seq range/);
    expect(() => inv.history("a", -1, 1)).toThrow();
    expect(() => inv.history("a", 0, 1.5)).toThrow();
    expect(() => inv.history("a", NaN, 1)).toThrow();
  });

  it("returns detached, frozen movements", () => {
    const inv = seeded();
    const h = inv.history("a", 0, 3);
    h.push({ seq: 99, orderId: "hack", sku: "a", qty: -100 });
    expect(inv.history("a", 0, 99)).toHaveLength(3);
    expect(() => {
      (inv.history("a", 0, 3)[0] as { qty: number }).qty = -100;
    }).toThrow();
    expect(inv.available("a")).toBe(97);
  });
});

describe("money", () => {
  it("stays in whole minor units", () => {
    const { orders } = setup(10, 999);
    expect(orders.lineValue("widget", 3, 10)).toBe(2697); // 2997 - round(299.7)
    expect(orders.lineValue("widget", 1, 33)).toBe(669); // 999 - round(329.67)
    for (const pct of [0, 1, 7, 33, 50, 99, 100]) {
      expect(Number.isInteger(orders.lineValue("widget", 3, pct))).toBe(true);
    }
  });

  it("treats 0% and 100% exactly", () => {
    const { orders } = setup(10, 999);
    expect(orders.lineValue("widget", 3, 0)).toBe(2997);
    expect(orders.lineValue("widget", 3, 100)).toBe(0);
    expect(orders.lineValue("widget", 0, 25)).toBe(0);
  });

  it("rejects out-of-range or non-whole discounts and quantities", () => {
    const { orders } = setup(10, 999);
    expect(() => orders.lineValue("widget", 1, -1)).toThrow();
    expect(() => orders.lineValue("widget", 1, 101)).toThrow(/<= 100/);
    expect(() => orders.lineValue("widget", 1, 2.5)).toThrow();
    expect(() => orders.lineValue("widget", 1, NaN)).toThrow();
    expect(() => orders.lineValue("widget", -1, 10)).toThrow();
    expect(() => orders.lineValue("widget", 1.5, 10)).toThrow();
    expect(() => orders.lineValue("ghost", 1, 10)).toThrow(/no such sku/);
  });

  it("refuses to return a silently inexact line value", () => {
    const catalog = new Catalog();
    catalog.add("pricey", 10, Number.MAX_SAFE_INTEGER);
    const inv = new Inventory(catalog);
    const orders = new OrderService(inv, catalog);
    expect(() => orders.lineValue("pricey", 2, 10)).toThrow(/safe integer range/);
  });
});

describe("order service", () => {
  it("places and cancels through the service", () => {
    const { inv, orders } = setup(100);
    orders.place("o1", "widget", 30);
    expect(inv.available("widget")).toBe(70);
    orders.cancel("o1");
    orders.cancel("o1");
    expect(inv.available("widget")).toBe(100);
  });
});
