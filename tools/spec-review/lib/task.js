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

export const CONTENT_TYPES = new Set(["transcript", "markdown", "text"]);
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
  // Blind by default: the reviewer's label is the measurement, and seeing a model's
  // answer first turns it into a vote on the model.
  t.blind = t.blind !== false;
  t.round_size = Number.isInteger(t.round_size) && t.round_size > 0 ? t.round_size : 40;
  if (raw && raw.round_size != null && t.round_size !== raw.round_size) warnings.push(`round_size must be a positive integer (using ${t.round_size})`);
  t.stratify = t.stratify === "proportional" ? "proportional" : "balanced";
  if (raw && raw.stratify != null && raw.stratify !== t.stratify) warnings.push(`unknown stratify '${raw.stratify}' (want balanced|proportional)`);
  t.summary = t.summary === "open" ? "open" : "collapsed";
  // Which item.meta keys the card shows, in order. null = the default set
  // (started_at, duration_s, word_count, source); other keys stay hidden.
  if (t.meta_display != null && !Array.isArray(t.meta_display)) { warnings.push("meta_display must be a list of meta keys"); t.meta_display = null; }
  t.meta_display = Array.isArray(t.meta_display) ? t.meta_display.map(String) : null;
  // Waves replace rounds when set (see waves.js and LABELS.md#waves).
  t.waves = normalizeWaves(raw && raw.waves, t.id, errors, warnings);

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
    else if (!CONTENT_TYPES.has(c.type)) warnings.push(`${it.id}: unknown content.type '${c.type}' (want transcript|markdown|text)`);
    else if (c.type === "transcript" && !Array.isArray(c.segments)) warnings.push(`${it.id}: transcript content needs a segments list`);
    else if (c.type !== "transcript" && typeof c.body !== "string") warnings.push(`${it.id}: ${c.type} content needs a body string`);
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
    items.push(it);
  }
  if (!items.length && !errors.length) errors.push("items.jsonl has no items");
  return { items, errors, warnings };
}

// Is `dir` a task directory?
export const isTaskDir = (dir) => fs.existsSync(path.join(dir, "task.yaml"));

// Every task under the configured roots: a root may hold task directories or be
// one. Returns [{id, dir}] with ids unique (later duplicates get a suffix).
export function discoverTasks(roots) {
  const out = [];
  const ids = new Set();
  const add = (dir) => {
    let id = path.basename(dir);
    for (let n = 2; ids.has(id); n++) id = `${path.basename(dir)}-${n}`;
    ids.add(id);
    out.push({ id, dir });
  };
  for (const root of roots || []) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
    if (isTaskDir(root)) { add(root); continue; }
    for (const name of fs.readdirSync(root).sort()) {
      const d = path.join(root, name);
      if (name.startsWith(".")) continue;
      try { if (fs.statSync(d).isDirectory() && isTaskDir(d)) add(d); } catch { /* unreadable entry */ }
    }
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
  let parsed = { items: [], errors: [], warnings: [] };
  const itemsFile = path.join(dir, "items.jsonl");
  if (!fs.existsSync(itemsFile)) errors.push("items.jsonl missing");
  else parsed = parseItems(fs.readFileSync(itemsFile, "utf8"), norm.task);
  return {
    task: norm.task,
    items: parsed.items,
    errors: [...errors, ...parsed.errors],
    warnings: [...norm.warnings, ...parsed.warnings],
  };
}
