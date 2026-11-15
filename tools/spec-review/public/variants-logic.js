/* decision-mill — pure helpers for the `variants` content type (versions of the
   same thing side by side): tokenize each text, align it with every other
   version by longest common subsequence, and mark the tokens that fewer than half
   of the other versions support. No DOM here, so the same file is a plain browser
   script (global `VariantsLogic`) and importable by the tests. */
"use strict";
(() => {

// Scripts written without spaces: one token per character, so "a different
// word" can be pinned down instead of flagging a whole sentence.
const SPACELESS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const PIECE = /([\p{L}\p{N}\p{M}]+(?:['’][\p{L}]+)?)|([^\p{L}\p{N}\p{M}]+)/gu;

const norm = (s) => String(s).normalize("NFKC").toLowerCase();

// Split a text into pieces that concatenate back to the original. Word pieces
// carry `key` (the compared form); the rest (spaces, punctuation) have none.
function tokenize(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(PIECE)) {
    if (!m[1]) { out.push({ text: m[2], key: null }); continue; }
    if (SPACELESS.test(m[1])) {
      for (const ch of m[1]) out.push({ text: ch, key: norm(ch) });
    } else out.push({ text: m[1], key: norm(m[1]) });
  }
  return out;
}

// Longest common subsequence of two key arrays; returns the matched index pairs.
function lcsPairs(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return [];
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}

// For each variant: its pieces, each word piece flagged `odd` when fewer than
// half of the other variants (rounded up: with one other, that one) say it at
// that point; plus `same`, the ids of variants with exactly the same words.
// A one-word-per-version disagreement therefore shows on the minority only.
function analyze(variants) {
  const toks = variants.map((v) => tokenize(v.text));
  const keys = toks.map((t) => t.filter((p) => p.key != null).map((p) => p.key));
  const support = keys.map((k) => new Array(k.length).fill(0));
  for (let i = 0; i < variants.length; i++) for (let j = i + 1; j < variants.length; j++) {
    for (const [x, y] of lcsPairs(keys[i], keys[j])) { support[i][x]++; support[j][y]++; }
  }
  const others = variants.length - 1;
  return variants.map((v, i) => {
    let k = 0;
    const pieces = toks[i].map((p) => {
      if (p.key == null) return { text: p.text, odd: false };
      const s = support[i][k++];
      return { text: p.text, odd: others > 0 && s * 2 < others };
    });
    const same = variants.filter((_, j) => j !== i && keys[j].length === keys[i].length && keys[j].every((w, x) => w === keys[i][x])).map((x) => x.id);
    return { id: v.id, pieces, words: keys[i].length, odd: pieces.filter((p) => p.odd).length, same };
  });
}

// Merge adjacent pieces of the same kind so a marked phrase is one <mark>.
function runs(pieces) {
  const out = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last && last.odd === p.odd) last.text += p.text;
    else out.push({ text: p.text, odd: p.odd });
  }
  // A lone space or punctuation between two marked runs belongs to the mark.
  for (let i = 1; i < out.length - 1; i++) {
    if (!out[i].odd && out[i - 1].odd && out[i + 1].odd && !/[\p{L}\p{N}]/u.test(out[i].text)) out[i].odd = true;
  }
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && last.odd === r.odd) last.text += r.text; else merged.push({ ...r });
  }
  return merged;
}

const api = { tokenize, lcsPairs, analyze, runs };
globalThis.VariantsLogic = api;
})();
