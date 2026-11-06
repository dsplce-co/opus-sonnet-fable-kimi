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
  it("rejects a duplicate SKU id and keeps the original record", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    expect(() => catalog.add("widget", 1, 1)).toThrow(/already exists/);
    expect(catalog.get("widget")).toEqual({ id: "widget", state: "active", initial: 100, unitPrice: 500 });
  });

  it("rejects invalid ids, quantities and prices", () => {
    const catalog = new Catalog();
    expect(() => catalog.add("", 1, 1)).toThrow();
    expect(() => catalog.add("a", -1, 1)).toThrow();
    expect(() => catalog.add("b", 1.5, 1)).toThrow();
    expect(() => catalog.add("c", NaN, 1)).toThrow();
    expect(() => catalog.add("d", Infinity, 1)).toThrow();
    expect(() => catalog.add("e", 1, -1)).toThrow();
    expect(() => catalog.add("f", 1, 0.5)).toThrow();
    expect(() => catalog.add("g", Number.MAX_SAFE_INTEGER + 1, 1)).toThrow();
    // Nothing partially registered.
    for (const id of ["", "a", "b", "c", "d", "e", "f", "g"]) {
      expect(() => catalog.get(id)).toThrow();
    }
  });

  it("get() and add() return snapshots that cannot corrupt the catalog", () => {
    const catalog = new Catalog();
    const added = catalog.add("widget", 100, 500);
    added.initial = 1_000_000;
    added.state = "discontinued";
    const got = catalog.get("widget");
    got.initial = -5;
    got.unitPrice = 0;
    expect(catalog.get("widget")).toEqual({ id: "widget", state: "active", initial: 100, unitPrice: 500 });
  });

  it("discontinue is idempotent and throws for unknown SKUs", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    catalog.discontinue("widget");
    catalog.discontinue("widget");
    expect(catalog.get("widget").state).toBe("discontinued");
    expect(() => catalog.discontinue("nope")).toThrow(/no such sku/);
  });
});

describe("reserve safety", () => {
  function setup(initial = 100) {
    const catalog = new Catalog();
    catalog.add("widget", initial, 500);
    catalog.add("gadget", 10, 250);
    const inv = new Inventory(catalog);
    return { catalog, inv };
  }

  it("rejects non-positive, fractional, NaN and infinite quantities without touching stock", () => {
    const { inv } = setup();
    for (const qty of [0, -1, -50, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => inv.reserve(`o-${qty}`, [{ sku: "widget", qty }])).toThrow();
    }
    expect(inv.available("widget")).toBe(100);
    expect(inv.getMovements()).toEqual([]);
  });

  it("rejects malformed orders and lines", () => {
    const { inv } = setup();
    expect(() => inv.reserve("", [{ sku: "widget", qty: 1 }])).toThrow(/orderId/);
    expect(() => inv.reserve("o1", [])).toThrow(/at least one line/);
    expect(() => inv.reserve("o1", [{ sku: "", qty: 1 }])).toThrow(/sku/);
    expect(() => inv.reserve("o1", [null as unknown as { sku: string; qty: number }])).toThrow();
    expect(() => inv.reserve("o1", [{ sku: "nope", qty: 1 }])).toThrow(/no such sku/);
    expect(inv.available("widget")).toBe(100);
    expect(inv.getMovements()).toEqual([]);
  });

  it("a multi-line order is all-or-nothing", () => {
    const { inv } = setup();
    expect(() =>
      inv.reserve("o1", [
        { sku: "widget", qty: 5 },
        { sku: "gadget", qty: 50 },
      ]),
    ).toThrow(/insufficient stock for gadget/);
    expect(inv.available("widget")).toBe(100);
    expect(inv.available("gadget")).toBe(10);
    expect(inv.getMovements()).toEqual([]);

    expect(() =>
      inv.reserve("o2", [
        { sku: "widget", qty: 5 },
        { sku: "missing", qty: 1 },
      ]),
    ).toThrow(/no such sku/);
    expect(inv.available("widget")).toBe(100);
    expect(inv.getMovements()).toEqual([]);
  });

  it("checks stock against the per-SKU total when a SKU appears on several lines", () => {
    const { inv } = setup();
    expect(() =>
      inv.reserve("o1", [
        { sku: "widget", qty: 60 },
        { sku: "widget", qty: 60 },
      ]),
    ).toThrow(/insufficient stock/);
    expect(inv.available("widget")).toBe(100);

    inv.reserve("o2", [
      { sku: "widget", qty: 30 },
      { sku: "widget", qty: 30 },
    ]);
    expect(inv.available("widget")).toBe(40);
    expect(inv.getMovements().map((m) => m.qty)).toEqual([-30, -30]);
  });

  it("can reserve exactly the remaining stock but never drive it negative", () => {
    const { inv } = setup(10);
    inv.reserve("o1", [{ sku: "widget", qty: 10 }]);
    expect(inv.available("widget")).toBe(0);
    expect(() => inv.reserve("o2", [{ sku: "widget", qty: 1 }])).toThrow(/insufficient/);
    expect(inv.available("widget")).toBe(0);
  });

  it("refuses to reserve a discontinued SKU", () => {
    const { catalog, inv } = setup();
    inv.reserve("o1", [{ sku: "widget", qty: 1 }]);
    catalog.discontinue("widget");
    expect(() => inv.reserve("o2", [{ sku: "widget", qty: 1 }])).toThrow(/discontinued/);
    expect(inv.available("widget")).toBe(99);
  });

  it("available() throws for an unknown SKU", () => {
    const { inv } = setup();
    expect(() => inv.available("nope")).toThrow(/no such sku/);
  });

  it("getMovements() returns a snapshot the caller cannot use to corrupt the ledger", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    const snapshot = inv.getMovements();
    snapshot.length = 0;
    snapshot.push({ seq: 99, orderId: "evil", sku: "widget", qty: 1000 });
    expect(inv.available("widget")).toBe(70);
    expect(inv.getMovements()).toEqual([{ seq: 0, orderId: "o1", sku: "widget", qty: -30 }]);

    const entry = inv.getMovements()[0];
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as { qty: number }).qty = 1000;
    }).toThrow();
    expect(inv.available("widget")).toBe(70);
  });

  it("reads each line exactly once, so a getter cannot change qty between validation and write", () => {
    const { inv } = setup();
    let reads = 0;
    const line = {
      sku: "widget",
      get qty() {
        reads += 1;
        return reads === 1 ? 1 : 1_000_000;
      },
    };
    inv.reserve("o1", [line]);
    expect(inv.available("widget")).toBe(99);
    expect(inv.getMovements()).toEqual([{ seq: 0, orderId: "o1", sku: "widget", qty: -1 }]);
  });

  it("seq numbers are unique and strictly increasing in ledger order", () => {
    const { inv } = setup();
    inv.reserve("o1", [
      { sku: "widget", qty: 1 },
      { sku: "gadget", qty: 1 },
    ]);
    inv.reserve("o2", [{ sku: "widget", qty: 1 }]);
    expect(inv.getMovements().map((m) => m.seq)).toEqual([0, 1, 2]);
  });
});

describe("reserve is safe to retry", () => {
  function setup() {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    catalog.add("gadget", 10, 250);
    return { catalog, inv: new Inventory(catalog) };
  }

  it("replaying an identical order is a no-op", () => {
    const { inv } = setup();
    const lines = [
      { sku: "widget", qty: 30 },
      { sku: "gadget", qty: 2 },
    ];
    inv.reserve("o1", lines);
    inv.reserve("o1", lines);
    inv.reserve("o1", [...lines].reverse());
    // Same per-SKU totals, split differently across lines, is still the same order.
    inv.reserve("o1", [
      { sku: "gadget", qty: 1 },
      { sku: "widget", qty: 30 },
      { sku: "gadget", qty: 1 },
    ]);
    expect(inv.available("widget")).toBe(70);
    expect(inv.available("gadget")).toBe(8);
    expect(inv.getMovements()).toHaveLength(2);
  });

  it("re-using an orderId with different lines is rejected and changes nothing", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 31 }])).toThrow(/already exists/);
    expect(() => inv.reserve("o1", [{ sku: "gadget", qty: 1 }])).toThrow(/already exists/);
    expect(() =>
      inv.reserve("o1", [
        { sku: "widget", qty: 30 },
        { sku: "gadget", qty: 1 },
      ]),
    ).toThrow(/already exists/);
    expect(inv.available("widget")).toBe(70);
    expect(inv.available("gadget")).toBe(10);
    expect(inv.getMovements()).toHaveLength(1);
  });

  it("a replay is still validated, so garbage never short-circuits to success", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: NaN }])).toThrow();
    expect(() => inv.reserve("o1", [])).toThrow();
  });
});

describe("cancel", () => {
  function setup() {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    catalog.add("gadget", 10, 250);
    const inv = new Inventory(catalog);
    return { catalog, inv, orders: new OrderService(inv, catalog) };
  }

  function ledgerBalance(inv: Inventory, sku: string): number {
    return inv.getMovements().filter((m) => m.sku === sku).reduce((sum, m) => sum + m.qty, 0);
  }

  it("returns the reserved stock with one positive movement per reserved line", () => {
    const { inv } = setup();
    inv.reserve("o1", [
      { sku: "widget", qty: 30 },
      { sku: "gadget", qty: 4 },
      { sku: "widget", qty: 5 },
    ]);
    inv.reserve("o2", [{ sku: "widget", qty: 10 }]);
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(90);
    expect(inv.available("gadget")).toBe(10);
    expect(inv.getMovements()).toEqual([
      { seq: 0, orderId: "o1", sku: "widget", qty: -30 },
      { seq: 1, orderId: "o1", sku: "gadget", qty: -4 },
      { seq: 2, orderId: "o1", sku: "widget", qty: -5 },
      { seq: 3, orderId: "o2", sku: "widget", qty: -10 },
      { seq: 4, orderId: "o1", sku: "widget", qty: 30 },
      { seq: 5, orderId: "o1", sku: "gadget", qty: 4 },
      { seq: 6, orderId: "o1", sku: "widget", qty: 5 },
    ]);
  });

  it("is idempotent: a second cancel changes nothing", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.cancel("o1");
    inv.cancel("o1");
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
    expect(inv.getMovements()).toHaveLength(2);
  });

  it("rejects unknown or malformed order ids", () => {
    const { inv } = setup();
    expect(() => inv.cancel("nope")).toThrow(/no such order/);
    expect(() => inv.cancel("")).toThrow(/orderId/);
    expect(inv.getMovements()).toEqual([]);
  });

  it("returns stock for a SKU discontinued after the reservation, which still cannot be re-reserved", () => {
    const { catalog, inv } = setup();
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    catalog.discontinue("widget");
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
    expect(() => inv.reserve("o2", [{ sku: "widget", qty: 1 }])).toThrow(/discontinued/);
  });

  it("freed stock is available to later orders", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "gadget", qty: 10 }]);
    expect(() => inv.reserve("o2", [{ sku: "gadget", qty: 1 }])).toThrow(/insufficient/);
    inv.cancel("o1");
    inv.reserve("o2", [{ sku: "gadget", qty: 10 }]);
    expect(inv.available("gadget")).toBe(0);
  });

  it("an orderId cannot be re-reserved after it was cancelled", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.cancel("o1");
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 30 }])).toThrow(/cancelled/);
    expect(inv.available("widget")).toBe(100);
  });

  it("works for orders placed through OrderService", () => {
    const { inv, orders } = setup();
    orders.place("o1", "widget", 25);
    expect(inv.available("widget")).toBe(75);
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
  });

  it("keeps available() equal to initial plus the signed ledger sum at every step", () => {
    const { catalog, inv } = setup();
    const check = () => {
      for (const sku of ["widget", "gadget"]) {
        expect(inv.available(sku)).toBe(catalog.get(sku).initial + ledgerBalance(inv, sku));
        expect(inv.available(sku)).toBeGreaterThanOrEqual(0);
        expect(inv.available(sku)).toBeLessThanOrEqual(catalog.get(sku).initial);
      }
    };
    check();
    inv.reserve("o1", [{ sku: "widget", qty: 40 }, { sku: "gadget", qty: 3 }]);
    check();
    inv.reserve("o2", [{ sku: "widget", qty: 60 }]);
    check();
    expect(() => inv.reserve("o3", [{ sku: "widget", qty: 1 }])).toThrow();
    check();
    inv.cancel("o1");
    check();
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 40 }])).toThrow(/cancelled/);
    check();
    inv.reserve("o4", [{ sku: "widget", qty: 40 }, { sku: "gadget", qty: 3 }]);
    check();
  });
});

describe("history", () => {
  function setup() {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    catalog.add("gadget", 10, 250);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "widget", qty: 1 }]); // seq 0
    inv.reserve("o2", [{ sku: "gadget", qty: 1 }]); // seq 1
    inv.reserve("o3", [{ sku: "widget", qty: 2 }]); // seq 2
    inv.reserve("o4", [{ sku: "widget", qty: 3 }]); // seq 3
    inv.cancel("o1"); // seq 4 (+1 widget)
    inv.reserve("o5", [{ sku: "widget", qty: 4 }]); // seq 5
    return { catalog, inv };
  }

  it("returns only that SKU's movements with seq in the inclusive range, in seq order", () => {
    const { inv } = setup();
    expect(inv.history("widget", 2, 4).map((m) => [m.seq, m.qty])).toEqual([
      [2, -2],
      [3, -3],
      [4, 1],
    ]);
    expect(inv.history("widget", 0, 5).map((m) => m.seq)).toEqual([0, 2, 3, 4, 5]);
    expect(inv.history("gadget", 0, 5).map((m) => m.seq)).toEqual([1]);
    expect(inv.history("widget", 3, 3).map((m) => m.seq)).toEqual([3]);
    expect(inv.history("widget", 1, 1)).toEqual([]);
  });

  it("clamps naturally to the ledger bounds and open-ended ranges", () => {
    const { inv } = setup();
    expect(inv.history("widget", -100, 1000).map((m) => m.seq)).toEqual([0, 2, 3, 4, 5]);
    expect(inv.history("widget", 4, Infinity).map((m) => m.seq)).toEqual([4, 5]);
    expect(inv.history("widget", 100, 200)).toEqual([]);
  });

  it("returns an empty array for an inverted range", () => {
    const { inv } = setup();
    expect(inv.history("widget", 4, 2)).toEqual([]);
  });

  it("rejects unknown SKUs and NaN bounds", () => {
    const { inv } = setup();
    expect(() => inv.history("nope", 0, 5)).toThrow(/no such sku/);
    expect(() => inv.history("", 0, 5)).toThrow(/sku/);
    expect(() => inv.history("widget", NaN, 5)).toThrow(/fromSeq/);
    expect(() => inv.history("widget", 0, NaN)).toThrow(/toSeq/);
  });

  it("returns a snapshot that cannot corrupt the ledger", () => {
    const { inv } = setup();
    const result = inv.history("widget", 0, 5);
    result.length = 0;
    expect(inv.history("widget", 0, 5)).toHaveLength(5);
    expect(inv.history("widget", 0, 5).every((m) => Object.isFrozen(m))).toBe(true);
  });
});

describe("lineValue", () => {
  function setup() {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    catalog.add("odd", 100, 1999);
    catalog.add("penny", 100, 1);
    catalog.add("five", 100, 5);
    catalog.add("huge", 1, Number.MAX_SAFE_INTEGER);
    const inv = new Inventory(catalog);
    return { orders: new OrderService(inv, catalog) };
  }

  it("always returns a whole number of minor units", () => {
    const { orders } = setup();
    expect(orders.lineValue("widget", 30, 10)).toBe(13500);
    // 1999 * 7 = 13993; 7% off = 13013.49 -> 13013
    expect(orders.lineValue("odd", 7, 7)).toBe(13013);
    // 1999 * 1; 29% off = 1419.29 -> 1419
    expect(orders.lineValue("odd", 1, 29)).toBe(1419);
    for (let pct = 0; pct <= 100; pct++) {
      for (const qty of [1, 3, 7, 13]) {
        expect(Number.isSafeInteger(orders.lineValue("odd", qty, pct))).toBe(true);
      }
    }
  });

  it("rounds half-up at the minor-unit boundary", () => {
    const { orders } = setup();
    expect(orders.lineValue("five", 1, 50)).toBe(3); // 2.5
    expect(orders.lineValue("penny", 1, 50)).toBe(1); // 0.5
    expect(orders.lineValue("five", 3, 10)).toBe(14); // 13.5
    expect(orders.lineValue("five", 1, 51)).toBe(2); // 2.45
  });

  it("handles the boundaries: no discount, full discount, zero quantity", () => {
    const { orders } = setup();
    expect(orders.lineValue("widget", 3, 0)).toBe(1500);
    expect(orders.lineValue("widget", 3, 100)).toBe(0);
    expect(orders.lineValue("widget", 0, 25)).toBe(0);
  });

  it("rejects discounts outside 0..100 and non-integer or NaN inputs", () => {
    const { orders } = setup();
    for (const pct of [-1, -50, 101, 1.5, NaN, Infinity]) {
      expect(() => orders.lineValue("widget", 1, pct)).toThrow();
    }
    for (const qty of [-1, 1.5, NaN, Infinity]) {
      expect(() => orders.lineValue("widget", qty, 0)).toThrow();
    }
    expect(() => orders.lineValue("nope", 1, 0)).toThrow(/no such sku/);
  });

  it("refuses to return an imprecise value when the amount leaves the safe integer range", () => {
    const { orders } = setup();
    expect(() => orders.lineValue("huge", 2, 0)).toThrow(/safe integer/);
    expect(() => orders.lineValue("huge", 1, 1)).toThrow(/safe integer/);
  });
});
