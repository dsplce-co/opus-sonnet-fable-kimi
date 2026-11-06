import { describe, it, expect } from "vitest";
import { Catalog } from "./catalog";
import { Inventory, Line } from "./inventory";
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

// --- Regression tests for the defects fixed in this pass -------------------

function fixture(initial = 100, unitPrice = 500) {
  const catalog = new Catalog();
  catalog.add("widget", initial, unitPrice);
  const inv = new Inventory(catalog);
  return { catalog, inv, orders: new OrderService(inv, catalog) };
}

describe("catalog integrity", () => {
  it("rejects re-adding an existing SKU instead of rewriting its history", () => {
    const { catalog } = fixture();
    expect(() => catalog.add("widget", 10, 500)).toThrow(/already exists/);
  });

  it("rejects invalid initial quantities and prices", () => {
    const catalog = new Catalog();
    expect(() => catalog.add("a", -1, 500)).toThrow();
    expect(() => catalog.add("b", 1.5, 500)).toThrow();
    expect(() => catalog.add("c", NaN, 500)).toThrow();
    expect(() => catalog.add("d", Infinity, 500)).toThrow();
    expect(() => catalog.add("e", 10, -5)).toThrow();
    expect(() => catalog.add("", 10, 500)).toThrow();
  });

  it("hands out immutable SKUs so callers cannot corrupt stock", () => {
    const { catalog, inv } = fixture();
    expect(() => {
      (catalog.get("widget") as { initial: number }).initial = 999999;
    }).toThrow();
    expect(inv.available("widget")).toBe(100);
  });

  it("discontinue is idempotent", () => {
    const { catalog } = fixture();
    catalog.discontinue("widget");
    catalog.discontinue("widget");
    expect(catalog.get("widget").state).toBe("discontinued");
  });
});

describe("reserve validation", () => {
  it("rejects a negative qty rather than creating stock from nothing", () => {
    const { inv } = fixture(10);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: -5 }])).toThrow();
    expect(inv.available("widget")).toBe(10);
  });

  it("rejects NaN, Infinity and fractional quantities", () => {
    const { inv } = fixture(10);
    expect(() => inv.reserve("a", [{ sku: "widget", qty: NaN }])).toThrow();
    expect(() => inv.reserve("b", [{ sku: "widget", qty: Infinity }])).toThrow();
    expect(() => inv.reserve("c", [{ sku: "widget", qty: 1.5 }])).toThrow();
    expect(inv.available("widget")).toBe(10);
  });

  it("rejects zero-qty lines and empty orders", () => {
    const { inv } = fixture(10);
    expect(() => inv.reserve("a", [{ sku: "widget", qty: 0 }])).toThrow();
    expect(() => inv.reserve("b", [])).toThrow(/at least one line/);
  });

  it("rejects an unknown SKU", () => {
    const { inv } = fixture();
    expect(() => inv.reserve("o1", [{ sku: "ghost", qty: 1 }])).toThrow(/no such sku/);
  });

  it("refuses to reserve a discontinued SKU", () => {
    const { catalog, inv } = fixture();
    catalog.discontinue("widget");
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 1 }])).toThrow(/discontinued/);
    expect(inv.available("widget")).toBe(100);
  });
});

describe("reserve atomicity and retry safety", () => {
  it("commits nothing when a later line fails", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 1);
    catalog.add("b", 1, 1);
    const inv = new Inventory(catalog);
    expect(() => inv.reserve("o1", [{ sku: "a", qty: 5 }, { sku: "b", qty: 99 }])).toThrow();
    expect(inv.available("a")).toBe(10);
    expect(inv.available("b")).toBe(1);
    expect(inv.getMovements()).toHaveLength(0);
  });

  it("checks repeated lines for one SKU as a single total", () => {
    const { inv } = fixture(10);
    expect(() =>
      inv.reserve("o1", [{ sku: "widget", qty: 6 }, { sku: "widget", qty: 6 }]),
    ).toThrow(/insufficient/);
    expect(inv.available("widget")).toBe(10);

    inv.reserve("o2", [{ sku: "widget", qty: 6 }, { sku: "widget", qty: 4 }]);
    expect(inv.available("widget")).toBe(0);
  });

  it("treats an identical re-submission as a no-op", () => {
    const { inv } = fixture();
    inv.reserve("dup", [{ sku: "widget", qty: 30 }]);
    inv.reserve("dup", [{ sku: "widget", qty: 30 }]);
    inv.reserve("dup", [{ sku: "widget", qty: 30 }]);
    expect(inv.available("widget")).toBe(70);
    expect(inv.getMovements()).toHaveLength(1);
  });

  it("rejects reusing an order id for different lines", () => {
    const { inv } = fixture();
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 5 }])).toThrow(/different lines/);
    expect(inv.available("widget")).toBe(70);
  });

  it("stays a no-op on retry even if the SKU was discontinued meanwhile", () => {
    const { catalog, inv } = fixture();
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    catalog.discontinue("widget");
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 30 }])).not.toThrow();
    expect(inv.available("widget")).toBe(70);
  });

  it("never lets availability go negative under repeated pressure", () => {
    const { inv } = fixture(10);
    for (let i = 0; i < 20; i++) {
      try {
        inv.reserve(`o${i}`, [{ sku: "widget", qty: 3 }]);
      } catch {
        // expected once stock runs out
      }
      expect(inv.available("widget")).toBeGreaterThanOrEqual(0);
    }
    expect(inv.available("widget")).toBe(1);
  });
});

describe("ledger encapsulation", () => {
  it("getMovements returns a copy callers cannot use to forge stock", () => {
    const { inv } = fixture();
    const stolen = inv.getMovements();
    stolen.push({ seq: 99, orderId: "forged", sku: "widget", qty: -50 });
    expect(inv.getMovements()).toHaveLength(0);
    expect(inv.available("widget")).toBe(100);
  });

  it("movements themselves are frozen", () => {
    const { inv } = fixture();
    inv.reserve("o1", [{ sku: "widget", qty: 1 }]);
    const m = inv.getMovements()[0];
    expect(() => {
      (m as { qty: number }).qty = -99;
    }).toThrow();
    expect(inv.available("widget")).toBe(99);
  });
});

describe("cancel", () => {
  it("returns reserved stock to availability", () => {
    const { inv } = fixture();
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    expect(inv.available("widget")).toBe(70);
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
  });

  it("is idempotent", () => {
    const { inv } = fixture();
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.cancel("o1");
    inv.cancel("o1");
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
    expect(inv.getMovements()).toHaveLength(2);
  });

  it("frees the stock for a later order", () => {
    const { inv } = fixture(10);
    inv.reserve("o1", [{ sku: "widget", qty: 10 }]);
    expect(() => inv.reserve("o2", [{ sku: "widget", qty: 10 }])).toThrow();
    inv.cancel("o1");
    inv.reserve("o2", [{ sku: "widget", qty: 10 }]);
    expect(inv.available("widget")).toBe(0);
  });

  it("reverses every SKU of a multi-line order", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 1);
    catalog.add("b", 20, 1);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 3 }, { sku: "b", qty: 7 }, { sku: "a", qty: 2 }]);
    expect(inv.available("a")).toBe(5);
    inv.cancel("o1");
    expect(inv.available("a")).toBe(10);
    expect(inv.available("b")).toBe(20);
  });

  it("throws for an unknown order id", () => {
    const { inv } = fixture();
    expect(() => inv.cancel("nope")).toThrow(/no such order/);
  });

  it("still returns stock for a discontinued SKU, so units are not stranded", () => {
    const { catalog, inv } = fixture();
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    catalog.discontinue("widget");
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
  });

  it("refuses to re-reserve a cancelled order id", () => {
    const { inv } = fixture();
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.cancel("o1");
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 30 }])).toThrow(/cancelled/);
    expect(inv.available("widget")).toBe(100);
  });
});

describe("history", () => {
  it("returns movements inside the inclusive range only", () => {
    const { inv } = fixture();
    inv.reserve("o1", [{ sku: "widget", qty: 1 }]); // seq 0
    inv.reserve("o2", [{ sku: "widget", qty: 2 }]); // seq 1
    inv.reserve("o3", [{ sku: "widget", qty: 3 }]); // seq 2
    expect(inv.history("widget", 0, 2).map((m) => m.seq)).toEqual([0, 1, 2]);
    expect(inv.history("widget", 1, 1).map((m) => m.seq)).toEqual([1]);
    expect(inv.history("widget", 1, 2).map((m) => m.qty)).toEqual([-2, -3]);
    expect(inv.history("widget", 5, 9)).toEqual([]);
  });

  it("only returns the requested SKU's movements", () => {
    const catalog = new Catalog();
    catalog.add("a", 10, 1);
    catalog.add("b", 10, 1);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 1 }, { sku: "b", qty: 2 }]);
    expect(inv.history("a", 0, 99).map((m) => m.sku)).toEqual(["a"]);
    expect(inv.history("b", 0, 99).map((m) => m.qty)).toEqual([-2]);
  });

  it("includes cancel movements", () => {
    const { inv } = fixture();
    inv.reserve("o1", [{ sku: "widget", qty: 4 }]);
    inv.cancel("o1");
    expect(inv.history("widget", 0, Number.MAX_SAFE_INTEGER).map((m) => m.qty)).toEqual([-4, 4]);
  });

  it("returns empty for an inverted range and throws on bad input", () => {
    const { inv } = fixture();
    inv.reserve("o1", [{ sku: "widget", qty: 1 }]);
    expect(inv.history("widget", 5, 1)).toEqual([]);
    expect(() => inv.history("ghost", 0, 1)).toThrow(/no such sku/);
    expect(() => inv.history("widget", NaN, 1)).toThrow();
    expect(() => inv.history("widget", 0, 1.5)).toThrow();
  });

  it("does not expose the internal ledger for editing", () => {
    const { inv } = fixture();
    inv.reserve("o1", [{ sku: "widget", qty: 1 }]);
    const h = inv.history("widget", 0, 99);
    h.push({ seq: 42, orderId: "forged", sku: "widget", qty: -50 });
    expect(inv.history("widget", 0, 99)).toHaveLength(1);
    expect(inv.available("widget")).toBe(99);
  });
});

describe("line value arithmetic", () => {
  it("always returns whole minor units", () => {
    const { orders } = fixture(100, 999);
    const v = orders.lineValue("widget", 3, 33);
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBe(2008); // 2997 gross - 989 discount, rounded half-up
  });

  it("handles the no-discount and full-discount ends", () => {
    const { orders } = fixture(100, 999);
    expect(orders.lineValue("widget", 3, 0)).toBe(2997);
    expect(orders.lineValue("widget", 3, 100)).toBe(0);
    expect(orders.lineValue("widget", 0, 50)).toBe(0);
  });

  it("rounds half-up on the discount", () => {
    const { orders } = fixture(100, 5);
    expect(orders.lineValue("widget", 1, 50)).toBe(2); // 5 - round(2.5) = 2
  });

  it("rejects discounts outside 0..100 and non-whole percents", () => {
    const { orders } = fixture(100, 999);
    expect(() => orders.lineValue("widget", 1, -100)).toThrow();
    expect(() => orders.lineValue("widget", 1, 200)).toThrow();
    expect(() => orders.lineValue("widget", 1, 12.5)).toThrow();
    expect(() => orders.lineValue("widget", 1, NaN)).toThrow();
  });

  it("rejects invalid quantities", () => {
    const { orders } = fixture(100, 999);
    expect(() => orders.lineValue("widget", -1, 10)).toThrow();
    expect(() => orders.lineValue("widget", 1.5, 10)).toThrow();
  });
});

describe("adversarial input", () => {
  it("reads each line field once, so escalating getters cannot overdraw", () => {
    const { inv } = fixture(10);
    let reads = 0;
    const hostile = {
      sku: "widget",
      get qty() {
        // 1 to whoever validates, 500 to whoever commits.
        return ++reads === 1 ? 1 : 500;
      },
    };
    inv.reserve("o1", [hostile]);
    expect(inv.available("widget")).toBe(9);
    expect(inv.available("widget")).toBeGreaterThanOrEqual(0);
  });

  it("rejects malformed lines", () => {
    const { inv } = fixture(10);
    expect(() => inv.reserve("a", [null as unknown as Line])).toThrow();
    expect(() => inv.reserve("b", "nope" as unknown as Line[])).toThrow();
    expect(() => inv.reserve("", [{ sku: "widget", qty: 1 }])).toThrow();
    expect(inv.available("widget")).toBe(10);
  });
});
