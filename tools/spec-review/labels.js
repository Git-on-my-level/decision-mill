#!/usr/bin/env node
// labels.js — read label tasks straight from the files, no server needed.
//
//   node labels.js tasks [ROOT...]                     list tasks (default: LABELS_ROOT)
//   node labels.js stats  <task> [--reviewer R] [--fill] [--json]
//   node labels.js export <task> [--reviewer R] [--source human|model-standin] [--final] [--format jsonl|csv]
//
// Waves mode (task.yaml `waves:`, see LABELS.md#waves) — the between-wave agent loop:
//   node labels.js waves <task> [--json]               where the waves stand, and what to do next
//   node labels.js infer-prompt <task> [--out F] [--max-chars N] [--offset N --limit N]
//                                                      brief: the human's labels + every unlabeled item
//   node labels.js import-standin <task> <file> [--reviewer NAME] [--model ID] [--include-labeled] [--dry-run]
//                                                      append model-standin rows (JSONL or JSON array)
//   node labels.js next-wave <task> [--dry-run] [--early] [--extra] [--allow-missing] [--allow-stale]
//                                                      select and freeze the next wave (waves/wave-N.json)
//
// Line comments (what the human said about a span of a card):
//   node labels.js comments <task> [--reviewer R] [--json]
//                                                      grouped by hidden model (letters mapped via
//                                                      hidden.letters / models[].verdict_path) and tag
//
// Waiting for the human (a background waiter; exits 0 satisfied, 2 timeout, 1 error):
//   node labels.js wait <task> --until wave-ready|round-done|labeled:N|done|change
//                   [--url http://127.0.0.1:PORT] [--timeout 3h] [--reviewer R] [--json]
//     wave-ready  the human finished every frozen wave (state inferring or done)
//     round-done  the round/wave that was current when the wait began is labeled
//     labeled:N   (or 'labeled>=N') the human has labeled at least N items
//     done        every round/wave is labeled
//     change      any new label row, comment or frozen wave
//     commented   any new comment row since the wait began (commented:N = at least N comments)
//   With --url it long-polls the server's GET /api/task/<id>/wait; without, it
//   watches the task files directly.
//
// <task> is a task directory, or a task id under LABELS_ROOT / --labels.
// `stats` prints the same agreement numbers as the Results view (lib/results.js).
// `export` prints each reviewer's latest label per item (append-only files folded,
// latest row wins), one row per reviewer×item; `--final` prints one row per item:
// the human label where there is one, else the task's stand-in label.
// Human labels are never written here. import-standin appends only to the
// stand-in's own file (never a file holding human rows); a running server reads it
// on the next request.

import { speakerResults, exportTruth } from "./lib/speakers.js";
import fs from "node:fs";
import path from "node:path";
import { LABELS_ROOTS } from "./lib/config.js";
import { discoverTasks, loadTask, isTaskDir } from "./lib/task.js";
import { readTaskLabels, safeReviewer, buildRow, appendRows, reviewerFile } from "./lib/labelstore.js";
import { computeResults, positiveLabel, modelVerdict } from "./lib/results.js";
import { readWaves, nextWave, waveStatus, waveReviewer, humanStatesOf, standinStatesOf, evaluateStandin, prepareStandinRows } from "./lib/waves.js";
import { buildBrief, parseStandinFile } from "./lib/brief.js";
import { parseDuration, parseUntil, waitLoop } from "./lib/wait.js";
import { labelWaitState, labelCondition } from "./lib/label-api.js";
import { readTaskComments, liveComments, commentSummary } from "./lib/comments.js";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1] ?? null; };
const has = (name) => argv.includes(name);
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && ["--reviewer", "--source", "--format", "--labels", "--out", "--max-chars", "--offset", "--limit", "--model", "--until", "--url", "--timeout", "--standin"].includes(arr[i - 1])));

function usage(code = 2) {
  console.error("usage: node labels.js tasks [ROOT...] | stats <task> [--reviewer R] [--fill] [--json] | export <task> [--reviewer R] [--source S] [--final] [--format jsonl|csv]\n       waves <task> | infer-prompt <task> [--out F] | import-standin <task> <file> | next-wave <task> [--dry-run]\n       comments <task> [--reviewer R] [--json]\n       wait <task> --until wave-ready|round-done|labeled:N|done|change|commented [--url URL] [--timeout 3h]  (see the header of labels.js)");
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

function loadOrDie(ref) {
  const t = resolveTask(ref);
  const { task, items, errors } = loadTask(t.dir, t.id);
  if (errors.length) { console.error(`task errors:\n  ${errors.join("\n  ")}`); process.exit(1); }
  if (!task.waves && ["waves", "next-wave"].includes(cmd)) { console.error(`${t.id} has no \`waves:\` in task.yaml (it uses rounds)`); process.exit(2); }
  return { t, task, items, labels: readTaskLabels(t.dir) };
}

const NEXT = {
  unfrozen: "wave 1 freezes when the task is first opened (or: labels.js next-wave <task>)",
  labeling: "the human is labeling; nothing to do until the wave is done",
  inferring: "agent: infer-prompt → label every item → import-standin → next-wave",
  done: "every wave is labeled; read Results → Final labels",
};
function printWaves(w) {
  const s = w.status, e = w.evaluation, f = w.final;
  console.log(`\nwaves: ${s.frozen}/${s.count} frozen · state ${s.state}${s.current ? ` (wave ${s.current})` : ""} · human ${s.reviewer || "—"} · stand-in ${s.standin}`);
  for (const x of s.waves) console.log(`  wave ${x.n} (${x.strategy}): ${x.labeled}/${x.size} labeled`);
  console.log(`  unlabeled outside waves: ${s.candidates} · stand-in labels: ${s.covered} (${s.fresh} newer than the latest human label)`);
  console.log(`  next: ${NEXT[s.state]}${s.nextStrategy && s.state !== "labeling" ? ` (next wave: ${s.nextStrategy})` : ""}`);
  const line = (name, r) => r.compared ? `${pct(r.rate)} (${r.agree}/${r.compared}, 95% ${pct(r.ci[0])}–${pct(r.ci[1])})` : "—";
  console.log(`\nstand-in accuracy, predictions recorded before the human labeled:`);
  console.log(`  hold-out (random waves): ${line("h", e.holdout)} · bar ${pct(e.accept)} → ${e.verdict}`);
  console.log(`  targeted waves (hard items, pessimistic): ${line("t", e.targeted)}`);
  console.log(`  by confidence: ≥0.8 ${line("", e.calibration.high)} · 0.6–0.8 ${line("", e.calibration.mid)} · <0.6 ${line("", e.calibration.low)}`);
  console.log(`\nfinal labels: ${f.human} human + ${f.standin} stand-in${f.uncovered ? ` + ${f.uncovered} unlabeled` : ""} of ${f.items}`);
  for (const m of f.models) console.log(`  ${m.id}: human-only ${m.humanOnly ? line("", m.humanOnly) : "—"} · combined ${m.combined ? line("", m.combined) : "—"}`);
}

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
  if (task.kind === "speakers") {
    const loaded=loadTask(t.dir,t.id);
    const result=speakerResults({...loaded,dir:t.dir},labels,reviewer); exportTruth(t.dir,result);
    if (has("--json")) console.log(JSON.stringify(result,null,2));
    else for (const c of result.conversations) {
      console.log(`${c.id}: speech labeled ${pct(c.progress.rate)}`);
      for (const m of [...c.systems,{id:"single speaker",...c.baseline}]) console.log(`  ${m.id}: 1:1 ${pct(m.one_to_one)} · many:1 ${pct(m.many_to_one)} · words ${m.words} · speakers ${m.speakers_found}/${m.speakers_true}`);
      console.log(`  purity ${pct(c.purity.rate)} (n=${c.purity.compared}, 95% ${c.purity.ci.map(pct).join("–")})`);
    }
    process.exit(0);
  }
  const waves = task.waves ? readWaves(t.dir).waves : null;
  const res = computeResults({ task, items, labels, reviewer, fill: has("--fill"), waves });
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
  if (res.waves) printWaves(res.waves);
  if (warnings.length) console.log(`\n${warnings.length} task warning(s): node validate.js shows them`);
} else if (cmd === "waves") {
  const { t, task, items, labels } = loadOrDie(positional[0]);
  const { waves, errors } = readWaves(t.dir);
  if (errors.length) console.error(`wave file problems:\n  ${errors.join("\n  ")}`);
  const res = computeResults({ task, items, labels, reviewer: flag("--reviewer") ? safeReviewer(flag("--reviewer")) : null, waves });
  if (has("--json")) { console.log(JSON.stringify(res.waves, null, 2)); process.exit(0); }
  console.log(`${task.title}  [${t.id}]`);
  printWaves(res.waves);
} else if (cmd === "next-wave") {
  const { t, task, items, labels } = loadOrDie(positional[0]);
  const pos = new Map(task.models.map((m) => [m.id, positiveLabel(m, items)]));
  const r = nextWave({ dir: t.dir, task, items, labels, reviewer: flag("--reviewer"), opts: {
    dryRun: has("--dry-run"), early: has("--early"), extra: has("--extra"), allowMissing: has("--allow-missing"), allowStale: has("--allow-stale"),
    modelVerdicts: (it) => task.models.map((m) => modelVerdict(m, it, pos.get(m.id))) } });
  if (r.error) { console.error(`next-wave: ${r.error}`); process.exit(1); }
  const w = r.wave;
  const byId = new Map(items.map((it) => [it.id, it]));
  const tally = (f) => Object.entries(w.items.reduce((a, x) => { const k = f(x); a[k] = (a[k] || 0) + 1; return a; }, {})).map(([k, v]) => `${k} ${v}`).join(", ");
  console.log(`${r.file ? "froze" : "would freeze (dry run)"} wave ${w.wave} of ${w.of} · ${w.strategy} · ${w.items.length} items${r.file ? ` → ${r.file}` : ""}`);
  console.log(`  why:    ${tally((x) => x.reason)}`);
  console.log(`  strata: ${tally((x) => byId.get(x.id)?.stratum ?? "(none)")}`);
  const preds = w.items.filter((x) => x.prediction);
  if (preds.length) console.log(`  stand-in predictions recorded before the human labels them: ${preds.length} (${tally((x) => (x.prediction ? x.prediction.label : "none"))})`);
} else if (cmd === "infer-prompt") {
  const { t, task, items, labels } = loadOrDie(positional[0]);
  const cfg = task.waves;
  const who = waveReviewer(cfg, labels, flag("--reviewer"));
  if (!who) { console.error("infer-prompt: no human labels yet — label first (wave 1)"); process.exit(1); }
  const human = humanStatesOf(labels, who);
  const standinName = cfg ? cfg.standin : safeReviewer(flag("--standin") || "opus-standin");
  const waves = cfg ? readWaves(t.dir).waves : [];
  const ev = cfg ? evaluateStandin({ task, waves, human }) : { misses: [] };
  const st = cfg ? waveStatus({ task, items, waves, labels, reviewer: who }) : null;
  const info = st ? `Waves: ${st.frozen} of ${st.count} frozen; ${st.labeled} labeled by the human. Your labels fill the rest and choose the next wave.` : null;
  const text = buildBrief({ task, items, human, standinName, misses: ev.misses, waveInfo: info, reviewer: who,
    maxChars: Number(flag("--max-chars")) || 3000, offset: Number(flag("--offset")) || 0, limit: Number(flag("--limit")) || Infinity });
  if (flag("--out")) { fs.writeFileSync(flag("--out"), text); console.error(`wrote ${flag("--out")} (${text.length} chars, ~${Math.round(text.length / 4)} tokens)`); }
  else process.stdout.write(text + "\n");
} else if (cmd === "import-standin") {
  const { t, task, items, labels } = loadOrDie(positional[0]);
  const file = positional[1];
  if (!file || !fs.existsSync(file)) { console.error("import-standin: give the stand-in file (JSONL or a JSON array)"); process.exit(2); }
  const parsed = parseStandinFile(fs.readFileSync(file, "utf8"));
  if (parsed.errors.length) { console.error(`import-standin: ${file} does not parse:\n  ${parsed.errors.slice(0, 10).join("\n  ")}`); process.exit(1); }
  const cfg = task.waves;
  const reviewer = flag("--reviewer") || (cfg ? cfg.standin : "opus-standin");
  const human = humanStatesOf(labels, waveReviewer(cfg, labels, null));
  const r = prepareStandinRows({ task, items, labels, rows: parsed.rows, reviewer, model: flag("--model"), includeLabeled: has("--include-labeled"), human, buildRow });
  if (r.error) { console.error(`import-standin: ${r.error} (nothing written)`); process.exit(1); }
  if (!has("--dry-run") && r.rows.length) await appendRows(reviewerFile(t.dir, r.reviewer), r.rows);
  const dist = r.rows.reduce((a, x) => { a[x.label] = (a[x.label] || 0) + 1; return a; }, {});
  console.log(`${has("--dry-run") ? "would append" : "appended"} ${r.rows.length} model-standin row(s) to labels/${r.reviewer}.jsonl (${Object.entries(dist).map(([k, v]) => `${k} ${v}`).join(", ") || "none"})`);
  if (r.skipped) console.log(`  skipped ${r.skipped} row(s) for items the human already labeled`);
  if (r.dupes) console.log(`  ${r.dupes} item(s) appeared twice; the later row wins`);
  if (r.missing.length) console.log(`  ${r.missing.length} unlabeled item(s) still have no row in this file${r.missing.length <= 5 ? `: ${r.missing.join(", ")}` : ""}`);
  if (cfg) console.log("  next: node labels.js next-wave " + t.id + " --dry-run, then without --dry-run");
} else if (cmd === "wait") {
  const until = flag("--until");
  if (!until) { console.error("wait: --until is required (wave-ready | round-done | labeled:N | done | change | commented | commented:N)"); process.exit(1); }
  const cond = parseUntil(until, "label");
  if (cond.error) { console.error(`wait: ${cond.error}`); process.exit(1); }
  const totalS = parseDuration(flag("--timeout") || "1h");
  if (totalS == null) { console.error(`wait: bad --timeout '${flag("--timeout")}' (want 3h, 90m, 45s or seconds)`); process.exit(1); }
  const ref = positional[0];
  if (!ref) usage(1);
  const line = (b) => b ? `${b.labeled}/${b.items} labeled by ${b.reviewer || "—"}${b.waves ? ` · waves ${b.waves.frozen}/${b.waves.count} frozen, state ${b.waves.state}` : b.current != null ? ` · ${b.unit} ${b.current} of ${b.rounds.length} current` : " · all rounds done"}` : "";
  let r;
  if (flag("--url")) {
    const base = flag("--url").replace(/\/+$/, "");
    const id = fs.existsSync(path.resolve(ref)) && isTaskDir(path.resolve(ref)) ? path.basename(path.resolve(ref)) : ref;
    r = await waitLoop({ totalS, buildUrl: ({ since, timeout, extra }) => {
      const q = new URLSearchParams({ until, timeout: String(timeout) });
      if (since) q.set("since", since);
      if (extra && extra.round != null) q.set("round", String(extra.round));
      if (flag("--reviewer")) q.set("reviewer", flag("--reviewer"));
      return `${base}/api/task/${encodeURIComponent(id)}/wait?${q}`;
    } });
  } else {
    // No server: watch the files. Same state and conditions as the endpoint.
    const t = resolveTask(ref);
    const base = { since: null, round: null };
    const deadline = Date.now() + totalS * 1000;
    for (;;) {
      let st, c;
      try { st = labelWaitState(t, flag("--reviewer")); c = labelCondition(st, cond, base); }
      catch (e) { r = { code: 1, message: e.message }; break; }
      if (c.error) { r = { code: 1, body: st, message: c.error }; break; }
      if (c.done) { r = { code: 0, body: { status: "satisfied", until, ...st } }; break; }
      if (Date.now() >= deadline) { r = { code: 2, body: { status: "timeout", until, ...st } }; break; }
      await new Promise((ok) => setTimeout(ok, Math.min(2000, Math.max(0, deadline - Date.now()))));
    }
  }
  if (has("--json") && r.body) console.log(JSON.stringify(r.body, null, 2));
  else if (r.code === 0) console.log(`satisfied: ${until} — ${line(r.body)}`);
  else if (r.code === 2) console.log(`timeout: ${until} not reached after ${flag("--timeout") || "1h"} — ${line(r.body)}`);
  if (r.code === 1) console.error(`wait: ${r.message}`);
  process.exit(r.code);
} else if (cmd === "comments") {
  const t = resolveTask(positional[0]);
  const { task, items, errors } = loadTask(t.dir, t.id);
  if (errors.length) { console.error(`task errors:\n  ${errors.join("\n  ")}`); process.exit(1); }
  const wantR = flag("--reviewer") ? safeReviewer(flag("--reviewer")) : null;
  const all = liveComments(readTaskComments(t.dir)).filter((c) => !wantR || safeReviewer(c.reviewer) === wantR || c.file_reviewer === wantR);
  // The CLI is for whoever built the task: letters are always mapped to models.
  const sum = commentSummary({ task, items, comments: all });
  if (has("--json")) { console.log(JSON.stringify(sum, null, 2)); process.exit(0); }
  console.log(`${task.title}  [${t.id}]`);
  console.log(`${sum.total} comment(s) on ${sum.items} item(s)${sum.tags.length ? ` · tags: ${sum.tags.map((x) => `${x} ${sum.tagTotals[x]}`).join(", ")}` : ""}`);
  const short = (s, n) => { const x = String(s || "").replace(/\s+/g, " ").trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
  for (const g of sum.groups) {
    const tagLine = [...Object.entries(g.tags).map(([k, v]) => `${k} ${v}`), g.untagged ? `untagged ${g.untagged}` : null].filter(Boolean).join(", ");
    console.log(`\n${g.kind === "model" ? "model" : g.kind === "letter" ? "variant" : g.kind === "blind" ? "" : "block"} ${g.key}: ${g.total} comment(s) on ${g.items} item(s)${tagLine ? ` — ${tagLine}` : ""}`);
    for (const c of g.comments) console.log(`  · ${short(c.title || c.item_id, 40)}${c.letter ? ` [${c.letter}]` : ` [${c.anchor}]`} "${short(c.quote, 70)}" — ${c.text || "(no text)"}${c.tags.length ? ` (${c.tags.join(", ")})` : ""}`);
  }
} else if (cmd === "export") {
  const t = resolveTask(positional[0]);
  const labels = readTaskLabels(t.dir);
  const wantR = flag("--reviewer") ? safeReviewer(flag("--reviewer")) : null;
  const wantS = flag("--source");
  const format = flag("--format") || "jsonl";
  const rows = [];
  if (has("--final")) {
    // One row per item: the human label (authoritative), else the stand-in's.
    const { task, items } = loadTask(t.dir, t.id);
    const who = waveReviewer(task.waves, labels, wantR);
    const human = humanStatesOf(labels, who);
    const standin = standinStatesOf(labels, task.waves ? task.waves.standin : safeReviewer(flag("--standin") || "opus-standin"));
    for (const it of items) {
      const s = human.get(it.id) || standin.get(it.id);
      if (!s) { rows.push({ item_id: it.id, reviewer: null, source: null, label: null, fields: {}, note: null, at: null }); continue; }
      rows.push({ item_id: it.id, reviewer: human.has(it.id) ? who : (task.waves ? task.waves.standin : "opus-standin"), source: s.source || "human", label: s.label, fields: s.fields || {}, note: s.note || null, at: s.at || null,
        ...(s.confidence != null ? { confidence: s.confidence } : {}) });
    }
  }
  for (const [name, r] of has("--final") ? [] : Object.entries(labels.reviewers)) {
    if (wantR && name !== wantR) continue;
    for (const s of r.states.values()) {
      if (s.label == null) continue;
      if (wantS && (s.source || "human") !== wantS) continue;
      rows.push({ item_id: s.item_id, ...(s.scope ? {scope:s.scope} : {}), reviewer: name, source: s.source || "human", label: s.label, fields: s.fields || {}, note: s.note || null, at: s.at || null,
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
