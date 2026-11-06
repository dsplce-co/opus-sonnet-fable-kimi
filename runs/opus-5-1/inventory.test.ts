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

// ---------------------------------------------------------------------------
// Regression tests for the defects found during the production-readiness pass,
// plus coverage for cancel() and history(). The five tests above are the
// original suite and are unchanged.
// ---------------------------------------------------------------------------

function setup(initial = 100, unitPrice = 500) {
  const catalog = new Catalog();
  catalog.add("widget", initial, unitPrice);
  const inv = new Inventory(catalog);
  const orders = new OrderService(inv, catalog);
  return { catalog, inv, orders };
}

/** Availability recomputed from scratch, to cross-check the cached index. */
function replay(inv: Inventory, catalog: Catalog, sku: string): number {
  return inv
    .getMovements()
    .filter((m) => m.sku === sku)
    .reduce((q, m) => q + m.qty, catalog.get(sku).initial);
}

describe("catalog integrity", () => {
  it("refuses to redefine an existing SKU", () => {
    const { catalog } = setup();
    expect(() => catalog.add("widget", 3, 500)).toThrow(/already exists/);
  });

  it("re-adding cannot retroactively drive availability negative", () => {
    const { catalog, inv, orders } = setup(10);
    orders.place("o1", "widget", 5);
    expect(() => catalog.add("widget", 3, 500)).toThrow();
    expect(inv.available("widget")).toBe(5);
  });

  it("rejects invalid SKU definitions", () => {
    const catalog = new Catalog();
    expect(() => catalog.add("", 10, 1)).toThrow();
    expect(() => catalog.add("a", -10, 1)).toThrow();
    expect(() => catalog.add("b", 1.5, 1)).toThrow();
    expect(() => catalog.add("c", NaN, 1)).toThrow();
    expect(() => catalog.add("d", 10, -1)).toThrow();
  });

  it("does not hand out the live SKU record", () => {
    const { catalog, inv } = setup();
    expect(() => {
      (catalog.get("widget") as { initial: number }).initial = 1_000_000;
    }).toThrow();
    expect(catalog.get("widget").initial).toBe(100);
    expect(inv.available("widget")).toBe(100);
  });

  it("discontinue is idempotent", () => {
    const { catalog } = setup();
    catalog.discontinue("widget");
    catalog.discontinue("widget");
    expect(catalog.get("widget").state).toBe("discontinued");
  });

  it("unknown SKUs are rejected", () => {
    const { catalog } = setup();
    expect(() => catalog.get("nope")).toThrow(/no such sku/);
  });
});

describe("reserve is atomic", () => {
  it("a failing later line leaves no trace of the earlier ones", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 1);
    catalog.add("b", 1, 1);
    const inv = new Inventory(catalog);

    expect(() => inv.reserve("o1", [{ sku: "a", qty: 10 }, { sku: "b", qty: 99 }])).toThrow(
      /insufficient stock for b/,
    );

    expect(inv.available("a")).toBe(100);
    expect(inv.available("b")).toBe(1);
    expect(inv.getMovements()).toHaveLength(0);
  });

  it("an unknown SKU on a later line rolls the whole order back", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 1);
    const inv = new Inventory(catalog);

    expect(() => inv.reserve("o1", [{ sku: "a", qty: 10 }, { sku: "ghost", qty: 1 }])).toThrow();
    expect(inv.available("a")).toBe(100);
    expect(inv.getMovements()).toHaveLength(0);
  });

  it("sums demand per SKU across lines instead of checking each in isolation", () => {
    const { inv } = setup(100);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 60 }, { sku: "widget", qty: 60 }])).toThrow(
      /insufficient stock/,
    );
    expect(inv.available("widget")).toBe(100);

    inv.reserve("o2", [{ sku: "widget", qty: 60 }, { sku: "widget", qty: 40 }]);
    expect(inv.available("widget")).toBe(0);
  });
});

describe("reserve rejects invalid input", () => {
  it("a negative quantity cannot mint stock", () => {
    const { inv } = setup(10);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: -50 }])).toThrow();
    expect(inv.available("widget")).toBe(10);
  });

  it("rejects zero, fractional and non-finite quantities", () => {
    const { inv } = setup(10);
    for (const qty of [0, 0.5, NaN, Infinity, -Infinity]) {
      expect(() => inv.reserve(`o-${String(qty)}`, [{ sku: "widget", qty }])).toThrow();
    }
    expect(inv.available("widget")).toBe(10);
    expect(Number.isInteger(inv.available("widget"))).toBe(true);
  });

  it("rejects empty orders and bad identifiers", () => {
    const { inv } = setup();
    expect(() => inv.reserve("o1", [])).toThrow();
    expect(() => inv.reserve("", [{ sku: "widget", qty: 1 }])).toThrow();
    expect(() => inv.reserve("o1", [{ sku: "", qty: 1 }])).toThrow();
  });

  it("cannot reserve a discontinued SKU", () => {
    const { catalog, inv } = setup(10);
    catalog.discontinue("widget");
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 1 }])).toThrow(/discontinued/);
    expect(inv.available("widget")).toBe(10);
  });
});

describe("reserve is safe to retry", () => {
  it("replaying an identical reservation is a no-op", () => {
    const { inv } = setup(10);
    inv.reserve("o1", [{ sku: "widget", qty: 5 }]);
    inv.reserve("o1", [{ sku: "widget", qty: 5 }]);
    expect(inv.available("widget")).toBe(5);
    expect(inv.getMovements()).toHaveLength(1);
  });

  it("reusing an orderId for different lines is rejected", () => {
    const { inv } = setup(10);
    inv.reserve("o1", [{ sku: "widget", qty: 5 }]);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 2 }])).toThrow(/different lines/);
    expect(inv.available("widget")).toBe(5);
  });
});

describe("internal state is not reachable by callers", () => {
  it("getMovements returns copies, not the live ledger", () => {
    const { inv, orders } = setup(100);
    orders.place("o1", "widget", 30);

    const stolen = inv.getMovements();
    stolen.push({ seq: 999, orderId: "evil", sku: "widget", qty: -1000 });
    stolen[0].qty = -99999;

    expect(inv.available("widget")).toBe(70);
    expect(inv.getMovements()).toHaveLength(1);
  });

  it("mutating the caller's lines after reserve does not change the order", () => {
    const { inv } = setup(100);
    const lines = [{ sku: "widget", qty: 10 }];
    inv.reserve("o1", lines);
    lines[0].qty = 90;
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
  });
});

describe("cancel", () => {
  it("returns reserved stock to availability", () => {
    const { inv, orders } = setup(100);
    orders.place("o1", "widget", 30);
    expect(inv.available("widget")).toBe(70);

    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
  });

  it("records a positive movement rather than deleting history", () => {
    const { inv, orders } = setup(100);
    orders.place("o1", "widget", 30);
    inv.cancel("o1");

    const ms = inv.getMovements();
    expect(ms).toHaveLength(2);
    expect(ms[0].qty).toBe(-30);
    expect(ms[1].qty).toBe(30);
    expect(ms[1].orderId).toBe("o1");
    expect(ms[1].seq).toBeGreaterThan(ms[0].seq);
  });

  it("is safe to call more than once", () => {
    const { inv, orders } = setup(100);
    orders.place("o1", "widget", 30);
    inv.cancel("o1");
    inv.cancel("o1");
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
    expect(inv.getMovements()).toHaveLength(2);
  });

  it("rejects an unknown order", () => {
    const { inv } = setup();
    expect(() => inv.cancel("nope")).toThrow(/no such order/);
  });

  it("is atomic across a multi-line order", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 1);
    catalog.add("b", 100, 1);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 10 }, { sku: "b", qty: 20 }]);
    catalog.discontinue("b");

    expect(() => inv.cancel("o1")).toThrow(/discontinued/);
    // Neither line was returned, and the order is still cancellable later.
    expect(inv.available("a")).toBe(90);
    expect(inv.available("b")).toBe(80);
    expect(inv.getMovements()).toHaveLength(2);
  });

  it("does not let a cancelled orderId be reused", () => {
    const { inv, orders } = setup(100);
    orders.place("o1", "widget", 30);
    inv.cancel("o1");
    expect(() => orders.place("o1", "widget", 30)).toThrow(/not reusable/);
    expect(inv.available("widget")).toBe(100);
  });

  it("stock is conserved across reserve and cancel cycles", () => {
    const { catalog, inv, orders } = setup(100);
    for (let i = 0; i < 20; i++) {
      orders.place(`o${i}`, "widget", 5);
    }
    expect(inv.available("widget")).toBe(0);
    for (let i = 0; i < 20; i++) {
      inv.cancel(`o${i}`);
    }
    expect(inv.available("widget")).toBe(100);
    expect(replay(inv, catalog, "widget")).toBe(100);
  });
});

describe("history", () => {
  function ledger() {
    const catalog = new Catalog();
    catalog.add("a", 100, 1);
    catalog.add("b", 100, 1);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 1 }]); // seq 0
    inv.reserve("o2", [{ sku: "b", qty: 2 }]); // seq 1
    inv.reserve("o3", [{ sku: "a", qty: 3 }]); // seq 2
    inv.cancel("o1"); //                          seq 3
    return { catalog, inv };
  }

  it("filters by SKU and includes both range bounds", () => {
    const { inv } = ledger();
    expect(inv.history("a", 0, 3).map((m) => m.seq)).toEqual([0, 2, 3]);
    expect(inv.history("b", 0, 3).map((m) => m.seq)).toEqual([1]);
  });

  it("excludes movements outside the range", () => {
    const { inv } = ledger();
    expect(inv.history("a", 1, 2).map((m) => m.seq)).toEqual([2]);
    expect(inv.history("a", 0, 0).map((m) => m.seq)).toEqual([0]);
    expect(inv.history("a", 4, 9)).toEqual([]);
  });

  it("returns signed quantities including cancels", () => {
    const { inv } = ledger();
    expect(inv.history("a", 0, 3).map((m) => m.qty)).toEqual([-1, -3, 1]);
  });

  it("returns an empty array for an inverted range", () => {
    const { inv } = ledger();
    expect(inv.history("a", 3, 0)).toEqual([]);
  });

  it("rejects an unknown SKU and non-integer bounds", () => {
    const { inv } = ledger();
    expect(() => inv.history("ghost", 0, 3)).toThrow(/no such sku/);
    expect(() => inv.history("a", NaN, 3)).toThrow();
    expect(() => inv.history("a", 0.5, 3)).toThrow();
  });

  it("remains readable after the SKU is discontinued", () => {
    const { catalog, inv } = ledger();
    catalog.discontinue("a");
    expect(inv.history("a", 0, 3)).toHaveLength(3);
  });

  it("returns copies that cannot edit the ledger", () => {
    const { inv } = ledger();
    const rows = inv.history("a", 0, 3);
    rows[0].qty = -9999;
    expect(inv.history("a", 0, 3)[0].qty).toBe(-1);
    expect(inv.available("a")).toBe(97);
  });
});

describe("monetary arithmetic", () => {
  it("returns whole minor units", () => {
    const { orders } = setup(100, 999);
    expect(orders.lineValue("widget", 3, 10)).toBe(2697);
    expect(orders.lineValue("widget", 1, 33)).toBe(669);
    expect(Number.isInteger(orders.lineValue("widget", 7, 17))).toBe(true);
  });

  it("rounds a half minor unit up", () => {
    const { orders } = setup(100, 50);
    // gross 250, 1% = 2.5 -> discount 3 -> net 247
    expect(orders.lineValue("widget", 5, 1)).toBe(247);
  });

  it("handles the zero and full discount boundaries", () => {
    const { orders } = setup(100, 999);
    expect(orders.lineValue("widget", 3, 0)).toBe(2997);
    expect(orders.lineValue("widget", 3, 100)).toBe(0);
  });

  it("rejects discounts outside 0-100 and invalid quantities", () => {
    const { orders } = setup(100, 999);
    expect(() => orders.lineValue("widget", 1, -100)).toThrow();
    expect(() => orders.lineValue("widget", 1, 101)).toThrow();
    expect(() => orders.lineValue("widget", 1, 10.5)).toThrow();
    expect(() => orders.lineValue("widget", 0, 10)).toThrow();
    expect(() => orders.lineValue("widget", 1.5, 10)).toThrow();
  });
});

describe("ledger invariants", () => {
  it("cached availability always matches a full replay of the ledger", () => {
    const catalog = new Catalog();
    catalog.add("a", 50, 100);
    catalog.add("b", 50, 100);
    const inv = new Inventory(catalog);

    inv.reserve("o1", [{ sku: "a", qty: 10 }, { sku: "b", qty: 5 }]);
    inv.reserve("o2", [{ sku: "a", qty: 7 }]);
    inv.cancel("o1");
    inv.reserve("o3", [{ sku: "b", qty: 50 }]);

    expect(inv.available("a")).toBe(replay(inv, catalog, "a"));
    expect(inv.available("b")).toBe(replay(inv, catalog, "b"));
    expect(inv.available("a")).toBe(43);
    expect(inv.available("b")).toBe(0);
  });

  it("availability never goes negative under a burst of oversized orders", () => {
    const { inv } = setup(10);
    for (let i = 0; i < 50; i++) {
      try {
        inv.reserve(`o${i}`, [{ sku: "widget", qty: 3 }]);
      } catch {
        // expected once stock runs out
      }
      expect(inv.available("widget")).toBeGreaterThanOrEqual(0);
    }
    expect(inv.available("widget")).toBe(1);
  });

  it("seq numbers are unique and strictly increasing", () => {
    const { inv, orders } = setup(100);
    orders.place("o1", "widget", 1);
    orders.place("o2", "widget", 2);
    inv.cancel("o1");
    const seqs = inv.getMovements().map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
