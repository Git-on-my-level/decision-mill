import test from "node:test";
import assert from "node:assert/strict";
import { computeResults, wilson, thresholdCurve, truthMap } from "../lib/results.js";
import { normalizeTask } from "../lib/task.js";
import { foldRows } from "../lib/labelstore.js";

const { task } = normalizeTask({
  labels: [{ id: "keep" }, { id: "noise" }, { id: "unsure" }],
  models: [
    { id: "ranker", score_path: "hidden.r.p", verdict_path: "hidden.r.v", threshold: 0.5, positive_label: "noise" },
    { id: "lite", verdict_path: "hidden.l.v" },
  ],
}, "t");
// 6 items: scores and verdicts chosen so the expected numbers are easy by hand.
const items = [
  { id: "a", stratum: "lo", hidden: { r: { p: 0.1, v: "keep" }, l: { v: "keep" } } },
  { id: "b", stratum: "lo", hidden: { r: { p: 0.2, v: "keep" }, l: { v: "noise" } } },
  { id: "c", stratum: "hi", hidden: { r: { p: 0.7, v: "noise" }, l: { v: "noise" } } },
  { id: "d", stratum: "hi", hidden: { r: { p: 0.9, v: "noise" }, l: { v: "noise" } } },
  { id: "e", stratum: "hi", hidden: { r: { p: 0.6, v: "noise" }, l: {} } },
  { id: "f", stratum: "lo", hidden: { r: { p: 0.3, v: "keep" }, l: { v: "keep" } } },
];
const lab = (rows) => ({ reviewers: Object.fromEntries(Object.entries(rows).map(([n, r]) => [n, { states: foldRows(r) }])) });
const h = (id, label, at = "2026-01-01") => ({ item_id: id, label, source: "human", at });
const s = (id, label) => ({ item_id: id, label, source: "model-standin", at: "2026-01-02" });

const labels = lab({
  me: [h("a", "keep"), h("b", "keep"), h("c", "noise"), h("d", "keep"), h("e", "unsure"), h("f", "noise"), h("f", null), h("f", "keep")],
  bot: [s("a", "keep"), s("b", "noise"), s("c", "noise"), s("d", "noise"), s("e", "noise"), s("f", "keep")],
});

test("agreement, confusion, unsure excluded", () => {
  const r = computeResults({ task, items, labels, reviewer: "me" });
  assert.equal(r.counts.humanLabeled, 6);
  assert.equal(r.counts.humanAbstained, 1);
  const ranker = r.models.find((m) => m.id === "ranker");
  // truth: a keep, b keep, c noise, d keep, f keep (e unsure). ranker: keep keep noise noise keep
  assert.equal(ranker.compared, 5);
  assert.equal(ranker.agree, 4);
  assert.deepEqual(ranker.confusion, { keep: { keep: 3, noise: 1 }, noise: { noise: 1 } });
  assert.deepEqual(ranker.disagreements.map((d) => d.item_id), ["d"]);
  assert.deepEqual(ranker.perStratum, { lo: { compared: 3, agree: 3 }, hi: { compared: 2, agree: 1 } });
  const lite = r.models.find((m) => m.id === "lite");
  assert.equal(lite.compared, 5);
  assert.equal(lite.agree, 3); // b and d wrong
  assert.equal(lite.missing, 0, "e has no lite verdict but e is unsure, so it never counts");
});

test("stand-ins are graded against human labels only", () => {
  const r = computeResults({ task, items, labels, reviewer: "me", fill: true });
  const bot = r.models.find((m) => m.id === "bot");
  assert.equal(bot.kind, "standin");
  assert.equal(bot.compared, 5);
  assert.equal(bot.agree, 3);
  assert.equal(bot.labeled, 6);
});

test("fill uses stand-in labels only where no human label exists", () => {
  const partial = lab({ me: [h("a", "noise")], bot: [s("a", "keep"), s("b", "noise")] });
  const t = truthMap({ task, labels: partial, reviewer: "me", fill: true });
  assert.equal(t.get("a").label, "noise", "human outranks stand-in");
  assert.equal(t.get("a").filled, false);
  assert.equal(t.get("b").label, "noise");
  assert.equal(t.get("b").filled, true);
  const r = computeResults({ task, items, labels: partial, reviewer: "me", fill: true });
  assert.equal(r.counts.humanLabeled, 1);
  assert.equal(r.counts.filled, 1);
});

test("threshold curve: bins, sweep, safest threshold", () => {
  const r = computeResults({ task, items, labels, reviewer: "me" });
  const cv = r.models.find((m) => m.id === "ranker").curve;
  assert.equal(cv.positive_label, "noise");
  assert.equal(cv.n, 5);
  assert.equal(cv.positives, 1);
  const bin7 = cv.bins.find((b) => b.lo <= 0.7 && 0.7 < b.hi);
  assert.equal(bin7.n, 1); assert.equal(bin7.positive, 1);
  const at = (th) => cv.sweep.find((x) => Math.abs(x.threshold - th) < 1e-9);
  assert.deepEqual({ ...at(0.5), current: undefined }, { threshold: 0.5, flagged: 2, tp: 1, fp: 1, fn: 0, tn: 3, agree: 4, rate: 0.8, current: undefined });
  assert.equal(at(0.5).current, true);
  // highest human "keep" score is d at 0.9, so only a threshold above 0.9 flags no keeps
  assert.ok(cv.safest.threshold > 0.9);
  assert.equal(cv.safest.fp, 0);
});

test("positive label inferred from verdicts when not set", () => {
  const { task: t2 } = normalizeTask({ labels: [{ id: "keep" }, { id: "noise" }], models: [{ id: "r", score_path: "hidden.r.p", verdict_path: "hidden.r.v", threshold: 0.5 }] }, "t");
  const r = computeResults({ task: t2, items, labels, reviewer: "me" });
  assert.equal(r.models[0].curve.positive_label, "noise");
});

test("wilson interval is sane at the edges", () => {
  assert.deepEqual(wilson(0, 0), [0, 1]);
  const [lo, hi] = wilson(10, 10);
  assert.ok(lo > 0.65 && hi === 1);
  const [a, b] = wilson(50, 100);
  assert.ok(Math.abs(a - 0.404) < 0.01 && Math.abs(b - 0.596) < 0.01);
});

test("usefulness reads one-sided and empty label sets", () => {
  const empty = computeResults({ task, items, labels: lab({}), reviewer: null });
  assert.equal(empty.usefulness.verdict, "empty");
  const same = lab({ me: ["a", "b", "c", "d", "f"].map((id) => h(id, "keep")) });
  assert.equal(computeResults({ task, items, labels: same, reviewer: "me" }).usefulness.verdict, "one-sided");
  const r = computeResults({ task, items, labels, reviewer: "me" });
  assert.match(r.usefulness.headline, /disagree with at least one model/);
});

test("thresholdCurve returns null without a positive label", () => {
  assert.equal(thresholdCurve({ score_path: "hidden.r.p" }, items, new Map(), null), null);
});
