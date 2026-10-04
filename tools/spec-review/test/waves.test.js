// Waves mode: selection, freezing, resume, held-out stand-in math, import, CLI,
// and the server's view of a waves task.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as yaml from "js-yaml";
import { normalizeTask } from "../lib/task.js";
import { buildRow, readTaskLabels } from "../lib/labelstore.js";
import { normalizeWaves, selectFirstWave, nextWave, readWaves, waveStatus, evaluateStandin, prepareStandinRows, validateWaves, writeWaveFile } from "../lib/waves.js";
import { computeResults } from "../lib/results.js";
import { buildBrief, parseStandinFile } from "../lib/brief.js";
import { tmpdir, copyExamples, startServer, TOOL } from "./helpers.js";

const TASK = {
  title: "t", labels: [{ id: "keep", key: "1" }, { id: "noise", key: "2" }, { id: "unsure", key: "3" }],
  models: [{ id: "m", score_path: "hidden.m.p", verdict_path: "hidden.m.v", threshold: 0.9, positive_label: "noise" }],
};
// 60 items over 4 strata; model m says noise for p >= 0.9.
function mkItems() {
  const strata = { a: 25, b: 20, c: 10, d: 5 };
  const items = [];
  for (const [s, n] of Object.entries(strata)) for (let i = 0; i < n; i++) {
    const p = +(i / n).toFixed(3);
    items.push({ id: `${s}${i}`, stratum: s, title: `${s} ${i}`, content: { type: "text", body: `body ${s}${i}` }, hidden: { m: { p, v: p >= 0.9 ? "noise" : "keep" } } });
  }
  return items;
}
function mkTaskDir(wavesCfg, extra = {}) {
  const dir = path.join(tmpdir("dm-waves-"), "wt");
  fs.mkdirSync(path.join(dir, "labels"), { recursive: true });
  fs.writeFileSync(path.join(dir, "task.yaml"), yaml.dump({ ...TASK, waves: wavesCfg, ...extra }));
  const items = mkItems();
  fs.writeFileSync(path.join(dir, "items.jsonl"), items.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const { task } = normalizeTask(yaml.load(fs.readFileSync(path.join(dir, "task.yaml"), "utf8")), "wt");
  return { dir, task, items };
}
const at = (n) => new Date(Date.UTC(2026, 9, 4, 10, 0, n)).toISOString();
function writeRows(dir, reviewer, rows) {
  fs.appendFileSync(path.join(dir, "labels", `${reviewer}.jsonl`), rows.map((r) => JSON.stringify({ reviewer, ...r })).join("\n") + "\n");
}
const humanLabel = (id, label, n) => ({ item_id: id, label, source: "human", at: at(n) });
const verdicts = (task) => (it) => task.models.map((m) => (it.hidden?.m?.v ?? null));

test("waves config: defaults, true, and bad values warn", () => {
  const e = [], w = [];
  const d = normalizeWaves(true, "tid", e, w);
  assert.equal(d.count, 3); assert.equal(d.size, 20); assert.equal(d.standin, "opus-standin");
  assert.equal(d.first.strategy, "stratified"); assert.equal(d.last, "random"); assert.equal(d.accept, 0.85); assert.equal(d.seed, "tid");
  assert.ok(Math.abs(d.middle.uncertain + d.middle.disagree + d.middle.coverage - 1) < 1e-9);
  assert.equal(normalizeWaves(null, "t", e, w), null);
  const bad = normalizeWaves({ count: 0, first: { strategy: "magic" }, last: "x" }, "t", e, w);
  assert.equal(bad.count, 3);
  assert.ok(w.length >= 3, w.join("; "));
  const { task } = normalizeTask({ ...TASK, waves: { size: 5 } }, "x");
  assert.equal(task.waves.size, 5);
  assert.equal(normalizeTask(TASK, "x").task.waves, null, "no waves key: rounds mode");
});

test("wave 1: quotas, weights, labeled items count toward it, deterministic", () => {
  const { task, items } = mkTaskDir({ size: 12, first: { quota: { d: 2 }, weights: { "a*": 2 } } });
  const labeledIds = new Set(["b3"]);
  const pick = () => selectFirstWave({ items, task, cfg: task.waves, labeledIds, inWave: new Set(), size: 12 });
  const w = pick();
  assert.equal(w.length, 12);
  assert.equal(new Set(w.map((x) => x.id)).size, 12);
  assert.ok(w.some((x) => x.id === "b3" && x.reason === "labeled"), "pre-existing human label is part of wave 1");
  const per = {};
  for (const x of w) per[x.id[0]] = (per[x.id[0]] || 0) + 1;
  assert.equal(per.d, 2, "exact quota");
  // remaining 10 by weight a:2 b:1 c:1 (b already has one label) → a 5, b 2+1, c 2... totals track weights
  assert.ok(per.a > per.b && per.a > per.c, JSON.stringify(per));
  assert.deepEqual(pick(), w, "same inputs, same wave");
  // spread across the score range within a stratum
  const aPs = w.filter((x) => x.id[0] === "a").map((x) => Number(x.id.slice(1)));
  assert.ok(Math.max(...aPs) - Math.min(...aPs) >= 10, `a picks spread: ${aPs}`);
});

test("next-wave: freezes exclusively, resumes from files, never re-asks labeled items", () => {
  const { dir, task, items } = mkTaskDir({ size: 10, count: 3 });
  writeRows(dir, "david", [humanLabel("a1", "keep", 1)]);
  let labels = readTaskLabels(dir);
  const r1 = nextWave({ dir, task, items, labels, reviewer: "david", opts: { modelVerdicts: verdicts(task) } });
  assert.ok(!r1.error, r1.error);
  assert.ok(fs.existsSync(path.join(dir, "waves", "wave-1.json")));
  assert.ok(r1.wave.items.some((x) => x.id === "a1"));
  // Wave 1 not finished: refuse.
  const early = nextWave({ dir, task, items, labels, reviewer: "david" });
  assert.match(early.error, /still has 9 unlabeled/);
  // The file is never rewritten.
  assert.throws(() => writeWaveFile(dir, { ...r1.wave, items: [] }), /EEXIST/);
  // Resume: what is on disk is what the server and CLI see.
  const { waves } = readWaves(dir);
  assert.deepEqual(waves[0].ids, r1.wave.items.map((x) => x.id));
  // Label wave 1, then the stand-in must exist before wave 2.
  writeRows(dir, "david", waves[0].ids.filter((id) => id !== "a1").map((id, i) => humanLabel(id, id.endsWith("0") ? "noise" : "keep", 10 + i)));
  labels = readTaskLabels(dir);
  assert.equal(waveStatus({ task, items, waves, labels, reviewer: "david" }).state, "inferring");
  assert.match(nextWave({ dir, task, items, labels, reviewer: "david" }).error, /have no 'opus-standin' label/);
  // Stale stand-in labels (older than the latest human label) are refused too.
  const unl = items.filter((it) => !waves[0].ids.includes(it.id));
  writeRows(dir, "opus-standin", unl.map((it, i) => ({ item_id: it.id, label: "keep", confidence: 0.9, source: "model-standin", at: at(1) })));
  labels = readTaskLabels(dir);
  assert.match(nextWave({ dir, task, items, labels, reviewer: "david" }).error, /predate/);
  // Fresh labels: wave 2 targets low confidence.
  writeRows(dir, "opus-standin", unl.map((it, i) => ({ item_id: it.id, label: it.hidden.m.v === "noise" ? "keep" : "keep", confidence: it.id.startsWith("c") ? 0.3 : 0.9, source: "model-standin", at: at(100 + i) })));
  labels = readTaskLabels(dir);
  const r2 = nextWave({ dir, task, items, labels, reviewer: "david", opts: { modelVerdicts: verdicts(task) } });
  assert.ok(!r2.error, r2.error);
  assert.equal(r2.wave.strategy, "targeted");
  const ids2 = r2.wave.items.map((x) => x.id);
  assert.equal(ids2.filter((id) => waves[0].ids.includes(id)).length, 0, "no item from wave 1");
  const uncertain = r2.wave.items.filter((x) => x.reason === "uncertain").map((x) => x.id);
  assert.ok(uncertain.length >= 5 && uncertain.every((id) => id.startsWith("c")), `uncertain picks are the 0.3s: ${uncertain}`);
  assert.ok(r2.wave.items.some((x) => x.reason === "disagree"), "stand-in keep vs model noise");
  assert.ok(r2.wave.items.every((x) => x.prediction && x.prediction.label), "predictions recorded at freeze time");
  assert.equal(r2.wave.committed_before_human_labels, true);
  // Wave 3 is the random hold-out and the last planned wave.
  const w2 = readWaves(dir).waves[1];
  writeRows(dir, "david", w2.ids.map((id, i) => humanLabel(id, "keep", 200 + i)));
  labels = readTaskLabels(dir);
  writeRows(dir, "opus-standin", items.filter((it) => !labels.reviewers.david.states.has(it.id)).map((it, i) => ({ item_id: it.id, label: "keep", confidence: 0.8, source: "model-standin", at: at(300 + i) })));
  labels = readTaskLabels(dir);
  const r3 = nextWave({ dir, task, items, labels, reviewer: "david", opts: { modelVerdicts: verdicts(task) } });
  assert.equal(r3.wave.strategy, "random");
  const all = readWaves(dir).waves.flatMap((w) => w.ids);
  assert.equal(new Set(all).size, all.length, "no item in two waves");
  writeRows(dir, "david", r3.wave.items.map((x, i) => humanLabel(x.id, "keep", 400 + i)));
  labels = readTaskLabels(dir);
  assert.match(nextWave({ dir, task, items, labels, reviewer: "david" }).error, /all 3 waves are frozen/);
  assert.equal(waveStatus({ task, items, waves: readWaves(dir).waves, labels, reviewer: "david" }).state, "done");
  assert.deepEqual(validateWaves(dir, task, items), { errors: [], warnings: [] });
});

test("held-out math: random waves are the estimate, targeted reported apart, abstains excluded", () => {
  const task = normalizeTask({ ...TASK, waves: { accept: 0.8 } }, "t").task;
  const P = (label, confidence) => ({ label, confidence });
  const waves = [
    { wave: 1, strategy: "stratified", items: [{ id: "x0", prediction: null }] },
    { wave: 2, strategy: "targeted", items: [{ id: "t1", prediction: P("keep", 0.4) }, { id: "t2", prediction: P("noise", 0.5) }, { id: "t3", prediction: P("unsure", 0.2) }] },
    { wave: 3, strategy: "random", items: [
      { id: "r1", prediction: P("keep", 0.9) }, { id: "r2", prediction: P("keep", 0.9) }, { id: "r3", prediction: P("noise", 0.7) },
      { id: "r4", prediction: P("noise", 0.95) }, { id: "r5", prediction: P("keep", 0.5) }, { id: "r6", prediction: P("keep", 0.9) }] },
  ];
  const human = new Map(Object.entries({ x0: "keep", t1: "noise", t2: "noise", t3: "keep", r1: "keep", r2: "keep", r3: "noise", r4: "keep", r5: "unsure" }).map(([k, v]) => [k, { label: v }]));
  const e = evaluateStandin({ task, waves, human });
  // random: r1 ok, r2 ok, r3 ok, r4 miss, r5 human unsure (excluded), r6 not labeled yet
  assert.equal(e.holdout.compared, 4); assert.equal(e.holdout.agree, 3); assert.equal(e.holdout.rate, 0.75);
  assert.equal(e.verdict, "rejected", "0.75 < 0.8 bar");
  assert.ok(e.holdout.ci[0] < 0.75 && e.holdout.ci[1] > 0.75);
  // targeted: t1 miss, t2 ok, t3 stand-in abstained
  assert.equal(e.targeted.compared, 2); assert.equal(e.targeted.agree, 1); assert.equal(e.targeted.abstained, 1);
  assert.equal(e.byWave.find((w) => w.n === 3).unlabeled, 1);
  // calibration: high (>=0.8): r1 r2 ok, r4 miss → 2/3; mid: r3 ok; low: t1 miss, t2 ok
  assert.deepEqual([e.calibration.high.agree, e.calibration.high.compared], [2, 3]);
  assert.deepEqual([e.calibration.mid.agree, e.calibration.mid.compared], [1, 1]);
  assert.deepEqual([e.calibration.low.agree, e.calibration.low.compared], [1, 2]);
  assert.deepEqual(e.misses.map((m) => m.item_id).sort(), ["r4", "t1"]);
  assert.deepEqual(e.holdout.predicted, { keep: 2, noise: 2 });
  assert.deepEqual(e.holdout.truth, { keep: 3, noise: 1 }, "leniency check: predicted vs human mix");
  assert.equal(evaluateStandin({ task, waves: waves.slice(0, 2), human }).verdict, "pending");
});

test("results: final labels combine human + stand-in; model agreement human-only vs combined", () => {
  const { dir, task, items } = mkTaskDir({ size: 5 });
  writeRows(dir, "david", [humanLabel("a24", "noise", 1), humanLabel("a0", "noise", 2)]); // model: a24 noise (p .96), a0 keep
  writeRows(dir, "opus-standin", items.filter((it) => !["a24", "a0"].includes(it.id)).map((it) => ({ item_id: it.id, label: it.hidden.m.v, confidence: 0.9, source: "model-standin", at: at(5) })));
  writeRows(dir, "other-standin", [{ item_id: "b1", label: "noise", source: "model-standin", at: at(9) }]);
  const labels = readTaskLabels(dir);
  const res = computeResults({ task, items, labels, reviewer: "david", waves: [] });
  const f = res.waves.final;
  assert.equal(f.human, 2); assert.equal(f.standin, 58); assert.equal(f.uncovered, 0);
  const m = f.models[0];
  assert.equal(m.humanOnly.compared, 2); assert.equal(m.humanOnly.agree, 1);
  assert.equal(m.combined.compared, 60); assert.equal(m.combined.agree, 59, "only the task's stand-in fills (other-standin ignored)");
});

test("import: all-or-nothing, skips labeled items, refuses the human's file", () => {
  const { dir, task, items } = mkTaskDir({ size: 5 });
  writeRows(dir, "david", [humanLabel("a1", "keep", 1)]);
  const labels = readTaskLabels(dir);
  const human = new Map([...labels.reviewers.david.states].filter(([, s]) => s.label));
  const ok = prepareStandinRows({ task, items, labels, human, buildRow, reviewer: "opus-standin", model: "opus",
    rows: [{ item_id: "a1", label: "noise" }, { item_id: "a2", label: "keep", confidence: 0.7, rationale: "r" }, { id: "a3", label: "noise" }] });
  assert.ok(!ok.error, ok.error);
  assert.equal(ok.rows.length, 2); assert.equal(ok.skipped, 1);
  assert.ok(ok.rows.every((r) => r.source === "model-standin" && r.reviewer === "opus-standin" && r.model === "opus"));
  assert.equal(ok.missing.length, items.length - 1 - 2);
  assert.match(prepareStandinRows({ task, items, labels, human, buildRow, reviewer: "s", rows: [{ item_id: "a2", label: "maybe" }] }).error, /unknown label/);
  assert.match(prepareStandinRows({ task, items, labels, human, buildRow, reviewer: "s", rows: [{ item_id: "a2", label: "keep", confidence: 3 }] }).error, /confidence/);
  assert.match(prepareStandinRows({ task, items, labels, human, buildRow, reviewer: "david", rows: [{ item_id: "a2", label: "keep" }] }).error, /holds human labels/);
  assert.deepEqual(parseStandinFile('[{"item_id":"a","label":"keep"}]').rows.length, 1);
  assert.deepEqual(parseStandinFile('{"labels":[{"item_id":"a","label":"keep"}]}').rows.length, 1);
  assert.deepEqual(parseStandinFile('```json\n{"item_id":"a","label":"keep"}\n{"item_id":"b","label":"noise"}\n```').rows.length, 2);
});

test("brief: the human's labels and notes, every unlabeled item, never model answers", () => {
  const { task, items } = mkTaskDir({ size: 5 });
  const human = new Map([["a1", { label: "keep", note: "has a plan", fields: {} }]]);
  const text = buildBrief({ task, items, human, standinName: "opus-standin", reviewer: "david", misses: [{ item_id: "b2", predicted: "keep", human: "noise", confidence: 0.9 }] });
  assert.match(text, /### → keep — note: "has a plan"/);
  assert.equal((text.match(/^### \?$/gm) || []).length, items.length - 1);
  assert.match(text, /b2: you said keep \(0.9\), they said noise/);
  assert.ok(!/hidden|"p":|stratum/.test(text), "no hidden fields or strata in the brief");
});

test("CLI: next-wave → import-standin → waves status, on a task copy", () => {
  const { dir } = mkTaskDir({ size: 6, count: 2 });
  const run = (...a) => spawnSync(process.execPath, ["labels.js", ...a], { cwd: TOOL, encoding: "utf8" });
  let r = run("next-wave", dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /froze wave 1 of 2 · stratified · 6 items/);
  const w1 = readWaves(dir).waves[0];
  writeRows(dir, "david", w1.ids.map((id, i) => humanLabel(id, "keep", i)));
  r = run("infer-prompt", dir, "--out", path.join(dir, "brief.md"));
  assert.equal(r.status, 0, r.stderr);
  const lines = mkItems().filter((it) => !w1.ids.includes(it.id)).map((it) => JSON.stringify({ item_id: it.id, label: "keep", confidence: 0.8, rationale: "x" }));
  fs.writeFileSync(path.join(dir, "standin.jsonl"), lines.join("\n"));
  r = run("import-standin", dir, path.join(dir, "standin.jsonl"), "--model", "test");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /appended 54 model-standin row\(s\) to labels\/opus-standin.jsonl/);
  r = run("next-wave", dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wave 2 of 2 · random/);
  r = run("waves", dir, "--json");
  const st = JSON.parse(r.stdout);
  assert.equal(st.status.state, "labeling"); assert.equal(st.status.current, 2);
  r = run("export", dir, "--final");
  const fin = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(fin.length, 60);
  assert.equal(fin.filter((x) => x.source === "human").length, 6);
  assert.equal(fin.filter((x) => x.source === "model-standin").length, 54);
});

test("HTTP: a waves task freezes wave 1 on open and serves waves as rounds", async () => {
  const root = copyExamples();
  const demo = path.join(root, "labels", "demo-task");
  const raw = yaml.load(fs.readFileSync(path.join(demo, "task.yaml"), "utf8"));
  fs.writeFileSync(path.join(demo, "task.yaml"), yaml.dump({ ...raw, waves: { count: 2, size: 4 } }));
  const srv = await startServer({ LABELS_ROOT: path.join(root, "labels"), SPECS_DIR: path.join(root, "specs"), REVIEWER: "rev" });
  try {
    let r = await srv.get("/api/task/demo-task");
    assert.equal(r.status, 200);
    assert.equal(r.body.rounds.length, 1);
    assert.equal(r.body.rounds[0].ids.length, 4);
    assert.equal(r.body.waves.state, "labeling");
    assert.equal(r.body.waves.count, 2);
    assert.ok(fs.existsSync(path.join(demo, "waves", "wave-1.json")));
    for (const id of r.body.rounds[0].ids) await srv.post("/api/task/demo-task/label", { item_id: id, label: "keep" });
    r = await srv.get("/api/task/demo-task");
    assert.equal(r.body.waves.state, "inferring");
    assert.equal(r.body.current, 1, "every frozen wave labeled");
    r = await srv.get("/api/task/demo-task/results");
    assert.equal(r.body.waves.final.human, 4);
    assert.equal(r.body.waves.status.state, "inferring");
    r = await srv.get("/api/tasks");
    assert.equal(r.body.tasks[0].waves.state, "inferring");
  } finally { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
