/* decision-mill — pure helpers for the `proposal` content type: inline diffs,
   highlight ranges and policy sentence splitting. No DOM here, so the same file
   is a plain browser script (global `ProposalDiff`) and importable by the tests. */
"use strict";
(() => {

// Tokens: numbers, runs of letters/digits (one token per word), every CJK/kana/hangul
// character on its own (those scripts have no spaces between words), each
// whitespace run, and each other character (punctuation) on its own.
// Numbers keep their separators (10:05:01, 3.5, 2026-09-10) so a time or a
// date changes as a whole, not digit by digit.
const TOKEN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|\p{N}+(?:[:.,/-]\p{N}+)*|[\p{L}\p{N}\p{M}_'’-]+|\s+|[^]/gu;
const CJK_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
const WORD_RE = /^[\p{L}\p{N}\p{M}_'’-]+$/u;

function tokenize(s) {
  return String(s ?? "").match(TOKEN_RE) || [];
}

// Longest common subsequence over two arrays, as eq/del/ins ops. Common prefix
// and suffix are trimmed first; a middle too large for the O(n·m) table becomes
// one del + one ins rather than a slow page.
const MAX_CELLS = 4_000_000;
function lcsOps(a, b, same = (x, y) => x === y) {
  let pre = 0;
  while (pre < a.length && pre < b.length && same(a[pre], b[pre])) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && same(a[a.length - 1 - suf], b[b.length - 1 - suf])) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push(["eq", a[i]]);
  if (A.length && B.length && A.length * B.length <= MAX_CELLS) {
    const n = A.length, m = B.length, w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = same(A[i], B[j]) ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (same(A[i], B[j])) { ops.push(["eq", A[i]]); i++; j++; }
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) ops.push(["del", A[i++]]);
      else ops.push(["ins", B[j++]]);
    }
    while (i < n) ops.push(["del", A[i++]]);
    while (j < m) ops.push(["ins", B[j++]]);
  } else {
    for (const x of A) ops.push(["del", x]);
    for (const x of B) ops.push(["ins", x]);
  }
  for (let i = a.length - suf; i < a.length; i++) ops.push(["eq", a[i]]);
  return ops;
}

// Merge ops into runs: [{op, text}], each change region as all its deletions
// then all its insertions, so a replaced phrase reads as one struck phrase and
// one new phrase. A lone space (or punctuation-free whitespace) between two
// changes joins them, which keeps "a b c → x y z" from turning into confetti.
function toRuns(ops) {
  const regions = [];   // [{eq: text} | {del: [], ins: []}]
  for (const [op, tok] of ops) {
    const last = regions[regions.length - 1];
    if (op === "eq") {
      if (last && "eq" in last) last.eq += tok; else regions.push({ eq: tok });
    } else {
      const r = last && !("eq" in last) ? last : (regions.push({ del: [], ins: [] }), regions[regions.length - 1]);
      r[op].push(tok);
    }
  }
  // Absorb whitespace-only equal runs sandwiched between two change regions.
  for (let i = 1; i < regions.length - 1; i++) {
    const r = regions[i];
    if ("eq" in r && /^\s+$/.test(r.eq) && !("eq" in regions[i - 1]) && !("eq" in regions[i + 1])) {
      const prev = regions[i - 1], next = regions[i + 1];
      prev.del.push(r.eq, ...next.del);
      prev.ins.push(r.eq, ...next.ins);
      regions.splice(i, 2);
      i--;
    }
  }
  const runs = [];
  for (const r of regions) {
    if ("eq" in r) runs.push({ op: "eq", text: r.eq });
    else {
      if (r.del.length) runs.push({ op: "del", text: r.del.join("") });
      if (r.ins.length) runs.push({ op: "ins", text: r.ins.join("") });
    }
  }
  return runs;
}

// Character-level diff of two short strings, as runs.
function diffChars(a, b) {
  return toRunsChars(lcsOps(Array.from(String(a ?? "")), Array.from(String(b ?? ""))));
}
function toRunsChars(ops) {
  const runs = [];
  for (const [op, ch] of ops) {
    const last = runs[runs.length - 1];
    if (last && last.op === op) last.text += ch; else runs.push({ op, text: ch });
  }
  return runs;
}

// 0..1: how much of two strings survives (Dice coefficient over characters).
function similarity(a, b) {
  const A = Array.from(a), B = Array.from(b);
  if (!A.length && !B.length) return 1;
  const kept = lcsOps(A, B).filter(([op]) => op === "eq").length;
  return (2 * kept) / (A.length + B.length);
}

// Word-level diff. Returns runs [{op: "eq"|"del"|"ins"|"chg", text, parts?}].
// A one-word replacement that is mostly the same word (a spelling change) comes
// back as one `chg` run whose `parts` are a character diff: Mirex[ah→u].
function diffWords(before, after) {
  const a = String(before ?? ""), b = String(after ?? "");
  const runs = toRuns(lcsOps(tokenize(a), tokenize(b)));
  const out = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i], n = runs[i + 1];
    if (r.op === "del" && n?.op === "ins" && isSpelling(r.text, n.text)) {
      out.push({ op: "chg", text: n.text, from: r.text, parts: diffChars(r.text, n.text) });
      i++;
    } else out.push(r);
  }
  return out;
}
function isSpelling(x, y) {
  if (!WORD_RE.test(x) || !WORD_RE.test(y) || CJK_RE.test(x) || CJK_RE.test(y)) return false;
  if (!/\p{L}/u.test(x) || !/\p{L}/u.test(y)) return false;   // numbers and dates change whole
  if (x.toLowerCase() === y.toLowerCase()) return true;
  // Same word respelled: the shared start and end cover most of it (Mirexah →
  // Mirexu, colour → color), unlike two different words (Friday → Thursday).
  const a = Array.from(x.toLowerCase()), b = Array.from(y.toLowerCase());
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return Math.max(a.length, b.length) >= 3 && (pre + suf) / Math.max(a.length, b.length) >= 0.5 && similarity(x, y) >= 0.5;
}

// How much of `before` the diff kept, by characters (0..1). Below ~0.3 an inline
// diff is noise; show the old value struck and the new one whole.
function keptShare(runs, before, after) {
  const total = Array.from(String(before ?? "")).length + Array.from(String(after ?? "")).length;
  if (!total) return 1;
  let kept = 0;
  for (const r of runs) {
    if (r.op === "eq" && /\S/.test(r.text)) kept += 2 * Array.from(r.text).length;
    if (r.op === "chg") for (const p of r.parts) if (p.op === "eq") kept += 2 * Array.from(p.text).length;
  }
  return kept / total;
}

// Split runs into the two sides of a one-line "before → after" view: the before
// side keeps eq + del (+ the old half of a chg), the after side eq + ins.
function sides(runs) {
  const before = [], after = [];
  for (const r of runs) {
    if (r.op === "eq") { before.push(r); after.push(r); }
    else if (r.op === "del") before.push(r);
    else if (r.op === "ins") after.push(r);
    else if (r.op === "chg") {
      before.push(...r.parts.filter((p) => p.op !== "ins"));
      after.push(...r.parts.filter((p) => p.op !== "del"));
    }
  }
  const merge = (xs) => xs.reduce((acc, x) => {
    const last = acc[acc.length - 1];
    if (last && last.op === x.op) last.text += x.text; else acc.push({ op: x.op, text: x.text });
    return acc;
  }, []);
  return { before: merge(before), after: merge(after) };
}

// Find every case-insensitive occurrence of each term in text. Longer terms win
// where two overlap. Returns sorted, non-overlapping [{start, end, term, index}].
function highlightRanges(text, terms) {
  const s = String(text ?? "");
  const low = s.toLowerCase();
  const list = (terms || []).map((t, index) => ({ t: typeof t === "string" ? t : String(t?.text ?? ""), index }))
    .filter((x) => x.t.trim().length >= 2)
    .sort((x, y) => y.t.length - x.t.length);
  const taken = [];
  for (const { t, index } of list) {
    const needle = t.toLowerCase();
    for (let at = low.indexOf(needle); at !== -1; at = low.indexOf(needle, at + needle.length)) {
      const end = at + needle.length;
      if (!taken.some((r) => at < r.end && end > r.start)) taken.push({ start: at, end, term: t, index });
    }
  }
  return taken.sort((x, y) => x.start - y.start);
}

// Long rules text → one rule per sentence. Abbreviations (e.g., i.e., vs.) and
// decimals do not end a sentence; CJK full stops do, without a following space.
const ABBR = /(?:\b(?:e\.g|i\.e|etc|vs|cf|approx|incl|Mr|Mrs|Ms|Dr|No|St))\.$/i;
function splitSentences(text) {
  if (Array.isArray(text)) return text.map((x) => String(x ?? "").trim()).filter(Boolean);
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return [];
  const out = [];
  let start = 0;
  const re = /[.!?](?=\s+["'(\[]?[\p{Lu}\p{Lo}\p{N}])|[。！？](?=.)/gu;
  for (let m; (m = re.exec(s));) {
    const end = m.index + m[0].length;
    const piece = s.slice(start, end);
    if (/[.]$/.test(piece) && ABBR.test(piece)) continue;
    out.push(piece.trim());
    start = end;
  }
  const rest = s.slice(start).trim();
  if (rest) out.push(rest);
  // A leading "Heading: first rule" stays one rule; that is fine and readable.
  return out.filter(Boolean);
}

// Compact display of any value: strings as-is, null/undefined/"" as null (the
// caller shows "(new)" / "(removed)" / "—"), everything else as JSON.
function display(v) {
  if (v == null || v === "") return null;
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
function sameValue(a, b) {
  return (display(a) ?? "") === (display(b) ?? "");
}

const api = { tokenize, diffWords, diffChars, similarity, keptShare, sides, highlightRanges, splitSentences, display, sameValue };
globalThis.ProposalDiff = api;
})();
