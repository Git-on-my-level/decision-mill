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

import fs from "node:fs";
import path from "node:path";
import { discoverTasks, loadTask, getPath, isAbstain } from "./task.js";
import { readTaskLabels, reviewerFile, safeReviewer, buildRow, appendRows, labeledStates } from "./labelstore.js";
import { buildRounds, currentRound } from "./rounds.js";
import { computeResults, positiveLabel, modelVerdict } from "./results.js";

// Task cache keyed by the mtimes of task.yaml and items.jsonl, so editing either
// file is picked up on the next request without a restart.
const cache = new Map();
function stamp(dir) {
  const st = (f) => { try { const s = fs.statSync(path.join(dir, f)); return `${s.mtimeMs}:${s.size}`; } catch { return "-"; } };
  return `${st("task.yaml")}|${st("items.jsonl")}`;
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

// A reviewer's own human labels (what blind mode and progress are keyed on).
function humanStates(labels, reviewer) {
  const r = labels.reviewers[safeReviewer(reviewer)];
  const out = new Map();
  if (!r) return out;
  for (const [id, s] of labeledStates(r.states)) if ((s.source || "human") === "human") out.set(id, s);
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
    const cur = currentRound(t.rounds, mine);
    return {
      id: entry.id, title: t.task.title, question: t.task.question, blind: t.task.blind,
      items: t.items.length, labeled, standinReviewers: standin,
      rounds: { total: t.rounds.length, done: t.rounds.filter((r) => r.ids.every((id) => mine.has(id))).length, current: cur < t.rounds.length ? cur + 1 : null, size: t.task.round_size },
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
  const blindNow = t.task.blind && !labeledByMe;
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

const publicState = (s) => (s ? { label: s.label, fields: s.fields || {}, note: s.note || null, at: s.at || null, source: s.source || "human" } : null);

function serveMedia(req, res, t, src, json) {
  const rel = String(src || "");
  if (!rel || rel.startsWith("/") || rel.split(/[\\/]/).includes("..")) return json(res, 400, { error: "bad media path" });
  const mediaRoot = path.resolve(t.dir, "media");
  const abs = path.resolve(t.dir, rel);
  if (!abs.startsWith(mediaRoot + path.sep)) return json(res, 400, { error: "media must live under the task's media/ directory" });
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return json(res, 404, { error: "media not found" });
  const size = fs.statSync(abs).size;
  const TYPES = { ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".webm": "audio/webm", ".aac": "audio/aac", ".flac": "audio/flac",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4" };
  const type = TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream";
  // Range support: Safari will not play (and no browser will seek) audio without it.
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    if (start >= size || start > end) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
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

  const m = p.match(/^\/api\/task\/([^/]+)(?:\/(item|labels|results|media|label|undo)(?:\/(.+))?)?$/);
  if (!m) return false;
  const [, taskId, sub, rest] = m;
  const entry = discoverTasks(roots).find((e) => e.id === decodeURIComponent(taskId));
  if (!entry) throw new HttpError(404, `unknown task '${decodeURIComponent(taskId)}'`);
  const t = getTask(entry);

  if (!sub && req.method === "GET") {
    const labels = readTaskLabels(entry.dir);
    const own = ownStates(labels, reviewer);
    const mine = humanStates(labels, reviewer);
    const roundOf = new Map();
    for (const r of t.rounds) for (const id of r.ids) roundOf.set(id, r.n);
    const index = t.items.map((it) => {
      const s = own.get(it.id);
      const row = { id: it.id, title: it.title || null, round: roundOf.get(it.id), label: s && s.source !== "model-standin" ? s.label : null, note: s ? s.note : null,
        meta: it.meta ? { started_at: it.meta.started_at, duration_s: it.meta.duration_s, word_count: it.meta.word_count } : null };
      if (!t.task.blind || mine.has(it.id)) row.stratum = it.stratum ?? null;
      return row;
    });
    const cur = currentRound(t.rounds, mine);
    return json(res, 200, { task: t.task, errors: t.errors, warnings: t.warnings, reviewer, index,
      rounds: t.rounds.map((r) => ({ n: r.n, ids: r.ids, pinned: r.pinned })), current: cur });
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
        rows.push({ item_id: s.item_id, label: s.label, fields: s.fields, note: s.note, source: s.source || "human", at: s.at,
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
    const out = computeResults({ task: t.task, items: t.items, labels, reviewer: who, fill: u.searchParams.get("fill") === "1" });
    const titles = new Map(t.items.map((it) => [it.id, it.title || null]));
    for (const mm of out.models) for (const d of mm.disagreements) d.title = titles.get(d.item_id);
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
    const input = sub === "undo" ? { item_id: body.item_id, label: null } : body;
    const built = buildRow(input, { task: t.task, itemIds: new Set(t.byId.keys()), reviewer: who, source: standin ? "model-standin" : "human" });
    if (built.error) return json(res, 400, { error: built.error });
    const file = reviewerFile(entry.dir, who);
    await appendRows(file, [built.row]);
    const labels = readTaskLabels(entry.dir);
    const s = (labels.reviewers[safeReviewer(who)]?.states || new Map()).get(built.row.item_id);
    const it = t.byId.get(built.row.item_id);
    return json(res, 200, { ok: true, row: built.row, state: publicState(s), item: standin ? undefined : viewItem(t, it, s && s.label != null) });
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
