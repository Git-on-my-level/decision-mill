// The label store: labels/<reviewer>.jsonl, append-only, latest row per item wins.
//
// Rows are never rewritten or deleted. An undo is a new row with `label: null`; a
// note added without a verdict is a row with no `label` key at all. Folding the
// rows in file order gives each item's current state, and the file itself is the
// audit trail — the label-mode equivalent of spec mode's notes timeline.

import fs from "node:fs";
import path from "node:path";

export const SOURCES = new Set(["human", "model-standin"]);

// Reviewer names become file names. Keep them readable (an email or a Tailscale
// login stays recognizable) but never let one escape labels/.
export function safeReviewer(name) {
  let s = String(name || "").trim().replace(/[^A-Za-z0-9._@+-]/g, "_").slice(0, 80);
  if (!s) s = "reviewer";
  if (s.startsWith(".")) s = `_${s}`;
  return s;
}

export const labelsDir = (taskDir) => path.join(taskDir, "labels");
export const reviewerFile = (taskDir, reviewer) => path.join(labelsDir(taskDir), `${safeReviewer(reviewer)}.jsonl`);

export function readRows(file) {
  const rows = [];
  let bad = 0;
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return { rows, bad }; throw e; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === "object" && typeof r.item_id === "string") rows.push(r);
      else bad++;
    } catch { bad++; } // a torn final line from a crash is skipped, never fatal
  }
  return { rows, bad };
}

// Fold rows (file order) into Map<item_id, state>. A state with label null means
// "not labeled" (never labeled, or undone); callers treat it as absent.
export function foldRows(rows) {
  const out = new Map();
  for (const r of rows) {
    const cur = out.get(r.item_id) || { item_id: r.item_id, label: null, fields: {}, note: null, rows: 0 };
    cur.rows++;
    if (Object.prototype.hasOwnProperty.call(r, "label")) {
      cur.label = r.label == null ? null : String(r.label);
      // A verdict row carries the full field set; an undo clears it.
      cur.fields = r.label == null ? {} : { ...(r.fields && typeof r.fields === "object" ? r.fields : {}) };
      cur.at = r.at;
      cur.source = r.source || "human";
      cur.reviewer = r.reviewer;
      for (const k of ["confidence", "rationale", "model"]) if (r[k] != null) cur[k] = r[k]; else delete cur[k];
    } else if (r.fields && typeof r.fields === "object") {
      cur.fields = { ...cur.fields, ...r.fields };
    }
    if (typeof r.note === "string") cur.note = r.note || null;
    out.set(r.item_id, cur);
  }
  return out;
}

// All reviewers' latest states for a task: { reviewers: { name: { file, source,
// states: Map, bad } } }. `source` is the source of the reviewer's most recent row.
export function readTaskLabels(taskDir) {
  const reviewers = {};
  const dir = labelsDir(taskDir);
  if (!fs.existsSync(dir)) return { reviewers };
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".jsonl")) continue;
    const file = path.join(dir, f);
    const { rows, bad } = readRows(file);
    const name = f.replace(/\.jsonl$/, "");
    const last = rows[rows.length - 1];
    reviewers[name] = { file, source: (last && last.source) || "human", states: foldRows(rows), bad, rowCount: rows.length };
  }
  return { reviewers };
}

// Labeled = has a non-null label. Returns Map<item_id, state>.
export function labeledStates(states) {
  const out = new Map();
  for (const [id, s] of states || []) if (s.label != null) out.set(id, s);
  return out;
}

// Validate one incoming row against the task. Returns { row } or { error }.
export function buildRow(input, { task, itemIds, reviewer, source, now = new Date() }) {
  if (!input || typeof input !== "object") return { error: "row must be an object" };
  const itemId = input.item_id;
  if (typeof itemId !== "string" || !itemId) return { error: "item_id required" };
  if (itemIds && !itemIds.has(itemId)) return { error: `unknown item_id '${itemId}'` };
  const src = source || input.source || "human";
  if (!SOURCES.has(src)) return { error: `source must be human or model-standin (got '${src}')` };
  const row = { item_id: itemId };
  const hasLabel = Object.prototype.hasOwnProperty.call(input, "label");
  if (hasLabel) {
    if (input.label === null) row.label = null;
    else {
      const id = String(input.label);
      if (!task.labels.some((l) => l.id === id)) return { error: `unknown label '${id}' (want ${task.labels.map((l) => l.id).join("|")})` };
      row.label = id;
    }
  }
  if (input.fields != null) {
    if (typeof input.fields !== "object" || Array.isArray(input.fields)) return { error: "fields must be a mapping" };
    const fields = {};
    for (const [k, v] of Object.entries(input.fields)) {
      const f = task.fields.find((x) => x.id === k);
      if (!f) return { error: `unknown field '${k}'` };
      if (f.type === "checkbox") fields[k] = Boolean(v);
      else if (f.type === "choice") {
        if (v != null && !f.options.some((o) => o.id === String(v))) return { error: `field '${k}': unknown option '${v}'` };
        fields[k] = v == null ? null : String(v);
      } else fields[k] = v == null ? null : String(v).slice(0, 4000);
    }
    row.fields = fields;
  }
  if (input.note != null) row.note = String(input.note).slice(0, 8000);
  if (!hasLabel && row.fields == null && row.note == null) return { error: "row needs a label, fields or a note" };
  if (src === "model-standin") {
    if (input.confidence != null) row.confidence = Number(input.confidence);
    if (input.rationale != null) row.rationale = String(input.rationale).slice(0, 4000);
    if (input.model != null) row.model = String(input.model).slice(0, 120);
  }
  row.reviewer = String(reviewer);
  row.source = src;
  row.at = now.toISOString();
  return { row };
}

// One in-process queue per file: every append for a file runs after the previous
// one has finished, so concurrent requests can never interleave bytes. Each row is
// one appendFileSync of one line, which keeps a crash from tearing anything but
// the final line (and readRows skips a torn line).
const queues = new Map();
export function appendRows(file, rows) {
  const prev = queues.get(file) || Promise.resolve();
  const next = prev.then(() => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    fs.appendFileSync(file, text);
  });
  queues.set(file, next.catch(() => {}));
  return next;
}
export const appendRow = (file, row) => appendRows(file, [row]);
