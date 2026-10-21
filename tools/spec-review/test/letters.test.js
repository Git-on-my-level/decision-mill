// Balanced blind variant letters (lib/letters.js, letters.js) and the
// validate.js checks that come with them and with task purpose fields.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assignLetters, letterBalance } from "../lib/letters.js";
import { tmpdir, TOOL } from "./helpers.js";

const runSync = (script, args, env = {}) => spawnSync(process.execPath, [script, ...args], { cwd: TOOL, encoding: "utf8", env: { ...process.env, DECISION_MILL_HUB: "", ...env } });

test("validate.js warns on missing purpose fields and on imbalanced variant letters", () => {
  const root = tmpdir();
  try {
    const dir = path.join(root, "abc");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "task.yaml"), "labels: [{id: A}, {id: B}, {id: C}]\nmodels:\n  - {id: v4, verdict_path: hidden.v4_letter}\n");
    // v4 is letter A on 3 of 4 cards — the round that motivated the check.
    const L = [{ A: "v4", B: "p", C: "q" }, { A: "v4", B: "q", C: "p" }, { A: "v4", B: "p", C: "q" }, { A: "p", B: "v4", C: "q" }];
    fs.writeFileSync(path.join(dir, "items.jsonl"), L.map((letters, i) => JSON.stringify({ id: `i${i}`, content: { type: "markdown", body: "## A\nx" }, hidden: { letters } })).join("\n") + "\n");
    const v = runSync("validate.js", ["--labels", root], { SPECS_DIR: "" });
    assert.equal(v.status, 0, "warnings only");
    assert.match(v.stdout, /no `decision:`/);
    assert.match(v.stdout, /no `enough_when:`/);
    assert.match(v.stdout, /no `minutes_per_round:`/);
    assert.match(v.stdout, /variant 'v4' letter positions are imbalanced over 4 items \(A 3, B 1, C 0\)/);
    assert.equal(runSync("validate.js", ["--labels", root, "--strict"], { SPECS_DIR: "" }).status, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("assignLetters is a seeded Latin square: balanced, deterministic", () => {
  const ids = Array.from({ length: 7 }, (_, i) => `c${i}`);
  const a = assignLetters(ids, ["prod", "v2", "v4"], { seed: "s1" });
  assert.deepEqual(a, assignLetters(ids, ["prod", "v2", "v4"], { seed: "s1" }), "same seed, same letters");
  for (const r of a) assert.deepEqual(Object.values(r.letters).sort(), ["prod", "v2", "v4"]);
  const b = letterBalance(a, (r) => new Map(Object.entries(r.letters)));
  assert.deepEqual(b.imbalanced, []);
  for (const v of b.variants) assert.ok(v.spread <= 1);
  // Every 3 consecutive cards use every letter once per variant.
  const first3 = letterBalance(a.slice(0, 3), (r) => new Map(Object.entries(r.letters)));
  for (const v of first3.variants) assert.deepEqual(Object.values(v.per), [1, 1, 1]);
  assert.throws(() => assignLetters(ids, ["a", "a"]), /unique/);
  const cli = runSync("letters.js", ["--variants", "x,y", "--count", "4", "--seed", "k"]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim().split("\n").length, 4);
});

