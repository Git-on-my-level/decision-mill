/* decision-mill — pure helpers for the `pair` content type ("are these two the
   same thing?"): each side's extent on the shared time axis, the overlap, a
   similarity cue, and the merge of both sides into one timeline where lines that
   say the same thing appear once. No DOM here, so the same file is a plain
   browser script (global `PairLogic`) and importable by the tests. */
"use strict";
(() => {

const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const segStart = (s) => num(s && s.start) ?? 0;
const segEnd = (s) => Math.max(segStart(s), num(s && s.end) ?? segStart(s));

// Words for comparing lines: lowercased letters/digits (any script), so
// punctuation, casing and filler spacing never make two lines look different.
function words(text) {
  return String(text ?? "").toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) || [];
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// How alike two lines are, 0..1: word-set Jaccard, or — when one line is a
// fragment of the other (one device split a sentence the other kept whole) —
// the share of the shorter line found in the longer, discounted a little.
function lineScore(a, b) {
  const wa = words(a), wb = words(b);
  if (!wa.length || !wb.length) return 0;
  const j = jaccard(wa, wb);
  const [short, long] = new Set(wa).size <= new Set(wb).size ? [wa, wb] : [wb, wa];
  const S = new Set(short), L = new Set(long);
  if (S.size < 4) return j;
  let hit = 0;
  for (const w of S) if (L.has(w)) hit++;
  return Math.max(j, 0.85 * (hit / S.size));
}

const sideIds = (c) => {
  const ids = (Array.isArray(c && c.sides) ? c.sides : []).map((s) => s && String(s.id)).filter(Boolean);
  for (const s of (c && c.segments) || []) if (s && s.side != null && !ids.includes(String(s.side))) ids.push(String(s.side));
  return ids;
};

// Each side's [start, end] on the shared axis. In order of preference: the
// side's own `start` (axis seconds) + `duration_s`; its `started_at` relative
// to the earliest side + `duration_s`; else the extent of its segments.
function extents(c) {
  const sides = Array.isArray(c && c.sides) ? c.sides : [];
  const segs = Array.isArray(c && c.segments) ? c.segments : [];
  const times = sides.map((s) => Date.parse(s && s.started_at)).filter((t) => Number.isFinite(t));
  const t0 = times.length ? Math.min(...times) : null;
  const out = {};
  for (const id of sideIds(c)) {
    const side = sides.find((s) => s && String(s.id) === id) || {};
    const mine = segs.filter((s) => s && String(s.side) === id);
    const fromSegs = mine.length ? [Math.min(...mine.map(segStart)), Math.max(...mine.map(segEnd))] : null;
    let start = num(side.start);
    if (start == null && t0 != null && Number.isFinite(Date.parse(side.started_at))) start = (Date.parse(side.started_at) - t0) / 1000;
    if (start == null && fromSegs) start = fromSegs[0];
    if (start == null) continue;
    const dur = num(side.duration_s);
    const end = dur != null ? start + dur : fromSegs ? Math.max(fromSegs[1], start) : start;
    out[id] = { start, end };
  }
  return out;
}

// The overlap window: `overlap` when given, else the intersection of the first
// two sides' extents; null when they do not overlap.
function overlapOf(c) {
  const o = c && c.overlap;
  if (o && num(o.start) != null && num(o.end) != null && num(o.end) >= num(o.start)) return { start: num(o.start), end: num(o.end) };
  const ids = sideIds(c);
  const ex = extents(c);
  const [a, b] = [ex[ids[0]], ex[ids[1]]];
  if (!a || !b) return null;
  const start = Math.max(a.start, b.start), end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

const inWindow = (s, win, pad = 0) => segEnd(s) >= win.start - pad && segStart(s) <= win.end + pad;

// Similarity cue inside the overlap window: the share of each side's distinct
// words that the other side also says, and how many speakers each side has.
function similarity(c, win = overlapOf(c)) {
  const ids = sideIds(c);
  const segs = (Array.isArray(c && c.segments) ? c.segments : []).filter((s) => s && String(s.text || "").trim());
  const pick = (id) => segs.filter((s) => String(s.side) === id && (!win || inWindow(s, win)));
  const [sa, sb] = [pick(ids[0]), pick(ids[1])];
  const wa = new Set(sa.flatMap((s) => words(s.text))), wb = new Set(sb.flatMap((s) => words(s.text)));
  const share = (x, y) => (x.size ? [...x].filter((w) => y.has(w)).length / x.size : null);
  const speakers = (list) => new Set(list.map((s) => String(s.speaker ?? s.name ?? "?"))).size;
  const spA = speakers(sa), spB = speakers(sb);
  return {
    sides: [ids[0] ?? null, ids[1] ?? null],
    words: [wa.size, wb.size],
    aInB: share(wa, wb),
    bInA: share(wb, wa),
    speakers: [spA, spB],
    speakersMatch: spA > 0 && spB > 0 ? spA === spB : null,
  };
}

// Both sides as one timeline, in time order. A line from side A and a line from
// side B within `maxGap` seconds whose lineScore is at least `threshold` become
// one row {kind: "both"}; every other line is {kind: "A"|"B"} (its side id).
// Pairing is greedy by best score, so each line is used once.
const MATCH_THRESHOLD = 0.5;
function mergeLines(c, { threshold = MATCH_THRESHOLD, maxGap = 12 } = {}) {
  const ids = sideIds(c);
  const segs = (Array.isArray(c && c.segments) ? c.segments : [])
    .filter((s) => s && String(s.text || "").trim())
    .map((s, i) => ({ s, i }))
    .sort((x, y) => segStart(x.s) - segStart(y.s) || x.i - y.i);
  const A = segs.filter((x) => String(x.s.side) === ids[0]);
  const B = segs.filter((x) => String(x.s.side) === ids[1]);
  const cands = [];
  let lo = 0;
  for (const a of A) {
    const t = segStart(a.s);
    while (lo < B.length && segStart(B[lo].s) < t - maxGap) lo++;
    for (let k = lo; k < B.length && segStart(B[k].s) <= t + maxGap; k++) {
      const score = lineScore(a.s.text, B[k].s.text);
      if (score >= threshold) cands.push({ a, b: B[k], score, gap: Math.abs(segStart(B[k].s) - t) });
    }
  }
  cands.sort((x, y) => y.score - x.score || x.gap - y.gap);
  const usedA = new Set(), usedB = new Set(), rows = [];
  for (const m of cands) {
    if (usedA.has(m.a.i) || usedB.has(m.b.i)) continue;
    usedA.add(m.a.i); usedB.add(m.b.i);
    rows.push({ kind: "both", a: m.a.s, b: m.b.s, start: Math.min(segStart(m.a.s), segStart(m.b.s)), score: m.score });
  }
  for (const x of segs) {
    if (usedA.has(x.i) || usedB.has(x.i)) continue;
    if (String(x.s.side) !== ids[0] && String(x.s.side) !== ids[1]) continue;
    rows.push({ kind: String(x.s.side), seg: x.s, start: segStart(x.s) });
  }
  return rows.sort((x, y) => x.start - y.start);
}

// The rows to show by default: those inside the overlap window ± `pad` seconds,
// as an index range [from, to) into `rows` (everything when there is no window).
function windowRange(rows, win, pad = 60) {
  if (!win) return [0, rows.length];
  const rowEnd = (r) => (r.kind === "both" ? Math.max(segEnd(r.a), segEnd(r.b)) : segEnd(r.seg));
  let from = rows.findIndex((r) => rowEnd(r) >= win.start - pad);
  if (from === -1) return [rows.length, rows.length];
  let to = from;
  while (to < rows.length && rows[to].start <= win.end + pad) to++;
  return [from, to];
}

const api = { words, jaccard, lineScore, sideIds, extents, overlapOf, similarity, mergeLines, windowRange, inWindow, MATCH_THRESHOLD };
globalThis.PairLogic = api;
})();
