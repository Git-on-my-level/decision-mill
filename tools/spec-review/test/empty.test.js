import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTask, normalizeTask } from "../lib/task.js";

test("an empty or missing items.jsonl is a waiting state, not an error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-"));
  fs.writeFileSync(path.join(dir, "task.yaml"), "title: T\nlabels: [{id: a}]\npending: |\n  Run `fetch.sh` on the build host.\n");
  let t = loadTask(dir, "t");
  assert.deepEqual(t.errors, []);
  assert.equal(t.empty, true);
  assert.match(t.task.pending, /fetch\.sh/);
  fs.writeFileSync(path.join(dir, "items.jsonl"), "\n");
  t = loadTask(dir, "t");
  assert.deepEqual(t.errors, []);
  assert.equal(t.empty, true);
  fs.writeFileSync(path.join(dir, "items.jsonl"), '{"id":"x","content":{"type":"text","body":"b"}}\n');
  t = loadTask(dir, "t");
  assert.equal(t.empty, false);
});

test("pending must be a string", () => {
  const { task, warnings } = normalizeTask({ labels: [{ id: "a" }], pending: 3 }, "x");
  assert.equal(task.pending, "");
  assert.ok(warnings.some((w) => /pending must be a markdown string/.test(w)));
});
