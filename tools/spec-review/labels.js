#!/usr/bin/env node
// labels.js — read label tasks straight from the files, no server needed.
//
//   node labels.js tasks [ROOT...]                     list tasks (default: LABELS_ROOT)
//   node labels.js stats  <task> [--reviewer R] [--fill] [--json]
//   node labels.js export <task> [--reviewer R] [--source human|model-standin] [--format jsonl|csv]
//
// <task> is a task directory, or a task id under LABELS_ROOT / --labels.
// `stats` prints the same agreement numbers as the Results view (lib/results.js).
// `export` prints each reviewer's latest label per item (append-only files folded,
// latest row wins), one row per reviewer×item.
// Writes are deliberately not offered here: model stand-in labels go through the
// server's serialized queue (POST /api/task/<id>/labels), see LABELS.md.

import fs from "node:fs";
import path from "node:path";
import { LABELS_ROOTS } from "./lib/config.js";
import { discoverTasks, loadTask, isTaskDir } from "./lib/task.js";
import { readTaskLabels, safeReviewer } from "./lib/labelstore.js";
import { computeResults } from "./lib/results.js";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1] ?? null; };
const has = (name) => argv.includes(name);
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && ["--reviewer", "--source", "--format", "--labels"].includes(arr[i - 1])));

function usage(code = 2) {
  console.error("usage: node labels.js tasks [ROOT...] | stats <task> [--reviewer R] [--fill] [--json] | export <task> [--reviewer R] [--source S] [--format jsonl|csv]");
  process.exit(code);
}

function resolveTask(ref) {
  if (!ref) usage();
  const asDir = path.resolve(ref);
  if (fs.existsSync(asDir) && isTaskDir(asDir)) return { id: path.basename(asDir), dir: asDir };
  const hit = discoverTasks(LABELS_ROOTS).find((t) => t.id === ref);
  if (!hit) { console.error(`no task '${ref}' (not a task directory, and not under ${LABELS_ROOTS.join(", ") || "any LABELS_ROOT"})`); process.exit(2); }
  return hit;
}

const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);

if (cmd === "tasks") {
  const roots = positional.length ? positional.map((p) => path.resolve(p)) : LABELS_ROOTS;
  for (const t of discoverTasks(roots)) {
    const { task, items, errors } = loadTask(t.dir, t.id);
    const labels = readTaskLabels(t.dir);
    const reviewers = Object.entries(labels.reviewers).map(([n, r]) => `${n}:${[...r.states.values()].filter((s) => s.label != null).length}`).join(" ");
    console.log(`${t.id}\t${items.length} items\t${errors.length ? `${errors.length} ERRORS\t` : ""}${task.title}${reviewers ? `\t[${reviewers}]` : ""}\t${t.dir}`);
  }
} else if (cmd === "stats") {
  const t = resolveTask(positional[0]);
  const { task, items, errors, warnings } = loadTask(t.dir, t.id);
  if (errors.length) { console.error(`task errors:\n  ${errors.join("\n  ")}`); process.exit(1); }
  const labels = readTaskLabels(t.dir);
  const reviewer = flag("--reviewer") ? safeReviewer(flag("--reviewer")) : null;
  const res = computeResults({ task, items, labels, reviewer, fill: has("--fill") });
  if (has("--json")) { console.log(JSON.stringify(res, null, 2)); process.exit(0); }
  const c = res.counts;
  console.log(`${task.title}  [${t.id}]`);
  console.log(`truth: ${reviewer ? `human labels by ${reviewer}` : "latest human label from any reviewer"}${res.fill ? " + stand-in fill" : ""}`);
  console.log(`labeled ${c.humanLabeled}/${c.items} (unsure ${c.humanAbstained}${c.filled ? `, filled ${c.filled}` : ""}) · rounds ${c.rounds.done}/${c.rounds.total} done`);
  console.log(`your labels: ${Object.entries(c.labelDist).map(([k, v]) => `${k} ${v}`).join(", ") || "—"}`);
  console.log(`\n${res.usefulness.headline}`);
  for (const l of res.usefulness.lines) console.log(`  · ${l}`);
  for (const m of res.models) {
    console.log(`\n${m.kind === "standin" ? "stand-in" : "model"} ${m.id}: ${pct(m.rate)} agree (n=${m.compared}, 95% ${pct(m.ci[0])}–${pct(m.ci[1])})${m.missing ? `, ${m.missing} without an answer` : ""}`);
    for (const [h, row] of Object.entries(m.confusion)) console.log(`    you ${h}: ${Object.entries(row).map(([v, n]) => `${v} ${n}`).join(", ")}`);
    const strata = Object.entries(m.perStratum);
    if (strata.length > 1) for (const [s, p] of strata) console.log(`    stratum ${s}: ${pct(p.agree / p.compared)} (n=${p.compared})`);
    if (m.curve) {
      const cv = m.curve;
      console.log(`    threshold curve (positive = ${cv.positive_label}, n=${cv.n}):`);
      for (const b of cv.bins) if (b.n) console.log(`      score ${b.lo.toFixed(2)}–${b.hi.toFixed(2)}: you said ${cv.positive_label} ${b.positive}/${b.n}`);
      for (const s of cv.sweep.filter((x) => x.current || (cv.safest && x.threshold === cv.safest.threshold))) {
        console.log(`      ${s.current ? "current" : "safest "} ${s.threshold}: flags ${s.flagged}, right ${s.tp}, wrong ${s.fp}, missed ${s.fn}, agreement ${pct(s.rate)}`);
      }
    }
  }
  if (warnings.length) console.log(`\n${warnings.length} task warning(s): node validate.js shows them`);
} else if (cmd === "export") {
  const t = resolveTask(positional[0]);
  const labels = readTaskLabels(t.dir);
  const wantR = flag("--reviewer") ? safeReviewer(flag("--reviewer")) : null;
  const wantS = flag("--source");
  const format = flag("--format") || "jsonl";
  const rows = [];
  for (const [name, r] of Object.entries(labels.reviewers)) {
    if (wantR && name !== wantR) continue;
    for (const s of r.states.values()) {
      if (s.label == null) continue;
      if (wantS && (s.source || "human") !== wantS) continue;
      rows.push({ item_id: s.item_id, reviewer: name, source: s.source || "human", label: s.label, fields: s.fields || {}, note: s.note || null, at: s.at || null,
        ...(s.confidence != null ? { confidence: s.confidence } : {}) });
    }
  }
  if (format === "csv") {
    const fieldIds = [...new Set(rows.flatMap((r) => Object.keys(r.fields)))].sort();
    const q = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    console.log(["item_id", "reviewer", "source", "label", ...fieldIds.map((f) => `field_${f}`), "note", "at"].join(","));
    for (const r of rows) console.log([r.item_id, r.reviewer, r.source, r.label, ...fieldIds.map((f) => r.fields[f]), r.note, r.at].map(q).join(","));
  } else {
    for (const r of rows) console.log(JSON.stringify(r));
  }
} else {
  usage(cmd ? 2 : 0);
}
