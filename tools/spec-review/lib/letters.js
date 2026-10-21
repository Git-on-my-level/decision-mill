// Variant letters for blind A/B/C rounds, balanced by position.
//
// When each card shows several variants (three versions of the same notes) under
// letters, the letters must not leak which variant is which, and no variant may
// sit in one position more than the others: people favour A, or the last one
// read. An independent shuffle per card does not guarantee that — in a real
// 4-card round one variant was letter A on 3 of the 4 cards. A seeded Latin
// square does: card i uses rotation (offset + i) mod k of one seeded base order,
// so over every k consecutive cards each variant takes each letter exactly once,
// and over any number of cards the counts differ by at most one.
//
//   import { assignLetters } from "./lib/letters.js";
//   assignLetters(["c1", "c2", "c3"], ["prod", "v2", "v4"], { seed: "my-task" })
//   // -> [{item_id: "c1", letters: {A: "v4", B: "prod", C: "v2"}}, …]
//
// Put the result in each item's `hidden.letters` (and, if Results should compare
// the variants as models, `hidden.<variant>_letter`). `node letters.js` is the CLI.

import { hash32 } from "./rounds.js";

export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Deterministic Fisher–Yates driven by a seeded LCG.
function seededShuffle(list, seed) {
  const out = [...list];
  let x = hash32(String(seed)) || 1;
  const rand = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function assignLetters(itemIds, variants, { seed = "", letters = LETTERS } = {}) {
  const k = variants.length;
  if (!k) throw new Error("assignLetters: no variants");
  if (k > letters.length) throw new Error(`assignLetters: at most ${letters.length} variants`);
  if (new Set(variants).size !== k) throw new Error("assignLetters: variant names must be unique");
  const base = seededShuffle(variants, `${seed}|order`);
  const offset = hash32(`${seed}|offset`) % k;
  return itemIds.map((id, i) => {
    const r = (offset + i) % k;
    const map = {};
    for (let p = 0; p < k; p++) map[letters[p]] = base[(p + r) % k];
    return { item_id: id, letters: map };
  });
}

// For validate.js: how often each variant sits under each letter across a task's
// items. `lettersOf(item)` returns Map<letter, variant>. Imbalanced = a variant's
// most- and least-used letters differ by more than 1.
export function letterBalance(items, lettersOf) {
  const counts = new Map(); // variant -> Map<letter, n>
  const letterSet = new Set();
  let n = 0;
  for (const it of items) {
    const m = lettersOf(it);
    if (!m || m.size < 2) continue;
    n++;
    for (const [letter, variant] of m) {
      letterSet.add(letter);
      if (!counts.has(variant)) counts.set(variant, new Map());
      const c = counts.get(variant);
      c.set(letter, (c.get(letter) || 0) + 1);
    }
  }
  const letters = [...letterSet].sort();
  const variants = [...counts.keys()].sort().map((v) => {
    const c = counts.get(v);
    const per = Object.fromEntries(letters.map((l) => [l, c.get(l) || 0]));
    const vals = Object.values(per);
    return { variant: v, per, spread: Math.max(...vals) - Math.min(...vals) };
  });
  return { items: n, letters, variants, imbalanced: variants.filter((v) => v.spread > 1) };
}
