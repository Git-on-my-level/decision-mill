/* decision-mill — pure view helpers for the card layout: which notes fold away,
   how a decided item reads as one line, which item "next" means, whether a
   touch gesture was a swipe, and a remembered-disclosure store that survives a
   blocked localStorage. No DOM here, so the same file is a plain browser script
   (global `ViewLogic`) and importable by the tests. */
"use strict";
(() => {

// A note's text, read the way the timeline shows it:
//   "decision: accept — why"  -> { type: "decision", verdict: "accept", rest: "why" }
//   "rec: change — why"       -> { type: "rec", ... }
//   "status: team" / "decision cleared" -> { type: "sys" }
function classifyNote(text) {
  const t = String(text ?? "");
  const m = t.match(/^decision: (\S+)(?: — ([\s\S]+))?$/);
  if (m) return { type: "decision", verdict: m[1], rest: m[2] || "" };
  const r = t.match(/^rec: (\S+)(?: — ([\s\S]+))?$/);
  if (r) return { type: "rec", verdict: r[1], rest: r[2] || "" };
  if (/^status: /.test(t) || t === "decision cleared") return { type: "sys", verdict: null, rest: t };
  return { type: "note", verdict: null, rest: t };
}

// Long histories fold: with more than `max` notes, only the last `keep` stay in
// view and the rest go behind an "N earlier notes" disclosure.
function splitNotes(notes, { keep = 2, max = 3 } = {}) {
  const list = Array.isArray(notes) ? notes.filter((n) => n && typeof n === "object") : [];
  if (list.length <= max) return { earlier: [], recent: list };
  return { earlier: list.slice(0, list.length - keep), recent: list.slice(list.length - keep) };
}

const isDecided = (meta) => Boolean(meta && meta.decision) && (meta.status || "open") === "decided";

// A decided item collapses to one line unless the reviewer expanded it.
function collapsedByDefault(item, expanded) {
  if (!item || item.kind === "general") return false;
  if (expanded && typeof expanded.has === "function" && expanded.has(item.id)) return false;
  return isDecided(item.meta);
}

// The one-line summary of a decided item: its verdict and the reviewer's detail,
// with the FORMAT.md disambiguator ("change: ", "remove: ") dropped for reading.
function decidedSummary(meta) {
  if (!meta || !meta.decision) return null;
  const detail = String(meta.decision_detail ?? "").replace(/^(remove|change|resolved|moot):\s*/, "").replace(/\s+/g, " ").trim();
  return { decision: String(meta.decision), detail, at: meta.decided_at || "" };
}

// The overflow menu's facts: everything the card no longer shows up front.
function itemFacts(it, kindLabel = {}) {
  const meta = (it && it.meta) || {};
  const out = [];
  if (it && it.kind) out.push(["kind", kindLabel[it.kind] ? `${kindLabel[it.kind]} · ${it.kind}` : it.kind]);
  if (meta.proposed && meta.proposed !== "n/a") out.push(["proposed", meta.proposed === "toss" ? "change" : String(meta.proposed)]);
  if (meta.confidence) out.push(["confidence", String(meta.confidence)]);
  out.push(["status", String(meta.status || "open")]);
  if (meta.decided_at) out.push(["decided", String(meta.decided_at)]);
  return out;
}

// Index of the item `delta` steps from `cur` in `ids` (clamped; -1 cur = none
// focused yet, so +1 lands on the first and -1 on the last).
function stepIndex(length, cur, delta) {
  if (!length) return -1;
  if (cur < 0) return delta > 0 ? 0 : length - 1;
  return Math.min(length - 1, Math.max(0, cur + delta));
}

// After a verdict, the next item still waiting for one: forward first, then
// wrapping around. `pending(id)` says whether an id still needs a decision.
function nextPending(ids, fromId, pending) {
  const i = ids.indexOf(fromId);
  const order = i === -1 ? ids : [...ids.slice(i + 1), ...ids.slice(0, i)];
  return order.find((id) => pending(id)) ?? null;
}

// A horizontal swipe: long enough, and clearly more sideways than vertical, so a
// slightly diagonal scroll never flips the card. -1 = previous, 1 = next, 0 = none.
function swipeDirection(dx, dy, { min = 70, ratio = 2 } = {}) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
  if (Math.abs(dx) < min || Math.abs(dx) < ratio * Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}

// Remembered open/closed state for a kind of disclosure ("sources", "notes"),
// per browser. Storage may be missing or throw (private mode, blocked site
// data); the default wins then and nothing breaks.
function disclosureStore(storage, prefix = "dm:disc:") {
  return {
    get(key, dflt = false) {
      try {
        const v = storage && storage.getItem(prefix + key);
        return v == null ? dflt : v === "1";
      } catch { return dflt; }
    },
    set(key, open) {
      try { if (storage) storage.setItem(prefix + key, open ? "1" : "0"); } catch { /* blocked */ }
    },
  };
}

// Auto-growing one-line textarea: the height for a given content height.
const growHeight = (scrollHeight, { min = 0, max = 200 } = {}) => Math.max(min, Math.min(max, Math.ceil(scrollHeight)));

const api = { classifyNote, splitNotes, isDecided, collapsedByDefault, decidedSummary, itemFacts, stepIndex, nextPending, swipeDirection, disclosureStore, growHeight };
globalThis.ViewLogic = api;
})();
