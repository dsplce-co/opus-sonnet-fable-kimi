// aggregate.mjs — parse every graded run into a per-run table + per-model summary.
// Run grade.sh first (it writes hidden.json / own.json into each run dir).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const runsDir = path.join(HERE, "runs");
const scaffold = path.join(HERE, "scaffold");

function srcLoc(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.startsWith("hidden"));
  let n = 0;
  for (const f of files) n += fs.readFileSync(path.join(dir, f), "utf8").split("\n").length;
  return n;
}
function testCalls(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
  let n = 0;
  for (const f of files) {
    const s = fs.readFileSync(path.join(dir, f), "utf8");
    n += (s.match(/\b(it|test)\(/g) || []).length;
  }
  return n;
}
function parseJson(p) {
  try {
    const r = JSON.parse(fs.readFileSync(p, "utf8"));
    const tests = (r.testResults || []).flatMap((f) =>
      (f.assertionResults || []).map((a) => ({ t: a.title, s: a.status }))
    );
    const passed = tests.filter((x) => x.s === "passed").length;
    const failed = tests.filter((x) => x.s !== "passed").map((x) => x.t);
    return { passed, total: tests.length, failed };
  } catch {
    return null;
  }
}

const baseLoc = srcLoc(scaffold);
const runs = fs
  .readdirSync(runsDir)
  .filter((d) => {
    const full = path.join(runsDir, d);
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, "REPORT.md"));
  })
  .sort();

const rows = [];
for (const d of runs) {
  const full = path.join(runsDir, d);
  const hidden = parseJson(path.join(full, "hidden.json"));
  const own = parseJson(path.join(full, "own.json"));
  const rp = path.join(full, "REPORT.md");
  const words = fs.existsSync(rp) ? fs.readFileSync(rp, "utf8").split(/\s+/).filter(Boolean).length : 0;
  const L = srcLoc(full);
  rows.push({
    run: d,
    model: d.replace(/-\d+$/, ""),
    hidden,
    own,
    dloc: L - baseLoc,
    tests: testCalls(full),
    words,
  });
}

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

console.log("\n=== per run ===");
console.log(pad("run", 15), padL("hidden", 8), padL("own", 8), padL("dLOC", 7), padL("tests", 6), padL("report_w", 9));
for (const r of rows) {
  console.log(
    pad(r.run, 15),
    padL(r.hidden ? `${r.hidden.passed}/${r.hidden.total}` : "-", 8),
    padL(r.own ? `${r.own.passed}/${r.own.total}` : "-", 8),
    padL(r.dloc >= 0 ? "+" + r.dloc : r.dloc, 7),
    padL(r.tests, 6),
    padL(r.words, 9)
  );
}

console.log("\n=== per model: hidden pass (of 15) across runs ===");
const byModel = {};
for (const r of rows) (byModel[r.model] ||= []).push(r.hidden ? r.hidden.passed : null);
for (const m of Object.keys(byModel).sort()) {
  const v = byModel[m];
  const nums = v.filter((x) => x != null);
  const mean = nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1) : "-";
  console.log(pad(m, 15), JSON.stringify(v), "mean", mean);
}

console.log("\n=== hidden failures by run (which checks each model missed) ===");
for (const r of rows) {
  if (r.hidden && r.hidden.failed.length) {
    console.log(`${r.run}:`);
    for (const t of r.hidden.failed) console.log(`    ${t}`);
  } else if (r.hidden) {
    console.log(`${r.run}: (all ${r.hidden.total} passed)`);
  } else {
    console.log(`${r.run}: NO hidden.json (grade.sh not run or suite errored)`);
  }
}
