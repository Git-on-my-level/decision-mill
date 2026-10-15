// Label-mode HTTP API. Mounted by server.js under /api/task*; every write goes
// through labelstore.appendRows, whose per-file queue serializes concurrent
// requests (the browser, a stand-in agent and a second reviewer at once).
//
//   GET  /api/tasks                         task list with this reviewer's progress
//   GET  /api/task/:id                      task config, light item index, rounds
//   GET  /api/task/:id/item/:item           one item (hidden stripped while blind)
//   GET  /api/task/:id/labels               every reviewer's latest labels (agents)
//   GET  /api/task/:id/results[?fill=1]     agreement, per stratum, threshold curves
//   GET  /api/task/:id/media?src=media/x    a media file, with Range support
//   POST /api/task/:id/label                one row: {item_id, label?, fields?, note?}
//   POST /api/task/:id/undo                 {item_id} -> appends label: null
//   POST /api/task/:id/labels               agent batch: {reviewer, labels:[...]}
//                                           source is always model-standin

import { speakerStates, suggestions, segmentLabel, progress, auditSample, speakerResults, exportTruth } from "./speakers.js";
import fs from "node:fs";
import path from "node:path";
import { discoverTasks, loadTask, getPath, isAbstain } from "./task.js";
import { readTaskLabels, reviewerFile, safeReviewer, buildRow, appendRows, labeledStates, readRows } from "./labelstore.js";
import { buildRounds, currentRound } from "./rounds.js";
import { computeResults, positiveLabel, modelVerdict } from "./results.js";
import { readWaves, nextWave, waveStatus } from "./waves.js";

// Task cache keyed by the mtimes of task.yaml and items.jsonl, so editing either
// file is picked up on the next request without a restart.
const cache = new Map();
function stamp(dir) {
  const st = (f) => { try { const s = fs.statSync(path.join(dir, f)); return `${s.mtimeMs}:${s.size}`; } catch { return "-"; } };
  return `${st("task.yaml")}|${st("items.jsonl")}|${st("conversations.json")}`;
}
export function getTask(entry) {
  const key = stamp(entry.dir);
  const hit = cache.get(entry.dir);
  if (hit && hit.key === key) return hit.value;
  const loaded = loadTask(entry.dir, entry.id);
  const value = { ...loaded, dir: entry.dir, byId: new Map(loaded.items.map((it) => [it.id, it])), rounds: buildRounds(loaded.items, loaded.task) };
  cache.set(entry.dir, { key, value });
  return value;
}

// The task's rounds: fixed rounds, or (waves mode) the frozen waves, read fresh on
// every request because an agent freezes the next wave from the CLI.
export function roundsFor(entry, t) {
  if (!t.task.waves) return { rounds: t.rounds, waves: null, errors: [] };
  const { waves, errors } = readWaves(entry.dir);
  return { rounds: waves.map((w) => ({ n: w.wave, ids: w.ids.filter((id) => t.byId.has(id)), pinned: true, strategy: w.strategy })), waves, errors };
}

export const modelVerdictsFn = (t) => {
  const pos = new Map(t.task.models.map((m) => [m.id, positiveLabel(m, t.items)]));
  return (it) => t.task.models.map((m) => modelVerdict(m, it, pos.get(m.id)));
};

// Waves mode: freeze wave 1 the first time the task is opened, so a fresh task is
// labelable without an agent. Later waves are frozen by the agent (labels.js
// next-wave) once stand-in labels exist. Exclusive create: concurrent opens are safe.
function ensureFirstWave(entry, t, reviewer) {
  if (!t.task.waves) return;
  const { waves, errors } = readWaves(entry.dir);
  if (waves.length || errors.length || !t.items.length) return;
  nextWave({ dir: entry.dir, task: t.task, items: t.items, labels: readTaskLabels(entry.dir), reviewer, opts: { modelVerdicts: modelVerdictsFn(t) } });
}

// A reviewer's own human labels (what blind mode and progress are keyed on).
function humanStates(labels, reviewer) {
  const r = labels.reviewers[safeReviewer(reviewer)];
  const out = new Map();
  if (!r) return out;
  for (const [id, s] of labeledStates(r.states)) if ((s.source || "human") !== "model-standin") out.set(id, s);
  return out;
}
function ownStates(labels, reviewer) {
  const r = labels.reviewers[safeReviewer(reviewer)];
  return r ? r.states : new Map();
}

export function taskSummaries(roots, reviewer) {
  return discoverTasks(roots).map((entry) => {
    const t = getTask(entry);
    const labels = readTaskLabels(entry.dir);
    const mine = humanStates(labels, reviewer);
    const labeled = t.items.filter((it) => mine.has(it.id)).length;
    const standin = Object.values(labels.reviewers).filter((r) => [...r.states.values()].some((s) => s.label != null && s.source === "model-standin")).length;
    const { rounds, waves } = roundsFor(entry, t);
    const cur = currentRound(rounds, mine);
    const ws = waves ? waveStatus({ task: t.task, items: t.items, waves, labels, reviewer }) : null;
    return {
      id: entry.id, title: t.task.title, question: t.task.question, blind: t.task.blind,
      items: t.items.length, empty: !t.items.length, pending: Boolean(t.task.pending), labeled, standinReviewers: standin,
      rounds: { total: ws ? ws.count : rounds.length, done: rounds.filter((r) => r.ids.every((id) => mine.has(id))).length, current: cur < rounds.length ? cur + 1 : null, size: ws ? ws.size : t.task.round_size },
      waves: ws ? { state: ws.state, frozen: ws.frozen, count: ws.count, current: ws.current } : null,
      errors: t.errors.length, warnings: t.warnings.length,
    };
  });
}

const segText = (segs) => (Array.isArray(segs) ? segs.map((s) => s && s.text).filter(Boolean).join(" ") : "");
function visibleText(it) {
  const c = it.content || {};
  return [it.id, it.title, it.summary, c.type === "transcript" ? segText(c.segments) : c.body].filter(Boolean).join("\n");
}

export function searchTasks(roots, terms, limit) {
  const out = [];
  if (limit <= 0) return out;
  for (const entry of discoverTasks(roots)) {
    const t = getTask(entry);
    for (const it of t.items) {
      const hay = visibleText(it);
      const low = hay.toLowerCase();
      if (!terms.every((term) => low.includes(term))) continue;
      const idx = low.indexOf(terms[0]);
      const start = Math.max(0, idx - 40);
      out.push({ type: "item", task: entry.id, taskTitle: t.task.title, id: it.id, title: it.title || it.id,
        snippet: (start > 0 ? "…" : "") + hay.slice(start, idx + 130).replace(/\s+/g, " ") + "…" });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// What a reviewer may see of an item. While the task is blind and this reviewer
// has not labeled it, hidden model answers and the stratum (which usually encodes
// them, e.g. "nano_discard_jev_keep") are withheld by the server, not just the UI.
function viewItem(t, it, labeledByMe) {
  const blindNow = t.task.kind === "speakers" || (t.task.blind && !labeledByMe);
  const { hidden, stratum, ...rest } = it;
  const out = { ...rest };
  if (!blindNow) {
    out.stratum = stratum;
    out.hidden = hidden;
    out.reveal = t.task.models.map((m) => {
      const pos = positiveLabel(m, t.items);
      const score = getPath(it, m.score_path);
      return { model: m.id, verdict: modelVerdict(m, it, pos), score: score == null ? null : Number(score), threshold: m.threshold };
    });
  }
  out.blinded = blindNow;
  return out;
}

const publicState = (s) => (s ? { label: s.label, scope:s.scope, fields: s.fields || {}, note: s.note || null, at: s.at || null, source: s.source || "human" } : null);

function serveMedia(req, res, t, src, json) {
  const rel = String(src || "");
  if (!rel || rel.startsWith("/") || rel.split(/[\\/]/).includes("..")) return json(res, 400, { error: "bad media path" });
  const mediaRoot = path.resolve(t.dir, "media");
  const abs = path.resolve(t.dir, rel);
  if (!abs.startsWith(mediaRoot + path.sep)) return json(res, 400, { error: "media must live under the task's media/ directory" });
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return json(res, 404, { error: "media not found" });
  if (!fs.realpathSync(abs).startsWith(fs.realpathSync(mediaRoot) + path.sep)) return json(res, 400, { error: "bad media path" });
  const size = fs.statSync(abs).size;
  const TYPES = { ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".webm": "audio/webm", ".aac": "audio/aac", ".flac": "audio/flac",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4" };
  const type = TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream";
  // Range support: Safari will not play (and no browser will seek) audio without it.
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "cache-control": "no-store" });
    return fs.createReadStream(abs, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes", "cache-control": "no-store" });
  fs.createReadStream(abs).pipe(res);
}

// Returns false when the path is not a label route (server.js falls through).
export async function handleLabelApi(req, res, u, { roots, reviewer, readBody, json, HttpError }) {
  const p = u.pathname;
  if (p === "/api/tasks" && req.method === "GET") return json(res, 200, { reviewer, tasks: taskSummaries(roots, reviewer) });

  const m = p.match(/^\/api\/task\/([^/]+)(?:\/(item|labels|results|media|label|undo|speakers|suggestions)(?:\/(.+))?)?$/);
  if (!m) return false;
  const [, taskId, sub, rest] = m;
  const entry = discoverTasks(roots).find((e) => e.id === decodeURIComponent(taskId));
  if (!entry) throw new HttpError(404, `unknown task '${decodeURIComponent(taskId)}'`);
  const t = getTask(entry);

  if (sub === "suggestions") {
    const states = speakerStates(readTaskLabels(entry.dir), safeReviewer(reviewer));
    const picks = suggestions(t.items, states, t.task.suggest_threshold, t.task.kind === "speakers");
    if (req.method === "GET") return json(res, 200, { suggestions: picks });
    if (req.method === "POST") {
      const body = await readBody(req);
      const ids = body.ids;
      if (!Array.isArray(ids) || !ids.length || !ids.every(id => picks[id])) return json(res, 409, { error: "suggestions changed; refresh the preview" });
      const rows = [...new Set(ids)].map(id => buildRow({ item_id:id, label:picks[id].label, ...(t.task.kind === "speakers" ? {scope:"group"} : {}) }, { task:t.task, itemIds:new Set(t.byId.keys()), reviewer, source:"suggested-accepted" }).row);
      await appendRows(reviewerFile(entry.dir,reviewer),rows);
      return json(res,200,{ok:true,rows});
    }
  }
  if (sub === "speakers" && req.method === "GET" && t.task.kind === "speakers") {
    const labels = readTaskLabels(entry.dir), states = speakerStates(labels,safeReviewer(reviewer));
    const roster = ["You"];
    const history = Object.values(labels.reviewers).flatMap(r => readRows(r.file).rows).sort((a,b) => (a.at || "").localeCompare(b.at || ""));
    for (const s of history) if (s.source !== "model-standin" && s.label && !["mixed","noise","unsure"].includes(s.label) && !roster.includes(s.label)) roster.push(s.label);
    const queue = [...t.items].sort((a,b) => Number(states.get(a.id)?.label != null)-Number(states.get(b.id)?.label != null) || (b.content.segments.length-a.content.segments.length) || a.id.localeCompare(b.id));
    return json(res,200,{ roster, queue:queue.map(it => ({...viewItem(t,it,false), label:states.get(it.id)?.label ?? null})), suggestions:suggestions(t.items,states,t.task.suggest_threshold),
      conversations:t.conversations.map(c => ({...c, progress:progress(c,states), segments:c.segments.map(s => ({...s,label:segmentLabel(s,states)})), audit:auditSample(c,t.task.audit?.per_conversation ?? 15).map(s => ({id:s.id,start:s.start,end:s.end,w0:s.w0,w1:s.w1,text:s.text,label:states.get(`audit:${s.id}`)?.label ?? null})) })) });
  }
  if (!sub && req.method === "GET") {
    ensureFirstWave(entry, t, reviewer);
    const labels = readTaskLabels(entry.dir);
    const own = ownStates(labels, reviewer);
    const mine = humanStates(labels, reviewer);
    const { rounds, waves, errors: waveErrors } = roundsFor(entry, t);
    const roundOf = new Map();
    for (const r of rounds) for (const id of r.ids) roundOf.set(id, r.n);
    const index = t.items.map((it) => {
      const s = own.get(it.id);
      const row = { id: it.id, title: it.title || null, round: roundOf.get(it.id), label: s && s.source !== "model-standin" ? s.label : null, note: s ? s.note : null,
        meta: it.meta ? { started_at: it.meta.started_at, duration_s: it.meta.duration_s, word_count: it.meta.word_count } : null };
      if (!t.task.blind || mine.has(it.id)) row.stratum = it.stratum ?? null;
      return row;
    });
    const cur = currentRound(rounds, mine);
    return json(res, 200, { task: t.task, errors: [...t.errors, ...waveErrors], warnings: t.warnings, reviewer, index,
      rounds: rounds.map((r) => ({ n: r.n, ids: r.ids, pinned: r.pinned, strategy: r.strategy })), current: cur,
      waves: waves ? waveStatus({ task: t.task, items: t.items, waves, labels, reviewer }) : null });
  }

  if (sub === "item" && req.method === "GET") {
    const id = decodeURIComponent(rest || "");
    const it = t.byId.get(id);
    if (!it) throw new HttpError(404, `unknown item '${id}'`);
    const labels = readTaskLabels(entry.dir);
    const own = ownStates(labels, reviewer).get(id);
    const labeledByMe = humanStates(labels, reviewer).has(id);
    return json(res, 200, { item: viewItem(t, it, labeledByMe), state: own && own.source !== "model-standin" ? publicState(own) : null });
  }

  if (sub === "labels" && req.method === "GET") {
    // Agent read path: everything, with sources, so a caller can separate human
    // labels from stand-ins. Optional ?reviewer= and ?source= filters.
    const labels = readTaskLabels(entry.dir);
    const wantR = u.searchParams.get("reviewer");
    const wantS = u.searchParams.get("source");
    const out = {};
    for (const [name, r] of Object.entries(labels.reviewers)) {
      if (wantR && name !== safeReviewer(wantR)) continue;
      const rows = [];
      for (const [, s] of r.states) {
        if (s.label == null && !s.note) continue;
        if (wantS && (s.source || "human") !== wantS) continue;
        rows.push({ item_id: s.item_id, scope:s.scope, label: s.label, fields: s.fields, note: s.note, source: s.source || "human", at: s.at,
          ...(s.confidence != null ? { confidence: s.confidence } : {}), ...(s.rationale ? { rationale: s.rationale } : {}) });
      }
      out[name] = { labeled: rows.filter((x) => x.label != null).length, malformedRows: r.bad, labels: rows };
    }
    return json(res, 200, { task: entry.id, reviewers: out });
  }

  if (sub === "results" && req.method === "GET") {
    const labels = readTaskLabels(entry.dir);
    const want = u.searchParams.get("reviewer");
    const me = safeReviewer(reviewer);
    // Default truth is the requesting reviewer when they have labels, else every
    // human (latest wins) — what an agent calling without identity wants.
    const who = want ? safeReviewer(want) : labels.reviewers[me] ? me : null;
    const { waves } = roundsFor(entry, t);
    if (t.task.kind === "speakers") {
      const out = speakerResults(t,labels,who); exportTruth(t.dir,out); return json(res,200,out);
    }
    const out = computeResults({ task: t.task, items: t.items, labels, reviewer: who, fill: u.searchParams.get("fill") === "1", waves });
    const titles = new Map(t.items.map((it) => [it.id, it.title || null]));
    for (const mm of out.models) for (const d of mm.disagreements) d.title = titles.get(d.item_id);
    if (out.waves) for (const x of out.waves.evaluation.misses) x.title = titles.get(x.item_id);
    return json(res, 200, out);
  }

  if (sub === "media" && req.method === "GET") return serveMedia(req, res, t, u.searchParams.get("src"), json);

  if ((sub === "label" || sub === "undo") && req.method === "POST") {
    const body = await readBody(req);
    const standin = body.source === "model-standin";
    if (standin && !body.reviewer) return json(res, 400, { error: "model-standin rows need a reviewer name (e.g. \"opus-standin\")" });
    const who = standin ? String(body.reviewer) : reviewer;
    if (!standin && body.reviewer && safeReviewer(body.reviewer) !== safeReviewer(reviewer)) {
      return json(res, 400, { error: "human labels are attributed to the request's reviewer; omit reviewer" });
    }
    const input = sub === "undo" ? { item_id: body.item_id, label: null, scope:body.scope } : {...body};
    const segment = t.conversations?.flatMap(c => c.segments).find(s => s.id === input.item_id);
    if (t.task.kind === "speakers") {
      input.scope ||= segment ? "segment" : "group";
      if ((input.scope === "group") !== t.byId.has(input.item_id) || (input.scope !== "group" && !segment)) return json(res,400,{error:"scope does not match item"});
      if (input.scope === "audit") input.audit_group_label = ownStates(readTaskLabels(entry.dir),reviewer).get(segment.group)?.label ?? null;
    }
    const built = buildRow(input, { task: t.task, itemIds: new Set([...t.byId.keys(), ...(t.conversations || []).flatMap(c => c.segments.map(s => s.id))]), reviewer: who, source: standin ? "model-standin" : body.source === "suggested-accepted" ? "suggested-accepted" : "human" });
    if (built.error) return json(res, 400, { error: built.error });
    const file = reviewerFile(entry.dir, who);
    await appendRows(file, [built.row]);
    const labels = readTaskLabels(entry.dir);
    const s = (labels.reviewers[safeReviewer(who)]?.states || new Map()).get(built.row.scope === "audit" ? `audit:${built.row.item_id}` : built.row.item_id);
    const it = t.byId.get(built.row.item_id);
    return json(res, 200, { ok: true, row: built.row, state: publicState(s), item: standin ? undefined : it ? viewItem(t, it, s && s.label != null) : undefined });
  }

  if (sub === "labels" && req.method === "POST") {
    // Agent batch write. Always model-standin: a human label comes from a human
    // clicking, never from an API call that claims to be one.
    const body = await readBody(req);
    if (!body.reviewer) return json(res, 400, { error: "reviewer required (e.g. \"opus-standin\")" });
    if (body.source && body.source !== "model-standin") return json(res, 400, { error: "batch writes are model-standin only" });
    if (!Array.isArray(body.labels) || !body.labels.length) return json(res, 400, { error: "labels must be a non-empty list" });
    if (body.labels.length > 5000) return json(res, 413, { error: "at most 5000 rows per batch" });
    const ids = new Set(t.byId.keys());
    const rows = [];
    for (const [i, input] of body.labels.entries()) {
      const built = buildRow(input, { task: t.task, itemIds: ids, reviewer: String(body.reviewer), source: "model-standin" });
      if (built.error) return json(res, 400, { error: `labels[${i}]: ${built.error}` });
      rows.push(built.row);
    }
    await appendRows(reviewerFile(entry.dir, body.reviewer), rows);
    return json(res, 200, { ok: true, appended: rows.length, reviewer: safeReviewer(body.reviewer) });
  }

  throw new HttpError(405, "method not allowed");
}

export { isAbstain };
