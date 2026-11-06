import { describe, it, expect } from "vitest";
import { Catalog } from "./catalog";
import { Inventory } from "./inventory";

// Feature edge cases for cancel() + history(). End-state assertions only.
function skuNet(inv: Inventory, sku: string): number {
  return inv
    .getMovements()
    .filter((m) => m.sku === sku)
    .reduce((s, m) => s + Number(m.qty), 0);
}
function tryOp(fn: () => void): void {
  try {
    fn();
  } catch {
    // acceptable; end-state asserted below
  }
}

describe("hidden: feature (cancel + history)", () => {
  it("cancel returns reserved stock to availability", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 25 }]);
    expect(inv.available("a")).toBe(75);
    inv.cancel("o1");
    expect(inv.available("a")).toBe(100);
  });

  it("cancelling the same order twice does not double-restore", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 25 }]);
    inv.cancel("o1");
    tryOp(() => inv.cancel("o1"));
    expect(inv.available("a")).toBe(100);
  });

  it("cancelling when the SKU is discontinued makes no partial change", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 25 }]);
    catalog.discontinue("a");
    const before = inv.available("a");
    tryOp(() => inv.cancel("o1"));
    const restored = inv.available("a") === 100;
    const untouched = inv.available("a") === before;
    expect(restored || untouched).toBe(true);
  });

  it("history returns a SKU's movements within a sequence range", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 500);
    catalog.add("b", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 10 }]);
    inv.reserve("o2", [{ sku: "b", qty: 20 }]);
    inv.reserve("o3", [{ sku: "a", qty: 5 }]);
    const maxSeq = Math.max(...inv.getMovements().map((m) => m.seq));
    const h = inv.history("a", 0, maxSeq);
    expect(h.every((m) => m.sku === "a")).toBe(true);
    expect(h.reduce((s, m) => s + Number(m.qty), 0)).toBe(skuNet(inv, "a"));
  });

  it("cancelling preserves the append-only movement log (audit trail intact)", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 25 }]);
    inv.cancel("o1");
    expect(inv.available("a")).toBe(100); // stock restored
    const forA = inv.getMovements().filter((m) => m.sku === "a");
    expect(forA.some((m) => Number(m.qty) === -25)).toBe(true); // original reservation not erased
    expect(forA.reduce((s, m) => s + Number(m.qty), 0)).toBe(0); // net zero after cancel
  });

  it("history respects a narrow sequence range", () => {
    const catalog = new Catalog();
    catalog.add("a", 100, 500);
    const inv = new Inventory(catalog);
    inv.reserve("o1", [{ sku: "a", qty: 10 }]);
    inv.reserve("o2", [{ sku: "a", qty: 20 }]);
    inv.reserve("o3", [{ sku: "a", qty: 30 }]);
    const seqs = inv
      .getMovements()
      .filter((m) => m.sku === "a")
      .map((m) => m.seq)
      .sort((x, y) => x - y);
    const mid = seqs[1];
    const h = inv.history("a", mid, mid);
    expect(h.length).toBe(1);
    expect(h[0].seq).toBe(mid);
  });
});
