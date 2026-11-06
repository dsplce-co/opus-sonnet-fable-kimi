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
  it("rejects adding a SKU id twice (would reset on-hand stock)", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    expect(() => catalog.add("widget", 5, 500)).toThrow(/already exists/);
    expect(catalog.get("widget").initial).toBe(100);
  });

  it("rejects invalid initial quantities and prices", () => {
    const catalog = new Catalog();
    expect(() => catalog.add("a", -1, 500)).toThrow();
    expect(() => catalog.add("b", 1.5, 500)).toThrow();
    expect(() => catalog.add("c", NaN, 500)).toThrow();
    expect(() => catalog.add("d", Infinity, 500)).toThrow();
    expect(() => catalog.add("e", 10, -1)).toThrow();
    expect(() => catalog.add("f", 10, 0.5)).toThrow();
    expect(() => catalog.add("", 10, 500)).toThrow();
    // None of the failed adds were recorded.
    for (const id of ["a", "b", "c", "d", "e", "f", ""]) {
      expect(() => catalog.get(id)).toThrow(/no such sku/);
    }
  });

  it("accepts zero initial stock and zero price", () => {
    const catalog = new Catalog();
    const sku = catalog.add("free", 0, 0);
    expect(sku.initial).toBe(0);
    expect(sku.unitPrice).toBe(0);
  });

  it("returned SKU objects are snapshots; mutating them does not corrupt the catalog", () => {
    const catalog = new Catalog();
    const added = catalog.add("widget", 100, 500) as { state: string; initial: number };
    added.state = "discontinued";
    added.initial = 999;
    expect(catalog.get("widget").state).toBe("active");
    expect(catalog.get("widget").initial).toBe(100);
    const got = catalog.get("widget") as { initial: number };
    got.initial = 0;
    expect(catalog.get("widget").initial).toBe(100);
  });

  it("discontinue is idempotent and rejects unknown SKUs", () => {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    catalog.discontinue("widget");
    catalog.discontinue("widget");
    expect(catalog.get("widget").state).toBe("discontinued");
    expect(() => catalog.discontinue("nope")).toThrow(/no such sku/);
  });

  it("get rejects unknown SKUs", () => {
    const catalog = new Catalog();
    expect(() => catalog.get("nope")).toThrow(/no such sku/);
  });
});

function setup(): { catalog: Catalog; inv: Inventory } {
  const catalog = new Catalog();
  catalog.add("widget", 100, 500);
  catalog.add("gadget", 10, 250);
  const inv = new Inventory(catalog);
  return { catalog, inv };
}

describe("reserve correctness", () => {
  it("rejects discontinued SKUs", () => {
    const { catalog, inv } = setup();
    catalog.discontinue("widget");
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 1 }])).toThrow(/discontinued/);
    expect(inv.available("widget")).toBe(100);
  });

  it("rejects non-positive, fractional and non-finite quantities without touching stock", () => {
    const { inv } = setup();
    for (const qty of [0, -5, 1.5, NaN, Infinity, -Infinity]) {
      expect(() => inv.reserve("o1", [{ sku: "widget", qty }])).toThrow();
    }
    expect(inv.available("widget")).toBe(100);
    expect(inv.getMovements()).toHaveLength(0);
  });

  it("rejects an empty order id, an empty order and malformed lines", () => {
    const { inv } = setup();
    expect(() => inv.reserve("", [{ sku: "widget", qty: 1 }])).toThrow();
    expect(() => inv.reserve("o1", [])).toThrow();
    expect(() => inv.reserve("o1", null as never)).toThrow();
    expect(() => inv.reserve("o1", [null as never])).toThrow();
    expect(() => inv.reserve("o1", [{ sku: "", qty: 1 }])).toThrow();
    expect(inv.getMovements()).toHaveLength(0);
  });

  it("is atomic: a failing later line leaves earlier lines unreserved", () => {
    const { inv } = setup();
    expect(() =>
      inv.reserve("o1", [
        { sku: "widget", qty: 10 },
        { sku: "gadget", qty: 999 },
      ]),
    ).toThrow(/insufficient stock for gadget/);
    expect(inv.available("widget")).toBe(100);
    expect(inv.available("gadget")).toBe(10);
    expect(inv.getMovements()).toHaveLength(0);

    expect(() =>
      inv.reserve("o2", [
        { sku: "widget", qty: 10 },
        { sku: "missing", qty: 1 },
      ]),
    ).toThrow(/no such sku/);
    expect(inv.available("widget")).toBe(100);
  });

  it("aggregates repeated SKUs within one order when checking availability", () => {
    const { inv } = setup();
    expect(() =>
      inv.reserve("o1", [
        { sku: "widget", qty: 60 },
        { sku: "widget", qty: 60 },
      ]),
    ).toThrow(/insufficient stock for widget/);
    expect(inv.available("widget")).toBe(100);

    inv.reserve("o2", [
      { sku: "widget", qty: 60 },
      { sku: "widget", qty: 40 },
    ]);
    expect(inv.available("widget")).toBe(0);
    expect(inv.getMovements()).toHaveLength(2);
  });

  it("allows reserving exactly the available quantity, then nothing more", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "gadget", qty: 10 }]);
    expect(inv.available("gadget")).toBe(0);
    expect(() => inv.reserve("o2", [{ sku: "gadget", qty: 1 }])).toThrow(/insufficient/);
    expect(inv.available("gadget")).toBe(0);
  });

  it("commits the values that were validated, not values read later from adversarial lines", () => {
    const { inv } = setup();
    let reads = 0;
    const line = {
      sku: "widget",
      get qty() {
        reads++;
        return reads === 1 ? 1 : -1000;
      },
    };
    inv.reserve("o1", [line]);
    expect(inv.available("widget")).toBe(99);
  });

  it("records one movement per line with increasing seq", () => {
    const { inv } = setup();
    inv.reserve("o1", [
      { sku: "widget", qty: 5 },
      { sku: "gadget", qty: 2 },
    ]);
    const ms = inv.getMovements();
    expect(ms.map((m) => [m.seq, m.orderId, m.sku, m.qty])).toEqual([
      [0, "o1", "widget", -5],
      [1, "o1", "gadget", -2],
    ]);
  });
});

describe("reserve retry safety", () => {
  it("retrying the same order with the same lines is a no-op", () => {
    const { inv } = setup();
    const lines = [
      { sku: "widget", qty: 30 },
      { sku: "gadget", qty: 2 },
    ];
    inv.reserve("o1", lines);
    inv.reserve("o1", lines);
    inv.reserve("o1", [{ sku: "widget", qty: 30 }, { sku: "gadget", qty: 2 }]);
    expect(inv.available("widget")).toBe(70);
    expect(inv.available("gadget")).toBe(8);
    expect(inv.getMovements()).toHaveLength(2);
  });

  it("rejects reusing an order id with different lines", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 31 }])).toThrow(/already exists/);
    expect(() => inv.reserve("o1", [{ sku: "gadget", qty: 30 }])).toThrow(/already exists/);
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

  it("a retry stays a no-op even if the SKU was discontinued after the original reserve", () => {
    const { catalog, inv } = setup();
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    catalog.discontinue("widget");
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 30 }])).not.toThrow();
    expect(inv.available("widget")).toBe(70);
    expect(inv.getMovements()).toHaveLength(1);
    expect(() => inv.reserve("o2", [{ sku: "widget", qty: 1 }])).toThrow(/discontinued/);
  });

  it("a failed reserve leaves no record, so the id can be retried with valid lines", () => {
    const { inv } = setup();
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 500 }])).toThrow(/insufficient/);
    inv.reserve("o1", [{ sku: "widget", qty: 5 }]);
    expect(inv.available("widget")).toBe(95);
  });
});

describe("internal state is sealed", () => {
  it("mutating the array returned by getMovements does not affect the ledger", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "widget", qty: 10 }]);
    const leaked = inv.getMovements();
    leaked.push({ seq: 99, orderId: "evil", sku: "widget", qty: 1000 });
    leaked.splice(0, 1);
    expect(inv.getMovements()).toHaveLength(1);
    expect(inv.available("widget")).toBe(90);
  });

  it("movement objects are immutable", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "widget", qty: 10 }]);
    const m = inv.getMovements()[0] as { qty: number };
    expect(() => {
      m.qty = 1000;
    }).toThrow(TypeError);
    expect(inv.getMovements()[0].qty).toBe(-10);
    expect(inv.available("widget")).toBe(90);
  });
});

describe("order line value", () => {
  function service(): OrderService {
    const catalog = new Catalog();
    catalog.add("widget", 100, 500);
    catalog.add("odd", 100, 1001);
    catalog.add("half", 100, 1005);
    catalog.add("eleven", 100, 1100);
    catalog.add("cent", 100, 100);
    catalog.add("ninety", 100, 90);
    return new OrderService(new Inventory(catalog), catalog);
  }

  it("computes exact values with and without discount", () => {
    const s = service();
    expect(s.lineValue("widget", 30, 0)).toBe(15000);
    expect(s.lineValue("widget", 30, 10)).toBe(13500);
    expect(s.lineValue("widget", 30, 100)).toBe(0);
    expect(s.lineValue("widget", 0, 25)).toBe(0);
  });

  it("returns integer minor units where float arithmetic would drift", () => {
    const s = service();
    expect(s.lineValue("eleven", 1, 7)).toBe(1023);
    expect(s.lineValue("eleven", 3, 3)).toBe(3201);
    // Old formula: 100 - 100 * 0.55 = 44.99999999999999
    expect(s.lineValue("cent", 1, 55)).toBe(45);
    // Old formula: 90 - 90 * 0.70 = 27.000000000000007
    expect(s.lineValue("ninety", 1, 70)).toBe(27);
    expect(Number.isInteger(s.lineValue("odd", 7, 13))).toBe(true);
  });

  it("rounds half-up to the nearest minor unit", () => {
    const s = service();
    // 1001 * 93 / 100 = 930.93 -> 931
    expect(s.lineValue("odd", 1, 7)).toBe(931);
    // 1005 * 50 / 100 = 502.5 -> 503
    expect(s.lineValue("half", 1, 50)).toBe(503);
    // 1001 * 99 / 100 = 990.99 -> 991 ; 1001 * 1 / 100 = 10.01 -> 10
    expect(s.lineValue("odd", 1, 1)).toBe(991);
    expect(s.lineValue("odd", 1, 99)).toBe(10);
  });

  it("rejects invalid discounts", () => {
    const s = service();
    for (const pct of [-1, 101, 1.5, NaN, Infinity]) {
      expect(() => s.lineValue("widget", 1, pct)).toThrow();
    }
  });

  it("rejects invalid quantities and unknown SKUs", () => {
    const s = service();
    for (const qty of [-1, 1.5, NaN, Infinity]) {
      expect(() => s.lineValue("widget", qty, 0)).toThrow();
    }
    expect(() => s.lineValue("nope", 1, 0)).toThrow(/no such sku/);
  });

  it("rejects quantities whose product would leave the safe-integer range", () => {
    const s = service();
    expect(() => s.lineValue("widget", Number.MAX_SAFE_INTEGER, 0)).toThrow();
  });
});

describe("cancel", () => {
  it("returns the reserved stock to availability with positive movements", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    expect(inv.available("widget")).toBe(70);
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
    const ms = inv.getMovements();
    expect(ms.map((m) => [m.seq, m.orderId, m.sku, m.qty])).toEqual([
      [0, "o1", "widget", -30],
      [1, "o1", "widget", 30],
    ]);
  });

  it("returns every line of a multi-line order", () => {
    const { inv } = setup();
    inv.reserve("o1", [
      { sku: "widget", qty: 30 },
      { sku: "gadget", qty: 4 },
      { sku: "widget", qty: 20 },
    ]);
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
    expect(inv.available("gadget")).toBe(10);
    expect(inv.getMovements()).toHaveLength(6);
  });

  it("is idempotent: cancelling twice does not add stock twice", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.cancel("o1");
    inv.cancel("o1");
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
    expect(inv.getMovements()).toHaveLength(2);
  });

  it("rejects unknown order ids and invalid ids", () => {
    const { inv } = setup();
    expect(() => inv.cancel("nope")).toThrow(/no such order/);
    expect(() => inv.cancel("")).toThrow();
    expect(inv.getMovements()).toHaveLength(0);
  });

  it("an order whose reserve failed cannot be cancelled", () => {
    const { inv } = setup();
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 500 }])).toThrow();
    expect(() => inv.cancel("o1")).toThrow(/no such order/);
  });

  it("returns stock for a SKU discontinued after the reservation, which still cannot be reserved", () => {
    const { catalog, inv } = setup();
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    catalog.discontinue("widget");
    inv.cancel("o1");
    expect(inv.available("widget")).toBe(100);
    expect(() => inv.reserve("o2", [{ sku: "widget", qty: 1 }])).toThrow(/discontinued/);
  });

  it("stock freed by a cancel can be reserved by another order", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "gadget", qty: 10 }]);
    expect(() => inv.reserve("o2", [{ sku: "gadget", qty: 1 }])).toThrow(/insufficient/);
    inv.cancel("o1");
    inv.reserve("o2", [{ sku: "gadget", qty: 10 }]);
    expect(inv.available("gadget")).toBe(0);
  });

  it("a late retry of the original reserve after cancel is a no-op and the id stays consumed", () => {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    inv.cancel("o1");
    inv.reserve("o1", [{ sku: "widget", qty: 30 }]);
    expect(inv.available("widget")).toBe(100);
    expect(inv.getMovements()).toHaveLength(2);
    expect(() => inv.reserve("o1", [{ sku: "widget", qty: 1 }])).toThrow(/already exists/);
  });

  it("never lets availability exceed the initial on-hand quantity", () => {
    const { inv } = setup();
    for (let i = 0; i < 20; i++) {
      inv.reserve(`o${i}`, [{ sku: "widget", qty: 5 }]);
      inv.cancel(`o${i}`);
      inv.cancel(`o${i}`);
      expect(inv.available("widget")).toBe(100);
    }
    const seqs = inv.getMovements().map((m) => m.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  });
});

describe("history", () => {
  function ledger(): Inventory {
    const { inv } = setup();
    inv.reserve("o1", [{ sku: "widget", qty: 1 }]); // seq 0
    inv.reserve("o2", [{ sku: "gadget", qty: 1 }]); // seq 1
    inv.reserve("o3", [
      { sku: "widget", qty: 2 }, // seq 2
      { sku: "gadget", qty: 2 }, // seq 3
    ]);
    inv.cancel("o1"); // seq 4 (+1 widget)
    inv.reserve("o4", [{ sku: "widget", qty: 3 }]); // seq 5
    return inv;
  }

  it("returns only that SKU's movements within the inclusive range, in seq order", () => {
    const inv = ledger();
    expect(inv.history("widget", 0, 5).map((m) => [m.seq, m.orderId, m.qty])).toEqual([
      [0, "o1", -1],
      [2, "o3", -2],
      [4, "o1", 1],
      [5, "o4", -3],
    ]);
    expect(inv.history("gadget", 0, 5).map((m) => m.seq)).toEqual([1, 3]);
  });

  it("treats both bounds as inclusive", () => {
    const inv = ledger();
    expect(inv.history("widget", 2, 4).map((m) => m.seq)).toEqual([2, 4]);
    expect(inv.history("widget", 2, 2).map((m) => m.seq)).toEqual([2]);
    expect(inv.history("widget", 3, 3)).toEqual([]);
    expect(inv.history("widget", 5, 5).map((m) => m.seq)).toEqual([5]);
  });

  it("returns [] for ranges outside the ledger and clamps ranges that overlap it", () => {
    const inv = ledger();
    expect(inv.history("widget", 6, 100)).toEqual([]);
    expect(inv.history("widget", -10, -1)).toEqual([]);
    expect(inv.history("widget", -10, 0).map((m) => m.seq)).toEqual([0]);
    expect(inv.history("widget", 4, 1000).map((m) => m.seq)).toEqual([4, 5]);
    expect(inv.history("widget", 0, Number.MAX_SAFE_INTEGER)).toHaveLength(4);
  });

  it("rejects unknown SKUs, inverted ranges and non-integer bounds", () => {
    const inv = ledger();
    expect(() => inv.history("nope", 0, 5)).toThrow(/no such sku/);
    expect(() => inv.history("widget", 5, 0)).toThrow(/fromSeq/);
    expect(() => inv.history("widget", 0.5, 5)).toThrow();
    expect(() => inv.history("widget", 0, NaN)).toThrow();
    expect(() => inv.history("widget", -Infinity, Infinity)).toThrow();
    expect(() => inv.history("", 0, 5)).toThrow();
  });

  it("returns a fresh array of immutable movements", () => {
    const inv = ledger();
    const h = inv.history("widget", 0, 5);
    h.length = 0;
    expect(inv.history("widget", 0, 5)).toHaveLength(4);
    const m = inv.history("widget", 0, 0)[0] as { qty: number };
    expect(() => {
      m.qty = 0;
    }).toThrow(TypeError);
    expect(inv.available("widget")).toBe(95);
  });

  it("is consistent with getMovements", () => {
    const inv = ledger();
    const all = inv.getMovements();
    expect(all.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(inv.history("widget", 0, 5)).toEqual(all.filter((m) => m.sku === "widget"));
  });
});
