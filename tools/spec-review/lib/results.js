// Results math for label mode. Pure functions over (task, items, label states), so
// the server's Results view and the labels CLI print the same numbers.
//
// The question this answers first is the reviewer's: "is my labeling useful?" A
// label is useful when it can change a decision, which in practice means (a) it
// disagrees with some model, and (b) there are enough of them that each model's
// agreement rate is pinned down. So the headline is disagreements found plus the
// width of each model's confidence interval, not a raw count.

import { getPath, isAbstain } from "./task.js";
import { buildRounds, currentRound } from "./rounds.js";

const stratumOf = (it) => (it.stratum == null || it.stratum === "" ? "(none)" : String(it.stratum));

// Wilson score interval, 95%. Behaves at n small and p near 0/1, unlike p±1.96·se.
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

// Labels needed for a ±h interval at agreement p (normal approximation).
export const labelsFor = (p, h = 0.07) => Math.ceil((1.96 * 1.96 * Math.max(p * (1 - p), 0.05)) / (h * h));

// Ground truth per item. Human labels outrank everything: the selected reviewer's
// human label if they have one, else (when no reviewer is selected) the most recent
// human label from anyone. With `fill`, items no human labeled fall back to the
// most recent model-standin label and are marked filled.
export function truthMap({ task, labels, reviewer, fill = false }) {
  const abstainIds = new Set(task.labels.filter(isAbstain).map((l) => l.id));
  const humans = [], standins = [];
  for (const [name, r] of Object.entries(labels.reviewers || {})) {
    const entry = { name, states: r.states };
    // A file's rows can mix sources in principle; classify per state below.
    humans.push(entry); standins.push(entry);
  }
  const truth = new Map();
  const pickLatest = (entries, source, onlyName) => {
    const best = new Map();
    for (const { name, states } of entries) {
      if (onlyName && name !== onlyName) continue;
      for (const [id, s] of states) {
        if (s.label == null || (s.source || "human") !== source) continue;
        const prev = best.get(id);
        if (!prev || String(s.at || "") > String(prev.at || "")) best.set(id, { ...s, by: name });
      }
    }
    return best;
  };
  const reviewerHas = reviewer && labels.reviewers?.[reviewer];
  const human = pickLatest(humans, "human", reviewerHas ? reviewer : null);
  for (const [id, s] of human) truth.set(id, { label: s.label, abstain: abstainIds.has(s.label), filled: false, by: s.by, state: s });
  if (fill) {
    const standin = pickLatest(standins, "model-standin", null);
    for (const [id, s] of standin) {
      if (truth.has(id)) continue;
      truth.set(id, { label: s.label, abstain: abstainIds.has(s.label), filled: true, by: s.by, state: s });
    }
  }
  return truth;
}

function confusion() { return {}; }
function bump(m, a, b) { (m[a] ||= {}); m[a][b] = (m[a][b] || 0) + 1; }

// Which label a high score means. Explicit `positive_label` wins; otherwise, when
// the model also has a verdict and a threshold, infer it as the verdict the model
// most often gives at or above its own threshold.
export function positiveLabel(model, items) {
  if (model.positive_label != null) return String(model.positive_label);
  if (!model.score_path || model.threshold == null || !model.verdict_path) return null;
  const counts = {};
  for (const it of items) {
    const s = Number(getPath(it, model.score_path));
    const v = getPath(it, model.verdict_path);
    if (!Number.isFinite(s) || v == null || s < model.threshold) continue;
    counts[v] = (counts[v] || 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? String(best[0]) : null;
}

// A model's verdict on an item: verdict_path if present, else derived from
// score_path + threshold + positive/negative labels when those are all known.
export function modelVerdict(model, item, pos) {
  const v = getPath(item, model.verdict_path);
  if (v != null) return String(v);
  const s = Number(getPath(item, model.score_path));
  if (Number.isFinite(s) && model.threshold != null && pos) {
    if (s >= model.threshold) return pos;
    if (model.negative_label != null) return String(model.negative_label);
  }
  return null;
}

// Threshold curve for a scored model, over items with a non-abstain truth.
export function thresholdCurve(model, items, truth, pos) {
  const rows = [];
  for (const it of items) {
    const t = truth.get(it.id);
    if (!t || t.abstain) continue;
    const s = Number(getPath(it, model.score_path));
    if (!Number.isFinite(s)) continue;
    rows.push({ s, positive: t.label === pos, id: it.id });
  }
  if (!rows.length || !pos) return null;
  const min = Math.min(...rows.map((r) => r.s));
  const max = Math.max(...rows.map((r) => r.s));
  const unit = min >= 0 && max <= 1;
  const lo = unit ? 0 : min, hi = unit ? 1 : max;
  const nb = 10;
  const width = (hi - lo) / nb || 1;
  const bins = Array.from({ length: nb }, (_, i) => ({ lo: lo + i * width, hi: lo + (i + 1) * width, n: 0, positive: 0 }));
  for (const r of rows) {
    const b = Math.min(nb - 1, Math.max(0, Math.floor((r.s - lo) / width)));
    bins[b].n++; if (r.positive) bins[b].positive++;
  }
  for (const b of bins) b.rate = b.n ? b.positive / b.n : null;
  const cands = new Set();
  for (let i = 0; i <= 20; i++) cands.add(+(lo + ((hi - lo) * i) / 20).toFixed(4));
  if (model.threshold != null) cands.add(+Number(model.threshold).toFixed(4));
  for (const v of [0.9, 0.93, 0.95, 0.97, 0.99]) if (unit) cands.add(v);
  const totalPos = rows.filter((r) => r.positive).length;
  const sweep = [...cands].sort((a, b) => a - b).map((th) => {
    let tp = 0, fp = 0;
    for (const r of rows) if (r.s >= th) { if (r.positive) tp++; else fp++; }
    const fn = totalPos - tp;
    const tn = rows.length - totalPos - fp;
    return { threshold: th, flagged: tp + fp, tp, fp, fn, tn, agree: tp + tn, rate: (tp + tn) / rows.length, current: model.threshold != null && Math.abs(th - model.threshold) < 1e-9 };
  });
  // Safest threshold: the lowest one that flags no item the reviewer labeled
  // otherwise. Shown because "how much can we catch without losing anything you
  // care about" is the usual decision.
  const maxNeg = Math.max(-Infinity, ...rows.filter((r) => !r.positive).map((r) => r.s));
  const safest = sweep.find((r) => r.threshold > maxNeg) || null;
  return { positive_label: pos, n: rows.length, positives: totalPos, unit, bins, sweep, safest };
}

function compare(name, kind, items, truth, verdictOf, labelIds) {
  const res = { id: name, kind, compared: 0, agree: 0, missing: 0, confusion: confusion(), perStratum: {}, disagreements: [], humanOnly: { compared: 0, agree: 0 } };
  for (const it of items) {
    const t = truth.get(it.id);
    if (!t || t.abstain) continue;
    const v = verdictOf(it);
    if (v == null) { res.missing++; continue; }
    if (labelIds.abstain.has(v)) { res.abstained = (res.abstained || 0) + 1; continue; }
    res.compared++;
    const ok = v === t.label;
    if (ok) res.agree++;
    if (!t.filled) { res.humanOnly.compared++; if (ok) res.humanOnly.agree++; }
    bump(res.confusion, t.label, v);
    const s = stratumOf(it);
    const ps = (res.perStratum[s] ||= { compared: 0, agree: 0 });
    ps.compared++; if (ok) ps.agree++;
    if (!ok && !t.filled) res.disagreements.push({ item_id: it.id, title: it.title || null, truth: t.label, verdict: v, stratum: s });
  }
  res.rate = res.compared ? res.agree / res.compared : null;
  res.ci = wilson(res.agree, res.compared);
  return res;
}

export function computeResults({ task, items, labels, reviewer = null, fill = false }) {
  const truth = truthMap({ task, labels, reviewer, fill });
  const abstain = new Set(task.labels.filter(isAbstain).map((l) => l.id));
  const labelIds = { all: new Set(task.labels.map((l) => l.id)), abstain };
  const byId = new Map(items.map((it) => [it.id, it]));
  const human = [...truth.values()].filter((t) => !t.filled && byId.has(t.state.item_id));
  const counts = {
    items: items.length,
    humanLabeled: human.length,
    humanAbstained: human.filter((t) => t.abstain).length,
    filled: [...truth.values()].filter((t) => t.filled).length,
    labelDist: {},
  };
  for (const t of truth.values()) if (!t.filled) counts.labelDist[t.label] = (counts.labelDist[t.label] || 0) + 1;

  const humanIds = new Set(human.map((t) => t.state.item_id));
  const rounds = buildRounds(items, task);
  const cur = currentRound(rounds, humanIds);
  counts.rounds = { total: rounds.length, done: rounds.filter((r) => r.ids.every((id) => humanIds.has(id))).length, current: cur < rounds.length ? cur + 1 : null };

  const models = [];
  for (const m of task.models) {
    const pos = positiveLabel(m, items);
    const r = compare(m.id, "model", items, truth, (it) => modelVerdict(m, it, pos), labelIds);
    if (m.score_path) r.curve = thresholdCurve(m, items, truth, pos);
    if (m.score_path && !pos) r.curveNote = "set positive_label on this model to draw its threshold curve";
    r.threshold = m.threshold;
    models.push(r);
  }
  // Stand-ins are compared against human labels only — never against fill, which
  // would be a stand-in grading itself.
  const humanTruth = truthMap({ task, labels, reviewer, fill: false });
  for (const [name, rv] of Object.entries(labels.reviewers || {})) {
    const states = rv.states;
    const isStandin = [...states.values()].some((s) => s.label != null && s.source === "model-standin");
    if (!isStandin) continue;
    const r = compare(name, "standin", items, humanTruth, (it) => {
      const s = states.get(it.id);
      return s && s.label != null && s.source === "model-standin" ? s.label : null;
    }, labelIds);
    r.labeled = [...states.values()].filter((s) => s.label != null && s.source === "model-standin").length;
    models.push(r);
  }

  const strata = {};
  for (const it of items) {
    const s = stratumOf(it);
    const row = (strata[s] ||= { stratum: s, items: 0, labeled: 0, dist: {} });
    row.items++;
    const t = truth.get(it.id);
    if (t && !t.filled) { row.labeled++; row.dist[t.label] = (row.dist[t.label] || 0) + 1; }
  }

  return { task: task.id, reviewer, fill, counts, models, strata: Object.values(strata), usefulness: usefulness(counts, models, task) };
}

// Plain-language read of whether the labels so far can carry a decision.
export function usefulness(counts, models, task) {
  const lines = [];
  const n = counts.humanLabeled - counts.humanAbstained;
  if (!counts.humanLabeled) return { verdict: "empty", headline: "Nothing labeled yet — results appear after the first card.", lines };
  const disagreeIds = new Set();
  for (const m of models) for (const d of m.disagreements) disagreeIds.add(d.item_id);
  const dist = Object.entries(counts.labelDist).filter(([k]) => !task.labels.some((l) => l.id === k && isAbstain(l)));
  let verdict = "useful";
  let headline;
  if (dist.length === 1 && n >= 5) {
    verdict = "one-sided";
    headline = `All ${n} of your labels are '${dist[0][0]}'. Agreement cannot separate the models yet — label items from other strata.`;
  } else if (disagreeIds.size) {
    headline = `Yes — ${disagreeIds.size} of your ${n} labels ${disagreeIds.size === 1 ? "disagrees" : "disagree"} with at least one model. ${disagreeIds.size === 1 ? "That is the label" : "Those are the labels"} that move${disagreeIds.size === 1 ? "s" : ""} the decision.`;
  } else if (models.length) {
    headline = `Every model agrees with all ${n} of your labels so far. Useful as confirmation; add harder strata to find where they break.`;
  } else {
    headline = `${n} labels recorded. Add models to task.yaml to compare them.`;
  }
  for (const m of models) {
    if (!m.compared) continue;
    const half = (m.ci[1] - m.ci[0]) / 2;
    const pct = Math.round(m.rate * 100);
    const more = Math.max(0, labelsFor(m.rate) - m.compared);
    lines.push(`${m.id}: agrees ${pct}% (±${Math.round(half * 100)}pp, n=${m.compared})${half > 0.07 && more ? ` — about ${more} more labels for ±7pp` : " — tight enough to decide on"}`);
  }
  if (counts.humanAbstained) lines.push(`${counts.humanAbstained} marked unsure (left out of agreement; they are the cases worth a rubric line).`);
  if (n > 0 && n < 25) { lines.push("Small sample: treat rates as directional."); if (verdict === "useful") verdict = "directional"; }
  return { verdict, headline, lines, disagreements: disagreeIds.size };
}
