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

describe("catalog hardening", () => {
  it("rejects adding a duplicate SKU instead of overwriting it", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    expect(() => catalog.add("widget", 5, 1)).toThrow(/already exists/);
    expect(catalog.get("widget").initial).toBe(100);
    expect(catalog.get("widget").unitPrice).toBe(500);
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
    expect(() => catalog.add("a", 1, Number.MAX_SAFE_INTEGER + 1)).toThrow();
    // A zero on-hand quantity and a zero price are legitimate.
    expect(catalog.add("a", 0, 0).initial).toBe(0);
  });

  it("get and add return snapshots that cannot corrupt the catalog", () => {
    const catalog = new Catalog();
    const added = catalog.add("widget", 100, 500) as { state: string; initial: number };
    added.state = "discontinued";
    added.initial = 0;
    const got = catalog.get("widget") as { state: string; initial: number };
    expect(got.state).toBe("active");
    expect(got.initial).toBe(100);
    got.initial = 0;
    expect(catalog.get("widget").initial).toBe(100);
  });

  it("discontinue is idempotent and unknown SKUs throw", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    catalog.discontinue("widget");
    catalog.discontinue("widget");
    expect(catalog.get("widget").state).toBe("discontinued");
    expect(() => catalog.discontinue("nope")).toThrow(/no such sku/);
    expect(() => catalog.get("nope")).toThrow(/no such sku/);
  });
});

describe("inventory reserve hardening", () => {
  function setup() {
    const catalog = new Catalog();
    catalog.add("a", 10, 100);
    catalog.add("b", 5, 200);
    const inv = new Inventory(catalog);
    return { catalog, inv };
  }

  it("a multi-line order is all-or-nothing", () => {
    const { inv } = setup();
    expect(() => inv.reserve("o1", [{ sku: "a", qty: 3 }, { sku: "b", qty: 6 }])).toThrow(
      /insufficient stock for b/,
    );
    expect(inv.available("a")).toBe(10);
    expect(inv.available("b")).toBe(5);
    expect(inv.getMovements()).toEqual([]);
    // An unknown SKU on a later line also rolls back nothing.
    expect(() => inv.reserve("o2", [{ sku: "a", qty: 3 }, { sku: "zzz", qty: 1 }])).toThrow(
      /no such sku/,
    );
    expect(inv.available("a")).toBe(10);
  });

  it("checks stock for the order as a whole when a SKU repeats across lines", () => {
    const { inv } = setup();
    expect(() => inv.reserve("o1", [{ sku: "a", qty: 6 }, { sku: "a", qty: 6 }])).toThrow(
      /insufficient/,
    );
    expect(inv.available("a")).toBe(10);
    inv.reserve("o2", [{ sku: "a", qty: 6 }, { sku: "a", qty: 4 }]);
    expect(inv.available("a")).toBe(0);
    expect(inv.getMovements()).toHaveLength(2);
  });

  it("rejects quantities that would add stock or corrupt the ledger", () => {
    const { inv } = setup();
    for (const qty of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => inv.reserve("o", [{ sku: "a", qty }]), `qty ${qty}`).toThrow();
    }
    expect(() => inv.reserve("o", [{ sku: "a", qty: "3" as unknown as number }])).toThrow();
    expect(inv.available("a")).toBe(10);
    expect(inv.getMovements()).toEqual([]);
  });

  it("rejects malformed order ids and line lists", () => {
    const { inv } = setup();
    expect(() => inv.reserve("", [{ sku: "a", qty: 1 }])).toThrow();
    expect(() => inv.reserve("o", [])).toThrow();
    expect(() => inv.reserve("o", null as unknown as Line[])).toThrow();
    expect(() => inv.reserve("o", [null as unknown as Line])).toThrow();
    expect(() => inv.reserve("o", [{ sku: "", qty: 1 }])).toThrow();
    expect(inv.getMovements()).toEqual([]);
  });

  it("cannot reserve a discontinued SKU", () => {
    const { catalog, inv } = setup();
    catalog.discontinue("a");
    expect(() => inv.reserve("o1", [{ sku: "a", qty: 1 }])).toThrow(/discontinued/);
    expect(inv.available("a")).toBe(10);
  });

  it("can reserve exactly the available quantity but not one more", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "b", qty: 5 }]);
    expect(inv.available("b")).toBe(0);
    expect(() => inv.reserve("o2", [{ sku: "b", qty: 1 }])).toThrow(/insufficient/);
    expect(inv.available("b")).toBe(0);
  });

  it("retrying an identical reservation is a no-op; a conflicting one is rejected", () => {
    const { inv } = setup();
    const lines = [{ sku: "a", qty: 3 }, { sku: "b", qty: 1 }];
    inv.reserve("o1", lines);
    inv.reserve("o1", lines);
    inv.reserve("o1", [{ sku: "b", qty: 1 }, { sku: "a", qty: 3 }]); // same order, reordered
    expect(inv.available("a")).toBe(7);
    expect(inv.available("b")).toBe(4);
    expect(inv.getMovements()).toHaveLength(2);
    expect(() => inv.reserve("o1", [{ sku: "a", qty: 4 }])).toThrow(/already exists/);
    expect(inv.available("a")).toBe(7);
  });

  it("callers cannot mutate the ledger through getMovements", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "a", qty: 3 }]);
    const ms = inv.getMovements();
    ms.push({ seq: 99, orderId: "x", sku: "a", qty: 100 });
    ms.length = 0;
    expect(inv.getMovements()).toHaveLength(1);
    const m = inv.getMovements()[0] as { qty: number };
    expect(() => {
      m.qty = 0;
    }).toThrow(); // frozen (test file is an ES module, so strict mode)
    expect(inv.available("a")).toBe(7);
    expect(Object.isFrozen(inv.getMovements()[0])).toBe(true);
  });

  it("movements get strictly increasing seq numbers", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "a", qty: 1 }, { sku: "b", qty: 1 }]);
    inv.reserve("o2", [{ sku: "a", qty: 1 }]);
    expect(inv.getMovements().map((m) => m.seq)).toEqual([0, 1, 2]);
    expect(inv.getMovements().map((m) => m.qty)).toEqual([-1, -1, -1]);
  });
});

describe("order line value", () => {
  function setup(unitPrice: number) {
    const catalog = new Catalog();
    catalog.add("w", 1000, unitPrice);
    return new OrderService(new Inventory(catalog), catalog);
  }

  it("returns whole minor units for every whole-percent discount", () => {
    const orders = setup(1999);
    for (let pct = 0; pct <= 100; pct++) {
      const v = orders.lineValue("w", 3, pct);
      expect(Number.isInteger(v), `pct ${pct} -> ${v}`).toBe(true);
    }
  });

  it("computes exact values and rounds half-up", () => {
    const orders = setup(1999);
    expect(orders.lineValue("w", 3, 0)).toBe(5997);
    expect(orders.lineValue("w", 3, 100)).toBe(0);
    expect(orders.lineValue("w", 0, 10)).toBe(0);
    // 5997 * 0.93 = 5577.21 -> 5577
    expect(orders.lineValue("w", 3, 7)).toBe(5577);
    // 5997 * 0.5 = 2998.5 -> 2999 (half-up)
    expect(orders.lineValue("w", 3, 50)).toBe(2999);
    // Float arithmetic would give 1500 * 0.9 = 1350.0000000000002-style noise.
    expect(setup(500).lineValue("w", 3, 10)).toBe(1350);
    // 33% off 3 * 333 = 999 -> 669.33 -> 669
    expect(setup(333).lineValue("w", 3, 33)).toBe(669);
  });

  it("rejects discounts outside 0..100 and non-integer inputs", () => {
    const orders = setup(500);
    expect(() => orders.lineValue("w", 1, 101)).toThrow();
    expect(() => orders.lineValue("w", 1, -1)).toThrow();
    expect(() => orders.lineValue("w", 1, 12.5)).toThrow();
    expect(() => orders.lineValue("w", 1, NaN)).toThrow();
    expect(() => orders.lineValue("w", 1.5, 0)).toThrow();
    expect(() => orders.lineValue("w", -1, 0)).toThrow();
    expect(() => orders.lineValue("nope", 1, 0)).toThrow(/no such sku/);
  });

  it("refuses values that leave the safe integer range instead of returning garbage", () => {
    const orders = setup(Number.MAX_SAFE_INTEGER);
    expect(() => orders.lineValue("w", 2, 0)).toThrow(/safe integer/);
  });
});

describe("cancel", () => {
  function setup() {
    const catalog = new Catalog();
    catalog.add("a", 10, 100);
    catalog.add("b", 5, 200);
    const inv = new Inventory(catalog);
    return { catalog, inv };
  }

  it("returns every reserved unit to availability with positive movements", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "a", qty: 3 }, { sku: "b", qty: 2 }, { sku: "a", qty: 1 }]);
    expect(inv.available("a")).toBe(6);
    inv.cancel("o1");
    expect(inv.available("a")).toBe(10);
    expect(inv.available("b")).toBe(5);
    const ms = inv.getMovements();
    expect(ms.map((m) => [m.seq, m.orderId, m.sku, m.qty])).toEqual([
      [0, "o1", "a", -3],
      [1, "o1", "b", -2],
      [2, "o1", "a", -1],
      [3, "o1", "a", 3],
      [4, "o1", "b", 2],
      [5, "o1", "a", 1],
    ]);
  });

  it("is idempotent: a second cancel adds nothing and never over-credits stock", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "a", qty: 4 }]);
    inv.cancel("o1");
    inv.cancel("o1");
    inv.cancel("o1");
    expect(inv.available("a")).toBe(10);
    expect(inv.getMovements()).toHaveLength(2);
  });

  it("only affects the cancelled order", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "a", qty: 4 }]);
    inv.reserve("o2", [{ sku: "a", qty: 5 }]);
    inv.cancel("o1");
    expect(inv.available("a")).toBe(5);
  });

  it("rejects unknown or malformed order ids", () => {
    const { inv } = setup();
    expect(() => inv.cancel("nope")).toThrow(/no such order/);
    expect(() => inv.cancel("")).toThrow();
    expect(inv.getMovements()).toEqual([]);
  });

  it("frees stock for new reservations, and a cancelled id cannot be reserved again", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "b", qty: 5 }]);
    expect(() => inv.reserve("o2", [{ sku: "b", qty: 1 }])).toThrow(/insufficient/);
    inv.cancel("o1");
    inv.reserve("o2", [{ sku: "b", qty: 5 }]);
    expect(inv.available("b")).toBe(0);
    expect(() => inv.reserve("o1", [{ sku: "a", qty: 1 }])).toThrow(/already exists/);
    expect(() => inv.reserve("o1", [{ sku: "b", qty: 5 }])).toThrow(/already exists/);
  });

  it("returns stock even when the SKU was discontinued after reservation, without reactivating it", () => {
    const { catalog, inv } = setup();
    inv.reserve("o1", [{ sku: "a", qty: 4 }]);
    catalog.discontinue("a");
    inv.cancel("o1");
    expect(inv.available("a")).toBe(10);
    expect(catalog.get("a").state).toBe("discontinued");
    expect(() => inv.reserve("o2", [{ sku: "a", qty: 1 }])).toThrow(/discontinued/);
  });

  it("works through OrderService.place", () => {
    const { inv } = setup();
    const orders = new OrderService(inv, new Catalog());
    orders.place("o1", "a", 7);
    expect(inv.available("a")).toBe(3);
    inv.cancel("o1");
    expect(inv.available("a")).toBe(10);
  });
});

describe("history", () => {
  function setup() {
    const catalog = new Catalog();
    catalog.add("a", 10, 100);
    catalog.add("b", 5, 200);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 1 }, { sku: "b", qty: 1 }]); // seq 0, 1
    inv.reserve("o2", [{ sku: "a", qty: 2 }]); // seq 2
    inv.cancel("o1"); // seq 3 (a, +1), seq 4 (b, +1)
    inv.reserve("o3", [{ sku: "a", qty: 3 }]); // seq 5
    return { catalog, inv };
  }

  it("returns only that SKU's movements within the inclusive range, in seq order", () => {
    const { inv } = setup();
    expect(inv.history("a", 0, 5).map((m) => m.seq)).toEqual([0, 2, 3, 5]);
    expect(inv.history("a", 2, 3).map((m) => [m.seq, m.orderId, m.qty])).toEqual([
      [2, "o2", -2],
      [3, "o1", 1],
    ]);
    expect(inv.history("b", 0, 5).map((m) => m.seq)).toEqual([1, 4]);
    expect(inv.history("b", 1, 1).map((m) => m.seq)).toEqual([1]);
  });

  it("bounds are inclusive on both ends and may extend past the ledger", () => {
    const { inv } = setup();
    expect(inv.history("a", 3, 5).map((m) => m.seq)).toEqual([3, 5]);
    expect(inv.history("a", 4, 4)).toEqual([]);
    expect(inv.history("a", -100, 1000).map((m) => m.seq)).toEqual([0, 2, 3, 5]);
    expect(inv.history("a", 6, 1000)).toEqual([]);
  });

  it("rejects unknown SKUs, non-integer bounds and inverted ranges", () => {
    const { inv } = setup();
    expect(() => inv.history("nope", 0, 5)).toThrow(/no such sku/);
    expect(() => inv.history("a", 0.5, 5)).toThrow();
    expect(() => inv.history("a", 0, NaN)).toThrow();
    expect(() => inv.history("a", 0, Infinity)).toThrow();
    expect(() => inv.history("a", 3, 2)).toThrow(/must be <=/);
  });

  it("returns an independent array of frozen movements", () => {
    const { inv } = setup();
    const h = inv.history("a", 0, 5);
    h.length = 0;
    expect(inv.history("a", 0, 5)).toHaveLength(4);
    expect(inv.history("a", 0, 5).every((m) => Object.isFrozen(m))).toBe(true);
  });

  it("covers a SKU with no movements", () => {
    const catalog = new Catalog();
    catalog.add("lonely", 1, 1);
    expect(new Inventory(catalog).history("lonely", 0, 100)).toEqual([]);
  });
});
