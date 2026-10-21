/* decision-mill — pure helpers behind line comments: splitting a markdown body into
   commentable blocks (one per variant or section), naming a block's anchor, and
   finding a quote again inside a block's text. No DOM here, so the same file is a
   plain browser script (global `CommentLogic`) and importable by the tests. */
"use strict";
(() => {

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^\s*(```|~~~)/;

// Plain text of a heading: emphasis, code ticks and links reduced to their text.
function headingText(s) {
  return String(s ?? "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

// Split a markdown body at its top-level headings (the shallowest level used), so
// "## A … ## B … ## C" becomes three blocks anchored "A", "B", "C". Text before
// the first heading is the "intro" block; a body with no headings is one "body"
// block. Headings inside code fences are ignored. Duplicate anchors get " (2)".
function splitSections(body) {
  const lines = String(body ?? "").split("\n");
  let inFence = false;
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = HEADING_RE.exec(lines[i]);
    if (m) heads.push({ line: i, level: m[1].length, text: headingText(m[2]) });
  }
  if (!heads.length) return [{ anchor: "body", md: String(body ?? "") }];
  const top = Math.min(...heads.map((h) => h.level));
  const cuts = heads.filter((h) => h.level === top);
  const out = [];
  const seen = new Map();
  const name = (a) => {
    const base = a || "section";
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  };
  const intro = lines.slice(0, cuts[0].line).join("\n");
  if (intro.trim()) out.push({ anchor: name("intro"), md: intro });
  cuts.forEach((h, i) => {
    const end = i + 1 < cuts.length ? cuts[i + 1].line : lines.length;
    out.push({ anchor: name(h.text), md: lines.slice(h.line, end).join("\n") });
  });
  return out;
}

// The variant letter an anchor names, or null ("A", "Variant B", "Version C:").
// Twin of lib/comments.js anchorLetter.
function anchorLetter(anchor) {
  const m = /^(?:(?:variant|version|option|notes|draft)\s+)?([A-Z0-9]{1,3})\s*[:.)]?$/i.exec(String(anchor || "").trim());
  return m ? m[1].toUpperCase() : null;
}

// Where a stored comment sits in a block's current text: its own offsets when the
// quote is still there, else the occurrence of the quote nearest to them, else
// null (the text changed; the list still shows the comment).
function locateQuote(text, quote, start) {
  const t = String(text ?? ""), q = String(quote ?? "");
  if (!q) return null;
  const s = Number(start);
  if (Number.isInteger(s) && t.slice(s, s + q.length) === q) return { start: s, end: s + q.length };
  let best = null;
  for (let i = t.indexOf(q); i !== -1; i = t.indexOf(q, i + 1)) {
    if (best == null || Math.abs(i - s) < Math.abs(best - s)) best = i;
  }
  if (best == null) {
    // Whitespace can differ between renders; match with runs of spaces collapsed.
    const norm = (x) => x.replace(/\s+/g, " ");
    const nq = norm(q).trim();
    if (!nq) return null;
    const map = [];
    let flat = "";
    for (let i = 0; i < t.length; i++) {
      if (/\s/.test(t[i])) { if (flat.endsWith(" ")) continue; flat += " "; } else flat += t[i];
      map.push(i);
    }
    const j = flat.indexOf(nq);
    if (j === -1) return null;
    return { start: map[j], end: map[j + nq.length - 1] + 1 };
  }
  return { start: best, end: best + q.length };
}

// Trim a selection's offsets so a comment never starts or ends on whitespace.
function trimRange(text, start, end) {
  const t = String(text ?? "");
  let a = Math.max(0, start), b = Math.min(t.length, end);
  while (a < b && /\s/.test(t[a])) a++;
  while (b > a && /\s/.test(t[b - 1])) b--;
  return a < b ? { start: a, end: b, quote: t.slice(a, b) } : null;
}

// The session undo stack holds label ids (strings) and comment actions; this is
// the inverse write for a comment action.
function inverseOf(entry) {
  if (!entry || entry.kind !== "comment") return null;
  if (entry.action === "create") return { action: "delete", comment_id: entry.comment_id };
  if (entry.action === "delete") return { action: "restore", comment_id: entry.comment_id };
  if (entry.action === "edit" && entry.prev) return { action: "edit", comment_id: entry.comment_id, text: entry.prev.text ?? "", tags: entry.prev.tags || [] };
  return null;
}

const api = { splitSections, headingText, anchorLetter, locateQuote, trimRange, inverseOf };
globalThis.CommentLogic = api;
})();
