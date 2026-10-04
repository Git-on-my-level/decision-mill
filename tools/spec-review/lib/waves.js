// Waves: label fewer items by letting a model stand-in infer the rest.
//
// A task with `waves:` in task.yaml is labeled in a few small, frozen waves
// instead of fixed rounds over the whole pile:
//
//   wave 1        a stratified seed (covers every stratum; quotas/weights steer it)
//   waves 2..n-1  targeted: the items the stand-in is least sure about, where it
//                 disagrees with a model, and strata/score bins the human has not
//                 covered yet
//   wave n        a random hold-out: the honest estimate of stand-in accuracy
//
// Between waves an agent (not this tool — it holds no model key) reads the human's
// labels, writes stand-in labels for every unlabeled item (`labels.js infer-prompt`
// → `labels.js import-standin`), and freezes the next wave (`labels.js next-wave`).
//
// A frozen wave is a file, waves/wave-<n>.json, created exclusively and never
// rewritten. It records, for each of its items, the stand-in's prediction at
// freeze time — before the human has seen the item — so agreement on later waves
// is a held-out measurement, not the stand-in grading itself after a refit.

import fs from "node:fs";
import path from "node:path";
import { getPath, isAbstain } from "./task.js";
import { hash32, orderItems } from "./rounds.js";
import { wilson } from "./stats.js";
import { safeReviewer } from "./labelstore.js";

export const WAVE_STRATEGIES = new Set(["stratified", "proportional", "random"]);
const stratumOf = (it) => (it.stratum == null || it.stratum === "" ? "(none)" : String(it.stratum));

// ---------- config ----------

// Normalize task.yaml `waves:` (null when the task uses rounds).
export function normalizeWaves(raw, taskId, errors, warnings) {
  if (raw == null || raw === false) return null;
  const w = raw === true ? {} : raw;
  if (typeof w !== "object" || Array.isArray(w)) { errors.push("waves must be a mapping (or true for defaults)"); return null; }
  const posInt = (v, d, name) => {
    if (v == null) return d;
    if (Number.isInteger(v) && v > 0) return v;
    warnings.push(`waves.${name} must be a positive integer (using ${d})`);
    return d;
  };
  const first = w.first && typeof w.first === "object" ? w.first : { strategy: w.first };
  const strategy = first.strategy == null ? "stratified" : String(first.strategy);
  if (!WAVE_STRATEGIES.has(strategy)) warnings.push(`waves.first.strategy '${strategy}' unknown (want stratified|proportional|random)`);
  const numMap = (m, name) => {
    const out = {};
    if (m == null) return out;
    if (typeof m !== "object" || Array.isArray(m)) { warnings.push(`waves.first.${name} must be a mapping of stratum (or glob) to number`); return out; }
    for (const [k, v] of Object.entries(m)) {
      if (Number.isFinite(Number(v)) && Number(v) >= 0) out[k] = Number(v);
      else warnings.push(`waves.first.${name}.${k} must be a non-negative number`);
    }
    return out;
  };
  const mid = w.middle && typeof w.middle === "object" ? w.middle : {};
  let mix = { uncertain: num(mid.uncertain, 0.6), disagree: num(mid.disagree, 0.2), coverage: num(mid.coverage, 0.2) };
  const total = mix.uncertain + mix.disagree + mix.coverage;
  if (total <= 0) { warnings.push("waves.middle fractions sum to 0 (using defaults)"); mix = { uncertain: 0.6, disagree: 0.2, coverage: 0.2 }; }
  else mix = { uncertain: mix.uncertain / total, disagree: mix.disagree / total, coverage: mix.coverage / total };
  const last = w.last == null ? "random" : String(w.last);
  if (last !== "random" && last !== "targeted") warnings.push(`waves.last '${last}' unknown (want random|targeted)`);
  const accept = w.accept == null ? 0.85 : Number(w.accept);
  if (!(accept > 0 && accept <= 1)) warnings.push("waves.accept must be a fraction in (0, 1]");
  return {
    count: posInt(w.count, 3, "count"),
    size: posInt(w.size, 20, "size"),
    standin: safeReviewer(w.standin || "opus-standin"),
    reviewer: w.reviewer ? safeReviewer(w.reviewer) : null,
    accept: accept > 0 && accept <= 1 ? accept : 0.85,
    seed: w.seed != null ? String(w.seed) : taskId,
    first: { strategy: WAVE_STRATEGIES.has(strategy) ? strategy : "stratified", quota: numMap(first.quota, "quota"), weights: numMap(first.weights, "weights") },
    middle: mix,
    last: last === "targeted" ? "targeted" : "random",
    group_by: w.group_by ? String(w.group_by) : null,
  };
}
function num(v, d) { return v == null || !Number.isFinite(Number(v)) || Number(v) < 0 ? d : Number(v); }

// `nano_discard_*` style globs; everything else is an exact stratum name.
function globMatch(pattern, s) {
  if (!pattern.includes("*")) return pattern === s;
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(s);
}
function lookup(map, s) {
  if (Object.prototype.hasOwnProperty.call(map, s)) return map[s];
  for (const [k, v] of Object.entries(map)) if (globMatch(k, s)) return v;
  return undefined;
}

// ---------- files ----------

export const wavesDir = (taskDir) => path.join(taskDir, "waves");
export const waveFile = (taskDir, n) => path.join(wavesDir(taskDir), `wave-${n}.json`);

// Frozen waves in order. Bad files are reported, never fatal.
export function readWaves(taskDir) {
  const dir = wavesDir(taskDir);
  const waves = [];
  const errors = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { waves, errors }; }
  for (const f of names) {
    const m = /^wave-(\d+)\.json$/.exec(f);
    if (!m) continue;
    try {
      const w = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (!w || !Array.isArray(w.items)) throw new Error("no items list");
      w.wave = Number(m[1]);
      w.ids = w.items.map((x) => String(x.id));
      waves.push(w);
    } catch (e) { errors.push(`waves/${f}: ${e.message}`); }
  }
  waves.sort((a, b) => a.wave - b.wave);
  for (let i = 0; i < waves.length; i++) if (waves[i].wave !== i + 1) { errors.push(`waves/: wave-${i + 1}.json is missing (found wave-${waves[i].wave}.json)`); break; }
  return { waves, errors };
}

// Exclusive create: a wave that exists is never replaced. Write a temp file, then
// hard-link it into place (link fails if the target exists), so a reader never
// sees a half-written wave and two freezers cannot both win.
export function writeWaveFile(taskDir, wave) {
  fs.mkdirSync(wavesDir(taskDir), { recursive: true });
  const target = waveFile(taskDir, wave.wave);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(wave, null, 2) + "\n");
  try { fs.linkSync(tmp, target); }
  finally { try { fs.unlinkSync(tmp); } catch { /* already gone */ } }
  return target;
}

// ---------- whose labels ----------

// The human the waves are for: waves.reviewer, else the given reviewer when they
// have labels, else the human reviewer with the most human labels.
export function waveReviewer(cfg, labels, reviewer) {
  if (cfg?.reviewer) return cfg.reviewer;
  const r = reviewer ? safeReviewer(reviewer) : null;
  const humanCount = (rv) => [...rv.states.values()].filter((s) => s.label != null && (s.source || "human") === "human").length;
  if (r && labels.reviewers[r] && humanCount(labels.reviewers[r])) return r;
  let best = null, bestN = 0;
  for (const [name, rv] of Object.entries(labels.reviewers || {})) {
    const n = humanCount(rv);
    if (n > bestN) { best = name; bestN = n; }
  }
  return best || r;
}

export function humanStatesOf(labels, reviewer) {
  const out = new Map();
  const rv = reviewer ? labels.reviewers?.[reviewer] : null;
  if (!rv) return out;
  for (const [id, s] of rv.states) if (s.label != null && (s.source || "human") === "human") out.set(id, s);
  return out;
}

export function standinStatesOf(labels, standin) {
  const out = new Map();
  const rv = labels.reviewers?.[standin];
  if (!rv) return out;
  for (const [id, s] of rv.states) if (s.label != null && s.source === "model-standin") out.set(id, s);
  return out;
}

// ---------- selection ----------

const hashOrder = (list, seed) => [...list].sort((a, b) => hash32(`${seed}|${a.id}`) - hash32(`${seed}|${b.id}`) || (a.id < b.id ? -1 : 1));
const scoredModel = (task) => (task.models || []).find((m) => m.score_path);

// k items from a stratum, spread over the first scored model's range (evenly
// spaced quantiles), so a stratum's picks are not all from one end.
function spreadPick(list, k, task, seed) {
  if (k <= 0) return [];
  const m = scoredModel(task);
  const base = hashOrder(list, seed);
  if (!m || k >= base.length) return base.slice(0, k);
  const scored = base.map((it) => ({ it, s: Number(getPath(it, m.score_path)) }));
  if (scored.some((x) => !Number.isFinite(x.s))) return base.slice(0, k);
  scored.sort((a, b) => a.s - b.s);
  const out = [];
  const used = new Set();
  for (let i = 0; i < k; i++) {
    let j = Math.min(scored.length - 1, Math.floor(((i + 0.5) * scored.length) / k));
    while (used.has(j)) j = (j + 1) % scored.length;
    used.add(j);
    out.push(scored[j].it);
  }
  return out;
}

// Wave 1. Human labels made before the wave existed count toward it (and toward
// their stratum's share) so nothing is ever asked twice.
export function selectFirstWave({ items, task, cfg, labeledIds, inWave, size }) {
  const picks = [];
  for (const it of items) if (labeledIds.has(it.id) && !inWave.has(it.id)) picks.push({ it, reason: "labeled" });
  let slots = size - picks.length;
  const pool = items.filter((it) => !labeledIds.has(it.id) && !inWave.has(it.id));
  const seed = `${cfg.seed}|wave1`;
  if (slots > 0 && cfg.first.strategy === "random") {
    for (const it of groupLimited(hashOrder(pool, seed), cfg.group_by).slice(0, slots)) picks.push({ it, reason: "random" });
  } else if (slots > 0 && cfg.first.strategy === "proportional") {
    for (const it of orderItems(pool, { seed, stratify: "proportional" }).slice(0, slots)) picks.push({ it, reason: "proportional" });
  } else if (slots > 0) {
    const have = {}, avail = {};
    for (const p of picks) have[stratumOf(p.it)] = (have[stratumOf(p.it)] || 0) + 1;
    for (const it of pool) (avail[stratumOf(it)] ||= []).push(it);
    const strata = Object.keys(avail).sort();
    const add = Object.fromEntries(strata.map((s) => [s, 0]));
    // Exact quotas first (counting labels already given in that stratum).
    for (const s of strata) {
      const q = lookup(cfg.first.quota, s);
      if (q == null) continue;
      const n = Math.max(0, Math.min(avail[s].length, Math.round(q) - (have[s] || 0), slots));
      add[s] = n; slots -= n;
    }
    // Then weights, D'Hondt-style over strata without a quota, so each stratum's
    // total (labels already given + new picks) tracks its weight.
    const free = strata.filter((s) => lookup(cfg.first.quota, s) == null);
    const wt = (s) => { const v = lookup(cfg.first.weights, s); return v == null ? 1 : v; };
    while (slots > 0) {
      let best = null, bestV = -1;
      for (const s of free) {
        if (add[s] >= avail[s].length || wt(s) <= 0) continue;
        const v = wt(s) / ((have[s] || 0) + add[s] + 1);
        if (v > bestV + 1e-12) { best = s; bestV = v; }
      }
      // Everything without a quota is exhausted: top up quota strata.
      if (best == null) best = strata.find((s) => add[s] < avail[s].length) || null;
      if (best == null) break;
      add[best]++; slots--;
    }
    for (const s of strata) for (const it of spreadPick(avail[s], add[s], task, `${seed}|${s}`)) picks.push({ it, reason: "stratified" });
  }
  // Present the wave interleaved across strata.
  const order = orderItems(picks.map((p) => p.it), { seed, stratify: "balanced" }).map((it) => it.id);
  const reason = new Map(picks.map((p) => [p.it.id, p.reason]));
  return order.map((id) => ({ id, reason: reason.get(id) }));
}

function groupLimited(list, groupBy) {
  if (!groupBy) return list;
  const seen = new Set();
  return list.filter((it) => {
    const g = getPath(it, groupBy);
    if (g == null || g === "") return true;
    const k = String(g);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// The stand-in's confidence in its own label; an "unsure" stand-in label or a
// missing prediction counts as no confidence at all.
function confOf(pred, abstainIds) {
  if (!pred) return -1;
  if (abstainIds.has(pred.label)) return 0;
  const c = Number(pred.confidence);
  return Number.isFinite(c) ? c : 0.5;
}

function scoreBin(it, task) {
  const m = scoredModel(task);
  if (!m) return "";
  const s = Number(getPath(it, m.score_path));
  if (!Number.isFinite(s)) return "";
  return `b${Math.min(4, Math.max(0, Math.floor(s * 5)))}`;
}

// Waves 2..n-1: where another human label teaches the stand-in the most.
export function selectTargetedWave({ items, task, cfg, labeledIds, inWave, standin, modelVerdicts, size, waveNo }) {
  const abstainIds = new Set(task.labels.filter(isAbstain).map((l) => l.id));
  const seed = `${cfg.seed}|wave${waveNo}`;
  const pool = hashOrder(items.filter((it) => !labeledIds.has(it.id) && !inWave.has(it.id)), seed);
  const conf = (it) => confOf(standin.get(it.id), abstainIds);
  const uncertain = [...pool].sort((a, b) => conf(a) - conf(b));
  const disagreeN = (it) => {
    const p = standin.get(it.id);
    if (!p || abstainIds.has(p.label)) return 0;
    return modelVerdicts(it).filter((v) => v != null && !abstainIds.has(v) && v !== p.label).length;
  };
  const disagree = pool.filter((it) => disagreeN(it) > 0).sort((a, b) => disagreeN(b) - disagreeN(a) || conf(a) - conf(b));
  const nU = Math.round(size * cfg.middle.uncertain);
  const nD = Math.round(size * cfg.middle.disagree);
  const nC = Math.max(0, size - nU - nD);
  const chosen = new Map();
  const take = (list, n, reason) => {
    let got = 0;
    for (const it of list) {
      if (got >= n || chosen.size >= size) break;
      if (chosen.has(it.id)) continue;
      chosen.set(it.id, { it, reason }); got++;
    }
    return n - got;
  };
  let carry = take(uncertain, nU, "uncertain");
  carry = take(disagree, nD + carry, "disagree");
  // Coverage: the stratum × score-bin cell with the smallest human share next.
  const cellOf = (it) => `${stratumOf(it)}|${scoreBin(it, task)}`;
  const cellSize = {}, cellHuman = {};
  for (const it of items) {
    const c = cellOf(it);
    cellSize[c] = (cellSize[c] || 0) + 1;
    if (labeledIds.has(it.id) || inWave.has(it.id)) cellHuman[c] = (cellHuman[c] || 0) + 1;
  }
  for (const { it } of chosen.values()) cellHuman[cellOf(it)] = (cellHuman[cellOf(it)] || 0) + 1;
  let want = nC + carry;
  while (want > 0 && chosen.size < size) {
    const open = uncertain.filter((it) => !chosen.has(it.id));
    if (!open.length) break;
    let best = null, bestShare = Infinity;
    for (const it of open) {
      const c = cellOf(it);
      const share = (cellHuman[c] || 0) / cellSize[c];
      if (share < bestShare - 1e-12) { best = it; bestShare = share; }
    }
    chosen.set(best.id, { it: best, reason: "coverage" });
    cellHuman[cellOf(best)] = (cellHuman[cellOf(best)] || 0) + 1;
    want--;
  }
  take(uncertain, size - chosen.size, "uncertain");
  return [...chosen.values()].map(({ it, reason }) => ({ id: it.id, reason }));
}

// The last wave: a uniform random sample of what the stand-in labeled, so its
// agreement estimates the stand-in's accuracy on the items it fills.
export function selectRandomWave({ items, cfg, labeledIds, inWave, size, waveNo }) {
  const pool = items.filter((it) => !labeledIds.has(it.id) && !inWave.has(it.id));
  return groupLimited(hashOrder(pool, `${cfg.seed}|wave${waveNo}`), cfg.group_by).slice(0, size).map((it) => ({ id: it.id, reason: "random" }));
}

// ---------- status ----------

// Where the waves stand for one human:
//   unfrozen   no wave yet (the server freezes wave 1 on first open)
//   labeling   a frozen wave has an item the human has not labeled
//   inferring  every frozen wave is labeled, more are planned: the agent's turn
//   done       every planned wave is frozen and labeled
export function waveStatus({ task, items, waves, labels, reviewer }) {
  const cfg = task.waves;
  const who = waveReviewer(cfg, labels, reviewer);
  const human = humanStatesOf(labels, who);
  const standin = standinStatesOf(labels, cfg.standin);
  const inWave = new Set(waves.flatMap((w) => w.ids));
  const current = waves.findIndex((w) => w.ids.some((id) => !human.has(id)));
  let lastHumanAt = "";
  for (const s of human.values()) if (String(s.at || "") > lastHumanAt) lastHumanAt = String(s.at || "");
  const candidates = items.filter((it) => !human.has(it.id) && !inWave.has(it.id));
  const covered = candidates.filter((it) => standin.has(it.id)).length;
  const fresh = candidates.filter((it) => standin.has(it.id) && String(standin.get(it.id).at || "") >= lastHumanAt).length;
  let state;
  if (current !== -1) state = "labeling";
  else if (!waves.length) state = "unfrozen";
  else if (waves.length >= cfg.count) state = "done";
  else state = "inferring";
  const next = waves.length + 1;
  return {
    reviewer: who, standin: cfg.standin, count: cfg.count, size: cfg.size, frozen: waves.length,
    current: current === -1 ? null : current + 1, state,
    labeled: human.size, items: items.length,
    candidates: candidates.length, covered, fresh, lastHumanAt: lastHumanAt || null,
    nextStrategy: waves.length >= cfg.count ? null : next === 1 ? cfg.first.strategy : next === cfg.count && cfg.last === "random" ? "random" : "targeted",
    waves: waves.map((w) => ({ n: w.wave, size: w.ids.length, labeled: w.ids.filter((id) => human.has(id)).length, strategy: w.strategy, frozen_at: w.frozen_at })),
  };
}

// ---------- freezing ----------

// Select and freeze the next wave. Returns { wave, file } or { error }.
// opts: { extra, early, allowMissing, allowStale, dryRun, now, modelVerdicts }
export function nextWave({ dir, task, items, labels, reviewer, opts = {} }) {
  const cfg = task.waves;
  if (!cfg) return { error: "this task has no `waves:` in task.yaml" };
  const { waves, errors } = readWaves(dir);
  if (errors.length) return { error: errors.join("; ") };
  const n = waves.length + 1;
  if (n > cfg.count && !opts.extra) return { error: `all ${cfg.count} waves are frozen; pass --extra to add another (random) wave, e.g. after the hold-out missed the bar` };
  const who = waveReviewer(cfg, labels, reviewer);
  const human = humanStatesOf(labels, who);
  const prev = waves[waves.length - 1];
  if (prev && !opts.early) {
    const open = prev.ids.filter((id) => !human.has(id)).length;
    if (open) return { error: `wave ${prev.wave} still has ${open} unlabeled item(s) for ${who || "the reviewer"}; pass --early to freeze anyway` };
  }
  const inWave = new Set(waves.flatMap((w) => w.ids));
  const labeledIds = new Set(human.keys());
  const standin = standinStatesOf(labels, cfg.standin);
  const strategy = n === 1 ? cfg.first.strategy : (n >= cfg.count && cfg.last === "random") || n > cfg.count ? "random" : "targeted";
  if (n > 1) {
    const candidates = items.filter((it) => !labeledIds.has(it.id) && !inWave.has(it.id));
    if (!candidates.length) return { error: "no unlabeled items left outside the frozen waves" };
    const missing = candidates.filter((it) => !standin.has(it.id)).length;
    let lastHumanAt = "";
    for (const s of human.values()) if (String(s.at || "") > lastHumanAt) lastHumanAt = String(s.at || "");
    const stale = candidates.filter((it) => standin.has(it.id) && String(standin.get(it.id).at || "") < lastHumanAt).length;
    if (missing && !opts.allowMissing) return { error: `${missing} of ${candidates.length} unlabeled item(s) have no '${cfg.standin}' label yet — run infer-prompt / import-standin first (or pass --allow-missing)` };
    if (stale && !opts.allowStale) return { error: `${stale} '${cfg.standin}' label(s) predate the human's latest label — re-infer from the new labels first (or pass --allow-stale)` };
  }
  const size = cfg.size;
  const modelVerdicts = opts.modelVerdicts || (() => []);
  let picks;
  if (n === 1) picks = selectFirstWave({ items, task, cfg, labeledIds, inWave, size });
  else if (strategy === "random") picks = selectRandomWave({ items, cfg, labeledIds, inWave, size, waveNo: n });
  else picks = selectTargetedWave({ items, task, cfg, labeledIds, inWave, standin, modelVerdicts, size, waveNo: n });
  if (!picks.length) return { error: "nothing to select" };
  const now = opts.now || new Date();
  const wave = {
    wave: n, of: cfg.count, strategy, size, reviewer: who, standin: cfg.standin, frozen_at: now.toISOString(),
    // Each prediction below was the stand-in's latest label when the wave froze;
    // the human had not labeled these items yet (labeled ones are marked).
    committed_before_human_labels: true,
    items: picks.map(({ id, reason }) => {
      const p = standin.get(id);
      return { id, reason, prediction: p && !labeledIds.has(id) ? { label: p.label, confidence: p.confidence ?? null, at: p.at || null } : null };
    }),
  };
  if (opts.dryRun) return { wave, file: null };
  try { return { wave, file: writeWaveFile(dir, wave) }; }
  catch (e) { return { error: e.code === "EEXIST" ? `wave ${n} was frozen by someone else just now` : e.message }; }
}

// ---------- evaluation ----------

// Stand-in accuracy on predictions recorded before the human labeled the item.
// Random waves are the hold-out estimate; targeted waves are reported apart
// because they were picked for being hard (a pessimistic, biased estimate).
export function evaluateStandin({ task, waves, human }) {
  const abstainIds = new Set(task.labels.filter(isAbstain).map((l) => l.id));
  const blank = () => ({ compared: 0, agree: 0, abstained: 0, unlabeled: 0, predicted: {}, truth: {} });
  const byWave = [];
  const pools = { random: blank(), targeted: blank() };
  const conf = { high: blank(), mid: blank(), low: blank() };
  const misses = [];
  for (const w of waves) {
    const row = { n: w.wave, strategy: w.strategy, ...blank() };
    for (const x of w.items) {
      if (!x.prediction) continue;
      const h = human.get(x.id);
      const pool = w.strategy === "random" ? pools.random : w.strategy === "targeted" ? pools.targeted : null;
      if (!h) { row.unlabeled++; continue; }
      if (abstainIds.has(h.label)) continue;
      const tally = (t) => {
        if (abstainIds.has(x.prediction.label)) { t.abstained++; return; }
        t.compared++;
        if (x.prediction.label === h.label) t.agree++;
        t.predicted[x.prediction.label] = (t.predicted[x.prediction.label] || 0) + 1;
        t.truth[h.label] = (t.truth[h.label] || 0) + 1;
      };
      tally(row);
      if (pool) tally(pool);
      const c = Number(x.prediction.confidence);
      tally(!Number.isFinite(c) ? conf.mid : c >= 0.8 ? conf.high : c >= 0.6 ? conf.mid : conf.low);
      if (!abstainIds.has(x.prediction.label) && x.prediction.label !== h.label) misses.push({ item_id: x.id, wave: w.wave, predicted: x.prediction.label, confidence: x.prediction.confidence ?? null, human: h.label });
    }
    if (row.compared || row.abstained || row.unlabeled) byWave.push(row);
  }
  const fin = (t) => ({ ...t, rate: t.compared ? t.agree / t.compared : null, ci: wilson(t.agree, t.compared) });
  const holdout = fin(pools.random);
  const accept = task.waves?.accept ?? 0.85;
  let verdict = "pending";
  if (holdout.compared) verdict = holdout.rate >= accept ? "accepted" : "rejected";
  return {
    accept, verdict, holdout, targeted: fin(pools.targeted), byWave: byWave.map(fin),
    calibration: { high: fin(conf.high), mid: fin(conf.mid), low: fin(conf.low) },
    misses,
  };
}

// ---------- stand-in import ----------

// Validate a stand-in file's rows for `labels.js import-standin`. All-or-nothing:
// any invalid row returns { error } and nothing is written. Rows for items the
// human already labeled are skipped (an in-sample guess teaches nothing) unless
// includeLabeled. Refuses to write into a file that holds human rows.
export function prepareStandinRows({ task, items, labels, rows, reviewer, model, includeLabeled = false, human, buildRow, now = new Date() }) {
  const name = safeReviewer(reviewer);
  const existing = labels.reviewers?.[name];
  if (existing && [...existing.states.values()].some((s) => (s.source || "human") === "human" && s.label != null)) {
    return { error: `labels/${name}.jsonl holds human labels — pick another stand-in name` };
  }
  const ids = new Set(items.map((it) => it.id));
  const out = [];
  const seen = new Set();
  let skipped = 0, dupes = 0;
  for (const [i, input] of rows.entries()) {
    if (input && typeof input === "object" && !input.item_id && input.id) input.item_id = input.id;
    if (input && typeof input === "object") delete input.id;
    if (input && human.has(input.item_id) && !includeLabeled) { skipped++; continue; }
    if (input && seen.has(input.item_id)) dupes++;
    const built = buildRow({ ...input, ...(model && input && input.model == null ? { model } : {}) }, { task, itemIds: ids, reviewer: name, source: "model-standin", now });
    if (built.error) return { error: `row ${i + 1}: ${built.error}` };
    if (built.row.label == null) return { error: `row ${i + 1}: a stand-in row needs a label` };
    const c = built.row.confidence;
    if (c != null && !(c >= 0 && c <= 1)) return { error: `row ${i + 1}: confidence must be between 0 and 1` };
    seen.add(built.row.item_id);
    out.push(built.row);
  }
  const unlabeled = items.filter((it) => !human.has(it.id));
  const missing = unlabeled.filter((it) => !seen.has(it.id)).map((it) => it.id);
  return { rows: out, skipped, dupes, missing, reviewer: name };
}

// ---------- validation ----------

export function validateWaves(taskDir, task, items) {
  const errors = [], warnings = [];
  const { waves, errors: readErrors } = readWaves(taskDir);
  errors.push(...readErrors);
  if (!task.waves) {
    if (waves.length) warnings.push("waves/ has frozen waves but task.yaml has no `waves:` — they are ignored (the task uses rounds)");
    return { errors, warnings };
  }
  const ids = new Set(items.map((it) => it.id));
  const owner = new Map();
  for (const w of waves) {
    for (const id of w.ids) {
      if (!ids.has(id)) warnings.push(`waves/wave-${w.wave}.json: unknown item '${id}' (skipped)`);
      if (owner.has(id)) errors.push(`item '${id}' is in wave ${owner.get(id)} and wave ${w.wave}`);
      else owner.set(id, w.wave);
    }
  }
  if (waves.length > task.waves.count) warnings.push(`${waves.length} waves frozen, task.yaml plans ${task.waves.count} (extra waves are allowed)`);
  return { errors, warnings };
}
