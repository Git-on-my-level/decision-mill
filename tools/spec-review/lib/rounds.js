// The round sampler: split a task's items into rounds of `round_size`, each one
// stratified across `stratum`, deterministically.
//
// Determinism is what makes rounds resumable without storing anything: the order
// is a pure function of (task id, item ids, strata), so a restarted server, a
// second browser and the labels CLI all agree on what "round 3" contains, and the
// current round is simply the first one with an unlabeled item.
//
// Items may pin themselves to a round with an explicit `round` field (a builder
// that hand-picks hard cases for round 1 does this). Pinned rounds come first, in
// numeric order; unpinned items are sampled into the rounds after them.

// FNV-1a, 32-bit. Stable across runtimes; good enough to shuffle by.
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const stratumOf = (it) => (it.stratum == null || it.stratum === "" ? "(none)" : String(it.stratum));

// Order items so that every contiguous window is spread across strata.
//  balanced:     round-robin over strata — equal representation per round until a
//                stratum runs out (covers a model's whole score range early).
//  proportional: each stratum appears in proportion to its size (unbiased rates).
export function orderItems(items, { seed = "", stratify = "balanced" } = {}) {
  const groups = new Map();
  for (const it of items) {
    const s = stratumOf(it);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(it);
  }
  const keys = [...groups.keys()].sort();
  for (const k of keys) groups.get(k).sort((a, b) => hash32(`${seed}|${a.id}`) - hash32(`${seed}|${b.id}`) || (a.id < b.id ? -1 : 1));
  // Rotate the starting stratum by seed so two tasks over the same strata do not
  // always open on the alphabetically first one.
  const start = keys.length ? hash32(seed) % keys.length : 0;
  const ring = [...keys.slice(start), ...keys.slice(0, start)];
  const out = [];
  const taken = new Map(ring.map((k) => [k, 0]));
  if (stratify === "proportional") {
    const total = items.length;
    for (let step = 1; step <= total; step++) {
      let best = null, bestDeficit = -Infinity;
      for (const k of ring) {
        const g = groups.get(k);
        if (taken.get(k) >= g.length) continue;
        const deficit = (g.length / total) * step - taken.get(k);
        if (deficit > bestDeficit + 1e-12) { best = k; bestDeficit = deficit; }
      }
      out.push(groups.get(best)[taken.get(best)]);
      taken.set(best, taken.get(best) + 1);
    }
    return out;
  }
  while (out.length < items.length) {
    for (const k of ring) {
      const g = groups.get(k);
      const n = taken.get(k);
      if (n < g.length) { out.push(g[n]); taken.set(k, n + 1); }
    }
  }
  return out;
}

// -> [{ n: 1-based, ids: [...], pinned: bool, strata: {stratum: count} }]
export function buildRounds(items, task) {
  const size = task.round_size || 40;
  const pinned = new Map();
  const free = [];
  for (const it of items) {
    if (it.round != null && it.round !== "" && Number.isFinite(Number(it.round))) {
      const r = Number(it.round);
      if (!pinned.has(r)) pinned.set(r, []);
      pinned.get(r).push(it);
    } else free.push(it);
  }
  const rounds = [];
  const push = (list, isPinned) => {
    const strata = {};
    for (const it of list) strata[stratumOf(it)] = (strata[stratumOf(it)] || 0) + 1;
    rounds.push({ n: rounds.length + 1, ids: list.map((it) => it.id), pinned: isPinned, strata });
  };
  for (const r of [...pinned.keys()].sort((a, b) => a - b)) {
    // A pinned round keeps file order: whoever pinned it chose the sequence.
    push(pinned.get(r), true);
  }
  const ordered = orderItems(free, { seed: task.id, stratify: task.stratify });
  for (let i = 0; i < ordered.length; i += size) push(ordered.slice(i, i + size), false);
  return rounds;
}

// Index of the first round that still has an unlabeled item; rounds.length when
// everything is labeled.
export function currentRound(rounds, labeledIds) {
  const has = labeledIds instanceof Set ? (id) => labeledIds.has(id) : labeledIds instanceof Map ? (id) => labeledIds.has(id) : () => false;
  const i = rounds.findIndex((r) => r.ids.some((id) => !has(id)));
  return i === -1 ? rounds.length : i;
}
