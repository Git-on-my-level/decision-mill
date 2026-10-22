// Label-task loading and validation (LABELS.md v1).
//
// A task is a directory: task.yaml + items.jsonl + labels/<reviewer>.jsonl
// (+ optional media/). Nothing here writes; see labelstore.js for the one write
// path. Every function is pure over the directory's files so the server, the
// labels CLI and the tests share one reading of the format.

import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { normalizeWaves } from "./waves.js";
import { proposalProblems } from "./proposal.js";
import { pairProblems } from "./pair.js";
import { httpUrl, shown } from "./url.js";
import { normalizeCommentTags } from "./comments.js";
import { normalizeLifecycle, normalizePurpose, ARCHIVE_DIR } from "./lifecycle.js";

export const CONTENT_TYPES = new Set(["transcript", "markdown", "text", "proposal", "pair", "speaker_group"]);
export const FIELD_TYPES = new Set(["checkbox", "choice", "text"]);
// Keys the shared keyboard model owns in label mode; a task may not bind them.
export const RESERVED_KEYS = new Set(["j", "k", "u", "n", "e", "?", "/", " ", "arrowleft", "arrowright", "escape", "enter"]);
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export const isAbstain = (label) => Boolean(label && (label.abstain === true || label.id === "unsure"));

// Dotted-path getter for score_path / verdict_path ("hidden.jev.p_discard").
export function getPath(obj, dotted) {
  if (!dotted) return undefined;
  let cur = obj;
  for (const part of String(dotted).split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

// Normalize task.yaml into the shape every consumer uses, collecting warnings for
// drift and errors for anything that would make labeling unsafe or ambiguous.
export function normalizeTask(raw, dirName) {
  const errors = [];
  const warnings = [];
  const t = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  if (!raw || typeof raw !== "object") errors.push("task.yaml must be a mapping");
  t.id = t.id ? String(t.id) : dirName;
  if (dirName && t.id !== dirName) warnings.push(`task id '${t.id}' differs from directory name '${dirName}' — the directory name is used in URLs`);
  t.id = dirName || t.id;
  t.title = t.title ? String(t.title) : t.id;
  t.question = t.question ? String(t.question) : "";
  t.instructions = t.instructions ? String(t.instructions) : "";
  // Shown in place of the card while items.jsonl is empty or missing: how the items
  // get made (who runs what). An empty task is a normal state, not an error.
  if (t.pending != null && typeof t.pending !== "string") warnings.push("pending must be a markdown string");
  t.pending = typeof t.pending === "string" ? t.pending : "";
  // Blind by default: the reviewer's label is the measurement, and seeing a model's
  // answer first turns it into a vote on the model.
  t.blind = t.blind !== false;
  t.round_size = Number.isInteger(t.round_size) && t.round_size > 0 ? t.round_size : 40;
  if (raw && raw.round_size != null && t.round_size !== raw.round_size) warnings.push(`round_size must be a positive integer (using ${t.round_size})`);
  t.stratify = t.stratify === "proportional" ? "proportional" : "balanced";
  if (raw && raw.stratify != null && raw.stratify !== t.stratify) warnings.push(`unknown stratify '${raw.stratify}' (want balanced|proportional)`);
  t.summary = t.summary === "open" || t.summary === "collapsed" ? t.summary : "first";
  // Which item.meta keys the card shows, in order. null = the default set
  // (started_at, duration_s, word_count, source); other keys stay hidden.
  if (t.meta_display != null && !Array.isArray(t.meta_display)) { warnings.push("meta_display must be a list of meta keys"); t.meta_display = null; }
  t.meta_display = Array.isArray(t.meta_display) ? t.meta_display.map(String) : null;
  // Waves replace rounds when set (see waves.js and LABELS.md#waves).
  t.waves = normalizeWaves(raw && raw.waves, t.id, errors, warnings);
  // Line comments: the quick tags offered under the comment box.
  t.comment_tags = normalizeCommentTags(raw && raw.comment_tags, warnings);
  // Workspace and lifecycle (status, defaults to active), and what the task is for:
  // the question it answers, when it has enough, how long a round takes.
  Object.assign(t, normalizeLifecycle(raw, warnings), normalizePurpose(raw, warnings));

  t.suggest_threshold = t.suggest_threshold ?? 0.45;
  if (!Number.isFinite(t.suggest_threshold) || t.suggest_threshold < 0 || t.suggest_threshold > 2) errors.push("suggest_threshold must be between 0 and 2");
  if (t.kind === "speakers") t.labels = [{id: "You", label: "You"}, {id: "mixed", label: "Mixed"}, {id: "noise", label: "Not speech / noise"}, {id: "unsure", label: "Unsure"}];
  if (t.kind === "speakers" && t.waves) errors.push("speaker tasks use a group queue, not waves");
  if (t.kind === "speakers" && t.audit?.per_conversation != null && (!Number.isInteger(t.audit.per_conversation) || t.audit.per_conversation < 0)) errors.push("audit.per_conversation must be a nonnegative integer");
  const used = new Set();
  const labels = Array.isArray(t.labels) ? t.labels : [];
  if (!labels.length) errors.push("task.yaml needs at least one entry under labels");
  t.labels = [];
  for (const [i, l] of labels.entries()) {
    if (!l || typeof l !== "object" || !l.id) { errors.push(`labels[${i}] needs an id`); continue; }
    const id = String(l.id);
    if (t.labels.some((x) => x.id === id)) { errors.push(`duplicate label id '${id}'`); continue; }
    const out = { ...l, id, label: l.label ? String(l.label) : id, key: l.key != null ? String(l.key).toLowerCase() : null };
    out.abstain = isAbstain(out);
    t.labels.push(out);
  }
  // Unsure is always available: a forced guess is worse data than an abstention.
  if (!t.labels.some(isAbstain) && t.labels.length) {
    t.labels.push({ id: "unsure", label: "Unsure", key: null, abstain: true, added: true });
  }
  // Fill missing keys with the next free digit, in order.
  for (const l of t.labels) if (l.key) used.add(l.key);
  for (const l of t.labels) {
    if (l.key) continue;
    for (let d = 1; d <= 9; d++) if (!used.has(String(d))) { l.key = String(d); used.add(l.key); break; }
  }
  const keyOwner = new Map();
  for (const l of t.labels) {
    if (!l.key) continue;
    if (RESERVED_KEYS.has(l.key)) errors.push(`label '${l.id}' uses reserved key '${l.key}'`);
    if (keyOwner.has(l.key)) errors.push(`key '${l.key}' bound twice (${keyOwner.get(l.key)}, ${l.id})`);
    keyOwner.set(l.key, `label ${l.id}`);
  }

  const fields = Array.isArray(t.fields) ? t.fields : [];
  t.fields = [];
  for (const [i, f] of fields.entries()) {
    if (!f || typeof f !== "object" || !f.id) { errors.push(`fields[${i}] needs an id`); continue; }
    const type = f.type ? String(f.type) : "checkbox";
    if (!FIELD_TYPES.has(type)) { errors.push(`field '${f.id}': unknown type '${type}' (want checkbox|choice|text)`); continue; }
    const out = { ...f, id: String(f.id), type, label: f.label ? String(f.label) : String(f.id), key: f.key != null ? String(f.key).toLowerCase() : null };
    if (type === "choice") {
      out.options = (Array.isArray(f.options) ? f.options : []).map((o) => (typeof o === "object" ? { id: String(o.id), label: String(o.label || o.id) } : { id: String(o), label: String(o) }));
      if (!out.options.length) errors.push(`field '${out.id}': choice needs options`);
    }
    if (out.key) {
      if (RESERVED_KEYS.has(out.key)) errors.push(`field '${out.id}' uses reserved key '${out.key}'`);
      if (keyOwner.has(out.key)) errors.push(`key '${out.key}' bound twice (${keyOwner.get(out.key)}, field ${out.id})`);
      keyOwner.set(out.key, `field ${out.id}`);
      if (type !== "checkbox") warnings.push(`field '${out.id}': only checkbox fields use a key`);
    }
    t.fields.push(out);
  }

  const models = Array.isArray(t.models) ? t.models : [];
  t.models = [];
  for (const [i, m] of models.entries()) {
    if (!m || typeof m !== "object" || !m.id) { errors.push(`models[${i}] needs an id`); continue; }
    if (!m.verdict_path && !m.score_path) warnings.push(`model '${m.id}' has neither verdict_path nor score_path — nothing to compare`);
    if (m.positive_label != null && !t.labels.some((l) => l.id === String(m.positive_label))) {
      warnings.push(`model '${m.id}': positive_label '${m.positive_label}' is not a label id`);
    }
    t.models.push({ ...m, id: String(m.id), threshold: m.threshold == null ? null : Number(m.threshold) });
  }
  return { task: t, errors, warnings };
}

// Parse items.jsonl. Returns items in file order plus line-numbered problems.
export function parseItems(text, task) {
  const items = [];
  const errors = [];
  const warnings = [];
  const seen = new Set();
  const labelIds = new Set((task?.labels || []).map((l) => l.id));
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let it;
    try { it = JSON.parse(line); } catch (e) { errors.push(`items.jsonl line ${i + 1}: invalid JSON (${e.message})`); continue; }
    if (!it || typeof it !== "object" || Array.isArray(it)) { errors.push(`items.jsonl line ${i + 1}: item must be an object`); continue; }
    if (typeof it.id !== "string" || !it.id) { errors.push(`items.jsonl line ${i + 1}: item needs a string id`); continue; }
    if (seen.has(it.id)) { errors.push(`items.jsonl line ${i + 1}: duplicate id '${it.id}'`); continue; }
    seen.add(it.id);
    const c = it.content;
    if (!c || typeof c !== "object") warnings.push(`${it.id}: no content`);
    else if (!CONTENT_TYPES.has(c.type)) warnings.push(`${it.id}: unknown content.type '${c.type}' (want transcript|markdown|text|proposal|pair)`);
    else if (c.type === "transcript" && !Array.isArray(c.segments)) warnings.push(`${it.id}: transcript content needs a segments list`);
    else if (c.type === "proposal") for (const p of proposalProblems(c)) warnings.push(`${it.id}: ${p}`);
    else if (c.type === "pair") for (const p of pairProblems(c)) warnings.push(`${it.id}: ${p}`);
    else if (!["transcript", "speaker_group"].includes(c.type) && typeof c.body !== "string") warnings.push(`${it.id}: ${c.type} content needs a body string`);
    // A permalink to the item's source, shown as a link on the card: http(s) only.
    if (it.url != null && !httpUrl(it.url)) warnings.push(`${it.id}: url must be an http(s) URL (got '${shown(it.url)}'); it will not be shown as a link`);
    if (it.hidden != null && (typeof it.hidden !== "object" || Array.isArray(it.hidden))) warnings.push(`${it.id}: hidden must be a mapping`);
    if (it.context != null && !Array.isArray(it.context)) warnings.push(`${it.id}: context must be a list`);
    if (it.media != null && !Array.isArray(it.media)) warnings.push(`${it.id}: media must be a list`);
    for (const md of Array.isArray(it.media) ? it.media : []) {
      const src = String(md?.src || "");
      if (!src || src.startsWith("/") || src.split("/").includes("..")) warnings.push(`${it.id}: media src must be a relative path inside the task (got '${src}')`);
    }
    for (const m of task?.models || []) {
      const v = getPath(it, m.verdict_path);
      if (v != null && labelIds.size && !labelIds.has(String(v))) warnings.push(`${it.id}: model '${m.id}' verdict '${v}' is not a label id`);
      const s = getPath(it, m.score_path);
      if (s != null && !Number.isFinite(Number(s))) warnings.push(`${it.id}: model '${m.id}' score '${s}' is not a number`);
    }
    if (it.centroid != null && (!Array.isArray(it.centroid) || !it.centroid.length || !it.centroid.every(Number.isFinite))) errors.push(`${it.id}: centroid needs finite numbers`);
    items.push(it);
  }
  return { items, errors, warnings };
}

// Is `dir` a task directory?
export const isTaskDir = (dir) => fs.existsSync(path.join(dir, "task.yaml"));

// Every task under the configured roots: a root may hold task directories or be
// one. Returns [{id, dir}] with ids unique (later duplicates get a suffix).
// Tasks moved into `<root>/_archive/` are discovered too, flagged archived: the
// archive keeps their labels and the Archived filter shows them.
export function discoverTasks(roots) {
  const out = [];
  const ids = new Set();
  const add = (dir, root, archived = false, isRoot = false) => {
    let id = path.basename(dir);
    for (let n = 2; ids.has(id); n++) id = `${path.basename(dir)}-${n}`;
    ids.add(id);
    out.push({ id, dir, root, archived, isRoot });
  };
  const scan = (dir, root, archived) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const d = path.join(dir, name);
      if (name.startsWith(".") || (!archived && name === ARCHIVE_DIR)) continue;
      try { if (fs.statSync(d).isDirectory() && isTaskDir(d)) add(d, root, archived); } catch { /* unreadable entry */ }
    }
  };
  for (const root of roots || []) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
    if (isTaskDir(root)) { add(root, path.dirname(root), path.basename(path.dirname(root)) === ARCHIVE_DIR, true); continue; }
    scan(root, root, false);
    const arch = path.join(root, ARCHIVE_DIR);
    try { if (fs.statSync(arch).isDirectory()) scan(arch, root, true); } catch { /* no archive */ }
  }
  return out;
}

// Read a task directory from disk. Never throws for format problems — they come
// back as errors so the UI can show them next to the task.
export function loadTask(dir, id) {
  const dirName = id || path.basename(dir);
  let raw = null;
  const errors = [];
  try { raw = yaml.load(fs.readFileSync(path.join(dir, "task.yaml"), "utf8")); }
  catch (e) { errors.push(`task.yaml: ${e.message}`); }
  const norm = normalizeTask(raw, dirName);
  errors.push(...norm.errors);
  // A task that lives in <root>/_archive/ is archived whatever task.yaml says.
  if (path.basename(path.dirname(path.resolve(dir))) === ARCHIVE_DIR) norm.task.status = "archived";
  let parsed = { items: [], errors: [], warnings: [] };
  const itemsFile = path.join(dir, "items.jsonl");
  // A missing or empty items.jsonl means the task is waiting for its items (see
  // `pending`): a state the UI shows, not a format error.
  if (fs.existsSync(itemsFile)) parsed = parseItems(fs.readFileSync(itemsFile, "utf8"), norm.task);
  let conversations = [];
  if (norm.task.kind === "speakers") {
    try {
      conversations = JSON.parse(fs.readFileSync(path.join(dir, "conversations.json"), "utf8"));
      if (!Array.isArray(conversations)) throw new Error("must be an array");
      const groups = new Map(parsed.items.map(it => [it.id, it]));
      const ids = new Set();
      for (const c of conversations) {
        if (!c.id || !Array.isArray(c.words) || !Array.isArray(c.segments)) throw new Error("conversation needs id, words and segments");
        for (const w of c.words) if (!Array.isArray(w) || !Number.isFinite(w[0]) || !Number.isFinite(w[1]) || w[1] < w[0] || typeof w[2] !== "string") throw new Error("invalid word timing");
        for (const s of c.segments) {
          if (!s.id || ids.has(s.id) || groups.has(s.id) || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end < s.start || !Number.isInteger(s.w0) || !Number.isInteger(s.w1) || s.w0 < 0 || s.w1 > c.words.length || s.w1 < s.w0) throw new Error("invalid segment");
          ids.add(s.id);
          if (s.group && !groups.has(s.group)) throw new Error("unknown segment group");
        }
      }
      for (const it of parsed.items) {
        const c = conversations.find(c => c.id === it.content?.conversation);
        if (it.content?.type !== "speaker_group" || !c || !Array.isArray(it.content.segments) || !it.content.segments.length || !it.content.segments.every(id => c.segments.some(s => s.id === id && s.group === it.id)) || !(it.content.representatives || []).every(id => it.content.segments.includes(id))) throw new Error("invalid speaker_group membership");
      }
    } catch (e) { errors.push(`conversations.json: ${e.message}`); }
  }
  // `pending` describes how the items get made; once they exist it is stale and
  // would keep the task flagged as waiting.
  if (norm.task.pending && parsed.items.length) norm.warnings.push("pending note set but items present — remove it from task.yaml");
  return {
    conversations,
    task: norm.task,
    items: parsed.items,
    empty: !parsed.items.length,
    errors: [...errors, ...parsed.errors],
    warnings: [...norm.warnings, ...parsed.warnings],
  };
}
