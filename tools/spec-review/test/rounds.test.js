import test from "node:test";
import assert from "node:assert/strict";
import { buildRounds, currentRound, orderItems } from "../lib/rounds.js";

const mk = (counts) => Object.entries(counts).flatMap(([s, n]) => Array.from({ length: n }, (_, i) => ({ id: `${s}-${i}`, stratum: s })));

test("balanced rounds spread every round across strata", () => {
  const items = mk({ low: 30, mid: 30, high: 30 });
  const rounds = buildRounds(items, { id: "t", round_size: 21, stratify: "balanced" });
  assert.equal(rounds.length, 5);
  assert.deepEqual(rounds[0].strata, { low: 7, mid: 7, high: 7 });
  assert.equal(new Set(rounds.flatMap((r) => r.ids)).size, 90, "each item in exactly one round");
});

test("balanced keeps covering small strata early", () => {
  const items = mk({ big: 100, small: 6 });
  const r = buildRounds(items, { id: "t", round_size: 12, stratify: "balanced" });
  assert.equal(r[0].strata.small, 6);
  assert.equal(r[1].strata.small, undefined);
});

test("proportional mirrors stratum sizes", () => {
  const items = mk({ big: 80, small: 20 });
  const r = buildRounds(items, { id: "t", round_size: 20, stratify: "proportional" });
  for (const rd of r) assert.deepEqual(rd.strata, { big: 16, small: 4 });
});

test("deterministic: same input, same rounds; input order does not matter", () => {
  const items = mk({ a: 9, b: 9, c: 4 });
  const t = { id: "task-x", round_size: 5, stratify: "balanced" };
  const one = buildRounds(items, t).map((r) => r.ids);
  const two = buildRounds([...items].reverse(), t).map((r) => r.ids);
  assert.deepEqual(one, two);
  const other = buildRounds(items, { ...t, id: "task-y" }).map((r) => r.ids);
  assert.notDeepEqual(one, other, "the seed is the task id");
});

test("explicit round pins come first, in file order", () => {
  const items = [{ id: "p2", round: 2 }, { id: "f1" }, { id: "p1a", round: 1 }, { id: "p1b", round: 1 }, { id: "f2" }];
  const r = buildRounds(items, { id: "t", round_size: 10 });
  assert.deepEqual(r[0].ids, ["p1a", "p1b"]);
  assert.deepEqual(r[1].ids, ["p2"]);
  assert.equal(r[2].pinned, false);
  assert.deepEqual([...r[2].ids].sort(), ["f1", "f2"]);
});

test("current round resumes at the first round with an unlabeled item", () => {
  const items = mk({ s: 10 });
  const r = buildRounds(items, { id: "t", round_size: 4 });
  assert.equal(currentRound(r, new Set()), 0);
  assert.equal(currentRound(r, new Set(r[0].ids)), 1);
  assert.equal(currentRound(r, new Set([...r[0].ids, ...r[1].ids.slice(1)])), 1);
  assert.equal(currentRound(r, new Set(items.map((i) => i.id))), r.length);
});

test("items without a stratum still get ordered", () => {
  assert.equal(orderItems([{ id: "a" }, { id: "b" }], { seed: "s" }).length, 2);
});
