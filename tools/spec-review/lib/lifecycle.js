// Workspaces, lifecycle and purpose: what a task is for, whether it still waits on
// the human, and when it has enough.
//
//   workspace: omi-notes          # groups tasks and spec sets (sidebar switcher, #/w/<id>/…)
//   status: active                # active (default) | paused | done | archived
//   decision: Ship v4 notes?      # the question the labels answer
//   enough_when: {labels: 40}     # or {rounds: 2}, {ci_half_width: 0.1, model: v4}
//   minutes_per_round: 6          # for the inbox's time estimate
//
// A task directory under <root>/_archive/ is archived whatever task.yaml says;
// archiving moves the whole directory there (labels and comments included) and
// restoring moves it back. Nothing inside the task is rewritten.

import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

export const ARCHIVE_DIR = "_archive";
export const STATUSES = ["active", "paused", "done", "archived"];
export const STALE_DAYS = 7;
export const WORKSPACE_FILE = "workspace.yaml";
export const DEFAULT_WORKSPACE = "default";
// Seconds a card takes when the task does not say (minutes_per_round).
export const DEFAULT_CARD_SECONDS = 20;

export const workspaceId = (s) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

export function normalizeLifecycle(raw, warnings = []) {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = { workspace: null, status: "active", created: null };
  if (r.workspace != null) {
    const id = workspaceId(r.workspace);
    if (!id) warnings.push(`workspace '${r.workspace}' is not a usable id (letters, digits, dashes)`);
    else out.workspace = id;
  }
  if (r.status != null) {
    const st = String(r.status).trim().toLowerCase();
    if (STATUSES.includes(st)) out.status = st;
    else warnings.push(`unknown status '${r.status}' (want ${STATUSES.join("|")}); treating it as active`);
  }
  if (r.created != null) {
    const d = new Date(r.created instanceof Date ? r.created : String(r.created));
    if (Number.isNaN(d.getTime())) warnings.push(`created '${r.created}' is not a date`);
    else out.created = d.toISOString();
  }
  return out;
}

// enough_when: a number (labels), {labels: N}, {rounds: N}, {ci_half_width: x,
// model?: id}, or the strings "labels>=40", "rounds>=2", "ci<=0.1".
export function parseEnough(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? { labels: v } : { error: "enough_when number must be a positive label count" };
  if (typeof v === "string") {
    const m = /^\s*(labels?|rounds?|waves?|ci|ci_half_width|comments?)\s*(?:>=|<=|:|=)\s*([\d.]+)\s*$/i.exec(v);
    if (!m) return { text: v, error: `enough_when '${v}' is not machine-readable (want labels>=N, rounds>=N or ci<=0.1); shown as text` };
    const k = m[1].toLowerCase();
    return parseEnough(k.startsWith("label") ? { labels: Number(m[2]) } : k.startsWith("round") || k.startsWith("wave") ? { rounds: Number(m[2]) } : k.startsWith("comment") ? { comments: Number(m[2]) } : { ci_half_width: Number(m[2]) });
  }
  if (typeof v !== "object" || Array.isArray(v)) return { error: "enough_when must be a number, a mapping or a string like labels>=40" };
  const out = {};
  for (const k of ["labels", "rounds", "comments"]) if (v[k] != null) {
    if (!Number.isInteger(v[k]) || v[k] <= 0) return { error: `enough_when.${k} must be a positive integer` };
    out[k] = v[k];
  }
  if (v.ci_half_width != null) {
    const x = Number(v.ci_half_width);
    if (!Number.isFinite(x) || x <= 0 || x >= 1) return { error: "enough_when.ci_half_width must be between 0 and 1 (0.1 = ±10 points)" };
    out.ci_half_width = x;
    if (v.model != null) out.model = String(v.model);
  }
  for (const k of Object.keys(v)) if (!["labels", "rounds", "comments", "ci_half_width", "model"].includes(k)) return { error: `enough_when: unknown key '${k}' (want labels, rounds, comments, ci_half_width, model)` };
  if (!Object.keys(out).length) return { error: "enough_when names no condition" };
  return out;
}

export function normalizePurpose(raw, warnings = []) {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = { decision: null, enough_when: null, minutes_per_round: null };
  if (r.decision != null) out.decision = String(r.decision).trim() || null;
  if (r.enough_when != null) {
    const e = parseEnough(r.enough_when);
    if (e && e.error) warnings.push(e.error);
    out.enough_when = e && !e.error ? e : e && e.text ? { text: e.text } : null;
  }
  if (r.minutes_per_round != null) {
    const n = Number(r.minutes_per_round);
    if (!Number.isFinite(n) || n <= 0) warnings.push("minutes_per_round must be a positive number");
    else out.minutes_per_round = n;
  }
  return out;
}

// What validate.js asks for on a task that still waits on a human.
export function purposeWarnings(task) {
  if (task.status === "archived" || task.status === "done") return [];
  const out = [];
  if (!task.decision) out.push("no `decision:` — say which question these labels answer (e.g. \"Ship v4 meeting notes?\")");
  if (!task.enough_when) out.push("no `enough_when:` — say when to stop (e.g. {labels: 40} or {ci_half_width: 0.1})");
  if (!task.minutes_per_round) out.push("no `minutes_per_round:` — the inbox estimates time from it");
  return out;
}

// The newest mtime among the task's files: task.yaml, items.jsonl, and every file
// under labels/, comments/ and waves/.
export function lastActivity(dir) {
  let t = 0;
  const see = (f) => { try { t = Math.max(t, fs.statSync(f).mtimeMs); } catch { /* absent */ } };
  see(path.join(dir, "task.yaml"));
  see(path.join(dir, "items.jsonl"));
  for (const sub of ["labels", "comments", "waves"]) {
    const d = path.join(dir, sub);
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) see(path.join(d, n));
  }
  return t || null;
}

export function createdAt(task, dir) {
  if (task.created) return Date.parse(task.created);
  try { const st = fs.statSync(path.join(dir, "task.yaml")); return st.birthtimeMs || st.ctimeMs; } catch { return null; }
}

export const isStale = (status, lastMs, now = Date.now()) => status === "active" && lastMs != null && now - lastMs > STALE_DAYS * 86400000;

// Is the task's enough_when met? `progress` = {labeled, roundsDone, comments,
// models: [{id, compared, ci}]}. Returns {met, text} or null without a condition.
export function evaluateEnough(enough, progress) {
  if (!enough) return null;
  if (enough.text && Object.keys(enough).length === 1) return { met: false, text: `Enough when: ${enough.text}`, machine: false };
  const parts = [];
  let met = true;
  if (enough.labels) { const ok = progress.labeled >= enough.labels; met &&= ok; parts.push(`${enough.labels} labels (${progress.labeled} so far)`); }
  if (enough.rounds) { const ok = progress.roundsDone >= enough.rounds; met &&= ok; parts.push(`${enough.rounds} round${enough.rounds === 1 ? "" : "s"} done (${progress.roundsDone} so far)`); }
  if (enough.comments) { const ok = (progress.comments || 0) >= enough.comments; met &&= ok; parts.push(`${enough.comments} comments (${progress.comments || 0} so far)`); }
  if (enough.ci_half_width) {
    const ms = (progress.models || []).filter((m) => !enough.model || m.id === enough.model);
    const widths = ms.map((m) => ({ id: m.id, n: m.compared, hw: m.compared ? (m.ci[1] - m.ci[0]) / 2 : 1 }));
    const widest = widths.sort((a, b) => b.hw - a.hw)[0];
    const ok = Boolean(widest) && widest.hw <= enough.ci_half_width;
    met &&= ok;
    const pts = (x) => `±${Math.round(x * 100)} pts`;
    parts.push(`${enough.model ? `${enough.model}'s` : "every model's"} 95% interval within ${pts(enough.ci_half_width)}${widest ? ` (widest now ${pts(widest.hw)}, ${widest.id} n=${widest.n})` : " (no model to measure)"}`);
  }
  return { met, text: `Enough when ${parts.join(" and ")}`, machine: true };
}

// Minutes to label `cards` cards.
export function estimateMinutes(task, cards) {
  if (!cards) return 0;
  const perCard = task.minutes_per_round ? task.minutes_per_round / Math.max(1, task.waves ? task.waves.size : task.round_size) : DEFAULT_CARD_SECONDS / 60;
  return Math.max(1, Math.round(perCard * cards));
}

// <dir>/workspace.yaml -> {id, title, project, owner} (id defaults to the dir name).
export function loadWorkspaceFile(dir) {
  const file = path.join(dir, WORKSPACE_FILE);
  if (!fs.existsSync(file)) return null;
  const out = { id: workspaceId(path.basename(dir)) || DEFAULT_WORKSPACE, title: null, project: null, owner: null, file, errors: [] };
  let raw;
  try { raw = yaml.load(fs.readFileSync(file, "utf8")); } catch (e) { out.errors.push(`${WORKSPACE_FILE}: ${e.message}`); return out; }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (raw.id != null && workspaceId(raw.id)) out.id = workspaceId(raw.id);
    for (const k of ["title", "project", "owner"]) if (raw[k] != null) out[k] = String(raw[k]);
  } else if (raw != null) out.errors.push(`${WORKSPACE_FILE} must be a mapping`);
  return out;
}

// Move a task directory into <root>/_archive/ (or back). The directory moves as a
// whole, so labels, comments, waves and media come along untouched.
export function archiveTask(entry) {
  if (entry.archived) return { error: "already archived" };
  const dest = path.join(entry.root, ARCHIVE_DIR, path.basename(entry.dir));
  if (fs.existsSync(dest)) return { error: `${ARCHIVE_DIR}/${path.basename(entry.dir)} already exists; rename one of them first` };
  if (entry.isRoot) return { error: "this labels root is itself the task; move it by hand" };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(entry.dir, dest);
  return { dir: dest };
}
export function restoreTask(entry) {
  if (!entry.archived) return { error: "not archived" };
  if (entry.isRoot) return { error: "this labels root is itself the task; move it by hand" };
  const dest = path.join(entry.root, path.basename(entry.dir));
  if (fs.existsSync(dest)) return { error: `${path.basename(entry.dir)} already exists outside the archive; rename one of them first` };
  fs.renameSync(entry.dir, dest);
  return { dir: dest };
}

// The workspace a root assigns to what it holds when the task or set does not
// name one: the hub entry's `workspace:`, else the root's workspace.yaml id,
// else "default".
export function rootWorkspace(root, rootWorkspaces) {
  if (!root) return DEFAULT_WORKSPACE;
  const r = path.resolve(root);
  if (rootWorkspaces && rootWorkspaces.get(r)) return rootWorkspaces.get(r);
  const w = loadWorkspaceFile(r);
  return w && !w.errors.length ? w.id : DEFAULT_WORKSPACE;
}
