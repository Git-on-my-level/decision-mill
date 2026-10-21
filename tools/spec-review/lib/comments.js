// Line comments: comments/<reviewer>.jsonl, append-only, latest row per comment wins.
//
// A label says which variant won; a comment says why ("it didn't name Kory"). Each
// comment quotes a span of what the card showed: the block it sits in (`anchor`: a
// variant letter such as "A", a markdown section, a transcript segment `seg:3`, a
// proposal part), the quoted text, and its character offsets inside that block's
// rendered text. Rows are never rewritten: an edit is a new row with the same
// comment_id, a delete is `deleted: true`, and restoring is `deleted: false`.
//
// Comments live beside labels/, never inside it, so a comment row can never fold
// into a label state.

import fs from "node:fs";
import path from "node:path";
import { safeReviewer, appendRows, readRows } from "./labelstore.js";

// Dotted-path getter (task.js has the same; kept local to avoid an import cycle).
function getPath(obj, dotted) {
  if (!dotted) return undefined;
  let cur = obj;
  for (const part of String(dotted).split(".")) { if (cur == null || typeof cur !== "object") return undefined; cur = cur[part]; }
  return cur;
}

export const DEFAULT_COMMENT_TAGS = Object.freeze(["wrong-name", "missing", "hallucinated", "too-long", "formatting"]);
const ANCHOR_RE = /^[^\n]{1,120}$/;
const CID_RE = /^[A-Za-z0-9._-]{4,64}$/;

export const commentsDir = (taskDir) => path.join(taskDir, "comments");
export const commentFile = (taskDir, reviewer) => path.join(commentsDir(taskDir), `${safeReviewer(reviewer)}.jsonl`);

// task.yaml `comment_tags:` -> [{id, label}]. Strings or {id, label}; default list
// when absent; `[]` turns tags off.
export function normalizeCommentTags(raw, warnings = []) {
  if (raw == null) return DEFAULT_COMMENT_TAGS.map((id) => ({ id, label: id.replace(/-/g, " ") }));
  if (!Array.isArray(raw)) { warnings.push("comment_tags must be a list of tag ids"); return DEFAULT_COMMENT_TAGS.map((id) => ({ id, label: id.replace(/-/g, " ") })); }
  const out = [];
  for (const t of raw) {
    const id = String(t && typeof t === "object" ? t.id ?? "" : t ?? "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(id)) { warnings.push(`comment_tags: bad tag '${id}' (want a short id like wrong-name)`); continue; }
    if (out.some((x) => x.id === id)) { warnings.push(`comment_tags: duplicate tag '${id}'`); continue; }
    out.push({ id, label: t && typeof t === "object" && t.label ? String(t.label) : id.replace(/-/g, " ") });
  }
  return out;
}

export function newCommentId(now = new Date()) {
  return `c-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Fold rows (file order) into Map<comment_id, comment>. Deleted comments stay in
// the map with deleted: true so a restore can bring them back.
export function foldComments(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!r || typeof r.comment_id !== "string") continue;
    const cur = out.get(r.comment_id) || { comment_id: r.comment_id, item_id: r.item_id, anchor: null, quote: "", start: null, end: null, text: "", tags: [], deleted: false, rows: 0, created_at: r.at };
    cur.rows++;
    for (const k of ["item_id", "anchor", "quote", "start", "end", "text", "reviewer"]) if (r[k] !== undefined) cur[k] = r[k];
    if (Array.isArray(r.tags)) cur.tags = r.tags.map(String);
    if (typeof r.deleted === "boolean") cur.deleted = r.deleted;
    cur.at = r.at;
    out.set(r.comment_id, cur);
  }
  return out;
}

// Every reviewer's comments: { reviewers: { name: { file, comments: Map, bad } } }.
export function readTaskComments(taskDir) {
  const reviewers = {};
  const dir = commentsDir(taskDir);
  if (!fs.existsSync(dir)) return { reviewers };
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".jsonl")) continue;
    const file = path.join(dir, f);
    const { rows, bad } = readCommentRows(file);
    reviewers[f.replace(/\.jsonl$/, "")] = { file, comments: foldComments(rows), bad, rowCount: rows.length };
  }
  return { reviewers };
}

// labelstore.readRows wants item_id; a delete row carries only comment_id, so read
// the file with the same torn-line tolerance but our own shape check.
export function readCommentRows(file) {
  const rows = [];
  let bad = 0;
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return { rows, bad }; throw e; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === "object" && typeof r.comment_id === "string") rows.push(r);
      else bad++;
    } catch { bad++; }
  }
  return { rows, bad };
}
export { readRows };

// Live (not deleted) comments, flattened, oldest first. Optional item filter.
export function liveComments(all, itemId = null) {
  const out = [];
  for (const [name, r] of Object.entries(all.reviewers)) {
    for (const c of r.comments.values()) {
      if (c.deleted) continue;
      if (itemId != null && c.item_id !== itemId) continue;
      out.push({ ...c, reviewer: c.reviewer || name, file_reviewer: name });
    }
  }
  return out.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
}

export const publicComment = (c) => ({ comment_id: c.comment_id, item_id: c.item_id, anchor: c.anchor, quote: c.quote, start: c.start, end: c.end, text: c.text, tags: c.tags || [], reviewer: c.reviewer, at: c.at, created_at: c.created_at, edited: c.rows > 1 });

// Validate one comment action against the task and this reviewer's own comments.
// action: create | edit | delete | restore. Returns { row } or { error }.
export function buildCommentRow(input, { task, itemIds, reviewer, own, now = new Date() }) {
  if (!input || typeof input !== "object") return { error: "body must be an object" };
  const action = input.action || (input.comment_id ? "edit" : "create");
  const tags = (task.comment_tags || []).map((t) => t.id);
  const checkTags = (v) => {
    if (v == null) return { tags: undefined };
    if (!Array.isArray(v)) return { error: "tags must be a list" };
    const out = [...new Set(v.map(String))];
    const bad = out.filter((t) => !tags.includes(t));
    if (bad.length) return { error: `unknown tag '${bad[0]}' (want ${tags.join("|") || "no tags: comment_tags is empty"})` };
    return { tags: out };
  };
  const base = { reviewer: String(reviewer), source: "human", at: now.toISOString() };
  if (action === "create") {
    const itemId = input.item_id;
    if (typeof itemId !== "string" || !itemId) return { error: "item_id required" };
    if (itemIds && !itemIds.has(itemId)) return { error: `unknown item_id '${itemId}'` };
    const anchor = String(input.anchor ?? "").trim();
    if (!ANCHOR_RE.test(anchor)) return { error: "anchor required (the block the quote sits in, e.g. \"A\" or \"seg:3\"), at most 120 characters" };
    const quote = String(input.quote ?? "");
    if (!quote.trim()) return { error: "quote required (the selected text)" };
    const start = Number(input.start), end = Number(input.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return { error: "start and end must be character offsets with 0 <= start < end" };
    const text = String(input.text ?? "").trim();
    const tg = checkTags(input.tags);
    if (tg.error) return { error: tg.error };
    if (!text && !(tg.tags && tg.tags.length)) return { error: "a comment needs text or a tag" };
    let id = input.comment_id ? String(input.comment_id) : newCommentId(now);
    if (!CID_RE.test(id)) return { error: "bad comment_id" };
    if (own && own.has(id)) return { error: `comment ${id} already exists` };
    return { row: { comment_id: id, item_id: itemId, anchor, quote: quote.slice(0, 2000), start, end, text: text.slice(0, 4000), tags: tg.tags || [], ...base } };
  }
  const id = String(input.comment_id || "");
  if (!id) return { error: "comment_id required" };
  const cur = own && own.get(id);
  if (!cur) return { error: `no comment ${id} by ${reviewer} (only your own comments can be changed)` };
  if (action === "delete") return { row: { comment_id: id, item_id: cur.item_id, deleted: true, ...base } };
  if (action === "restore") return { row: { comment_id: id, item_id: cur.item_id, deleted: false, ...base } };
  if (action === "edit") {
    const row = { comment_id: id, item_id: cur.item_id };
    if (input.text != null) row.text = String(input.text).trim().slice(0, 4000);
    const tg = checkTags(input.tags);
    if (tg.error) return { error: tg.error };
    if (tg.tags) row.tags = tg.tags;
    if (row.text == null && row.tags == null) return { error: "edit needs text or tags" };
    const text = row.text ?? cur.text, tagsNow = row.tags ?? cur.tags;
    if (!text && !(tagsNow && tagsNow.length)) return { error: "a comment needs text or a tag (delete it instead)" };
    if (cur.deleted) row.deleted = false;
    return { row: { ...row, ...base } };
  }
  return { error: `unknown action '${action}' (want create|edit|delete|restore)` };
}

export const appendComment = (taskDir, reviewer, row) => appendRows(commentFile(taskDir, reviewer), [row]);

// Which model sits behind a variant letter on this item. `hidden.letters`
// ({A: "v4", B: "prod"}) wins; otherwise a model whose verdict_path value is the
// letter (the hidden.<model>_letter convention). Returns Map<letter, model id>.
export function letterModels(task, item) {
  const out = new Map();
  const h = item && item.hidden;
  if (h && h.letters && typeof h.letters === "object" && !Array.isArray(h.letters)) {
    for (const [k, v] of Object.entries(h.letters)) if (v != null) out.set(String(k), String(v));
  }
  if (!out.size) {
    for (const m of task.models || []) {
      const v = getPath(item, m.verdict_path);
      if (typeof v === "string" && /^[A-Za-z0-9]{1,3}$/.test(v) && task.labels.some((l) => l.id === v)) out.set(v, m.id);
    }
  }
  return out;
}

// The variant letter an anchor names, or null: "A", "Variant A", "Version B:",
// "Option C" -> the letter. Anchors like "seg:3" or "Summary" are not variants.
export function anchorLetter(anchor) {
  const m = /^(?:(?:variant|version|option|notes|draft)\s+)?([A-Z0-9]{1,3})\s*[:.)]?$/i.exec(String(anchor || "").trim());
  return m ? m[1].toUpperCase() : null;
}

// Comments grouped by model (or anchor) and tag, with counts, for Results and
// the CLI. `revealed(itemId)` says whether this item's letters may be unblinded
// (blind tasks: only after the reviewer labeled it).
export function commentSummary({ task, items, comments, revealed = () => true }) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const tagIds = (task.comment_tags || []).map((t) => t.id);
  const groups = new Map();
  const group = (key, kind) => {
    if (!groups.has(key)) groups.set(key, { key, kind, total: 0, tags: {}, untagged: 0, items: new Set(), comments: [] });
    return groups.get(key);
  };
  const tagTotals = {};
  for (const c of comments) {
    const it = byId.get(c.item_id);
    const letter = anchorLetter(c.anchor);
    let key, kind;
    const lm = it ? letterModels(task, it) : new Map();
    if (letter && it && (lm.has(letter) || task.labels.some((l) => l.id === letter))) {
      if (!revealed(c.item_id)) { key = "(blind: label the card first)"; kind = "blind"; }
      else { key = lm.get(letter) || `letter ${letter}`; kind = lm.has(letter) ? "model" : "letter"; }
    } else { key = c.anchor || "(no anchor)"; kind = "anchor"; }
    const g = group(key, kind);
    g.total++;
    g.items.add(c.item_id);
    if (c.tags && c.tags.length) for (const t of c.tags) { g.tags[t] = (g.tags[t] || 0) + 1; tagTotals[t] = (tagTotals[t] || 0) + 1; }
    else g.untagged++;
    g.comments.push({ ...publicComment(c), letter: letter || null, model: kind === "model" ? key : null, title: it?.title || null });
  }
  const order = { model: 0, letter: 1, anchor: 2, blind: 3 };
  const list = [...groups.values()].sort((a, b) => order[a.kind] - order[b.kind] || b.total - a.total || a.key.localeCompare(b.key))
    .map((g) => ({ ...g, items: g.items.size }));
  const usedTags = [...new Set([...tagIds, ...Object.keys(tagTotals)])].filter((t) => tagTotals[t]);
  return { total: comments.length, items: new Set(comments.map((c) => c.item_id)).size, tags: usedTags, tagTotals, groups: list };
}
