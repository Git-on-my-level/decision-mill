import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { normalizeTask, parseItems, loadTask, discoverTasks } from "../lib/task.js";
import { REPO } from "./helpers.js";

test("Unsure is always added, keys fill in, blind defaults on", () => {
  const { task, errors } = normalizeTask({ labels: [{ id: "useful" }, { id: "neutral" }, { id: "annoying" }] }, "x");
  assert.deepEqual(errors, []);
  assert.deepEqual(task.labels.map((l) => [l.id, l.key]), [["useful", "1"], ["neutral", "2"], ["annoying", "3"], ["unsure", "4"]]);
  assert.equal(task.labels[3].abstain, true);
  assert.equal(task.blind, true);
  assert.equal(task.round_size, 40);
});

test("reserved and duplicate keys are errors", () => {
  const { errors } = normalizeTask({ labels: [{ id: "a", key: "j" }, { id: "b", key: "1" }, { id: "c", key: "1" }], fields: [{ id: "f", key: "u" }] }, "x");
  assert.ok(errors.some((e) => /reserved key 'j'/.test(e)));
  assert.ok(errors.some((e) => /bound twice/.test(e)));
  assert.ok(errors.some((e) => /field 'f' uses reserved key 'u'/.test(e)));
});

test("items: duplicates and bad JSON are errors with line numbers; drift is a warning", () => {
  const { task } = normalizeTask({ labels: [{ id: "keep" }], models: [{ id: "m", verdict_path: "hidden.m.v" }] }, "x");
  const text = ['{"id":"a","content":{"type":"text","body":"x"}}', '{"id":"a"}', "nope", '{"id":"b","content":{"type":"video"},"hidden":{"m":{"v":"maybe"}},"media":[{"src":"../x"}]}'].join("\n");
  const r = parseItems(text, task);
  assert.equal(r.items.length, 2);
  assert.ok(r.errors.some((e) => /line 2: duplicate id/.test(e)));
  assert.ok(r.errors.some((e) => /line 3: invalid JSON/.test(e)));
  assert.ok(r.warnings.some((e) => /unknown content.type/.test(e)));
  assert.ok(r.warnings.some((e) => /verdict 'maybe' is not a label id/.test(e)));
  assert.ok(r.warnings.some((e) => /media src/.test(e)));
});

test("the bundled demo task loads clean", () => {
  const [t] = discoverTasks([path.join(REPO, "examples/labels")]);
  assert.equal(t.id, "demo-task");
  const { items, errors, warnings } = loadTask(t.dir, t.id);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(items.length, 12);
});
