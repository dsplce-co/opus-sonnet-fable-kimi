# Model benchmark — production-hardening a stock-reservation module

A small, reproducible agentic-coding benchmark. We hand a coding model a tiny but real TypeScript
module that quietly mishandles stock, and ask it to get the module to a production-ready standard and
add two capabilities — the same brief we'd give a contractor taking over someone else's code. Then we
grade what comes back against a hidden test suite the model never sees.

Run date: **2026-09-18**. Companion write-up: [Opus 5 vs Sonnet 5 vs Fable 5.1 vs Kimi K3: who hardens real production code?](https://dsplce.co/lab/opus-sonnet-fable-kimi-real-code)

## The task

`scaffold/` is a stock-reservation module backed by an append-only movement log, with availability
*derived* from the log. It has an existing test suite (one test already failing) and several **unlabelled**
defects: a non-atomic multi-line `reserve`, a live internal array leaked from `getMovements`, no quantity
validation (NaN / fractional / negative), no SKU-lifecycle check, no retry idempotency, and floating-point
money in a discount. The prompt (`PROMPT.txt`) does **not** list the bugs — finding them is the job — and
asks the model to add `cancel(orderId)` and `history(sku, fromSeq, toSeq)`.

## How it's graded

`hidden/` holds two suites (15 checks total: 9 defect in `hidden.defects.test.ts`, 6 feature/edge in `hidden.feature.test.ts`). They assert **observable
end-state and invariants only** — never an exception type or mechanism — so any correct resolution
(validate-first, roll back, reject) passes equally, and defensible design divergences are not punished.
`reference/` is a worked solution that scores 15/15; a do-nothing baseline scores 2/15.

- `grade.sh [dir ...]` — copy the hidden suite into a finished run, run it, write `hidden.json` + `own.json`, remove it again. `bash grade.sh reference/` re-checks the 15/15 calibration point.
- `metrics.sh` — per-run size numbers (LOC delta, tests added, report length).
- `aggregate.mjs` / `report.sh` — grade every run and print the per-run table + per-model summary.

## Models

Opus 5 (`claude-opus-5`), Sonnet 5 (`claude-sonnet-5`), Sonnet 4.6 (`claude-sonnet-4-6`),
Sonnet 4.5 (`claude-sonnet-4-5`), Fable 5.1 (`claude-fable-5-1`), Kimi K3 (`kimi-k3`). Three runs each.

## Requirements

- Node.js with `npm` / `npx`
- `claude` — the Claude Code CLI, the harness for all six models (Kimi K3 included)
- Your normal Claude Code auth for the Claude models, and a Kimi Code key for Kimi K3 —
  `cp .env.example .env` and fill in `KIMI_CODE_KEY` (or export it)

## Reproduce

```bash
git clone https://github.com/dsplce-co/opus-sonnet-fable-kimi
cd opus-sonnet-fable-kimi
bash matrix.sh 3     # every model, 3 runs each, into runs/<model>-<n>/
bash report.sh       # grade everything and print the table
```

`bash report.sh` alone re-grades the 18 published runs without calling any model. The first script
you run installs vitest (4.1.10, the version the published runs used) into `scaffold/node_modules`
via `setup.sh`.

Each runner pins the model via env vars, copies the scaffold source, and **symlinks** `node_modules`
(so many runs don't each duplicate the install). Runs are unattended — permission prompts are
bypassed, so the agent executes shell commands in its run folder on its own. `runs/<model>-<n>/`
keeps the model's edited code, its `REPORT.md`, and a transcript. New runs are numbered after the
published ones (`opus-5-4`, …), and `report.sh` grades every folder in `runs/`, so move the published
runs aside first if you want a table of your runs only.

Runners use your normal Claude Code setup, so anything in your user-level config (a global
`CLAUDE.md`, plugins, MCP servers) reaches the model too. Keep it neutral for a clean comparison.

## The published runs

`runs/` holds all 18 runs from 2026-09-18 (`opus-5-*`, `sonnet-5-*`, `sonnet-4-6-*`, `sonnet-4-5-*`,
`fable-5-1-*`, `kimi-k3-*`, three each). Absolute local paths in the vitest output pasted into some
`REPORT.md` files were replaced with `<repo>/…`; nothing else was edited.

## A note on the hidden suite

We publish `hidden/` here so the benchmark is fully reproducible and auditable. That means it is now
**public** — a future model could be trained on it, and re-runners should treat the checks as visible
rather than held out. The point of this repo is the *method* (a real task, honest end-state grading,
raw evidence per run), not a defensible leaderboard. It is one task on one day; treat the numbers as a
dated snapshot, not a ranking.
