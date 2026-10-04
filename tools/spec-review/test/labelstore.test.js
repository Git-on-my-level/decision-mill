import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "./helpers.js";
import { foldRows, readRows, appendRow, appendRows, reviewerFile, safeReviewer, buildRow, readTaskLabels } from "../lib/labelstore.js";
import { normalizeTask } from "../lib/task.js";

const { task } = normalizeTask({
  labels: [{ id: "keep", key: "1" }, { id: "noise", key: "2" }],
  fields: [{ id: "wants_memory", type: "checkbox", key: "m" }, { id: "kind", type: "choice", options: ["a", "b"] }],
}, "t");

test("latest row wins; undo clears; note-only rows keep the label", () => {
  const s = foldRows([
    { item_id: "a", label: "keep", fields: { wants_memory: true }, at: "1" },
    { item_id: "a", label: "noise", at: "2" },
    { item_id: "b", label: "keep", at: "3" },
    { item_id: "b", label: null, at: "4" },
    { item_id: "c", label: "keep", at: "5" },
    { item_id: "c", note: "context matters" },
    { item_id: "c", fields: { wants_memory: true } },
  ]);
  assert.equal(s.get("a").label, "noise");
  assert.deepEqual(s.get("a").fields, {}, "a verdict row carries the full field set");
  assert.equal(s.get("b").label, null);
  assert.equal(s.get("c").label, "keep");
  assert.equal(s.get("c").note, "context matters");
  assert.deepEqual(s.get("c").fields, { wants_memory: true });
});

test("torn and malformed lines are skipped, never fatal", () => {
  const dir = tmpdir();
  const f = path.join(dir, "r.jsonl");
  fs.writeFileSync(f, '{"item_id":"a","label":"keep"}\nnot json\n{"no_item":1}\n{"item_id":"b","lab');
  const { rows, bad } = readRows(f);
  assert.equal(rows.length, 1);
  assert.equal(bad, 3);
});

test("reviewer names cannot escape labels/", () => {
  assert.equal(safeReviewer("../../etc/passwd"), "_.._.._etc_passwd");
  assert.equal(safeReviewer("david@example.com"), "david@example.com");
  assert.equal(safeReviewer(""), "reviewer");
  assert.ok(reviewerFile("/x/task", "../evil").startsWith("/x/task/labels/"));
});

test("buildRow validates against the task", () => {
  const ids = new Set(["a"]);
  const ctx = { task, itemIds: ids, reviewer: "me" };
  assert.match(buildRow({ item_id: "z", label: "keep" }, ctx).error, /unknown item_id/);
  assert.match(buildRow({ item_id: "a", label: "maybe" }, ctx).error, /unknown label/);
  assert.match(buildRow({ item_id: "a", label: "keep", fields: { nope: 1 } }, ctx).error, /unknown field/);
  assert.match(buildRow({ item_id: "a", label: "keep", fields: { kind: "c" } }, ctx).error, /unknown option/);
  assert.match(buildRow({ item_id: "a" }, ctx).error, /needs a label/);
  assert.match(buildRow({ item_id: "a", label: "keep", source: "oracle" }, ctx).error, /source/);
  const ok = buildRow({ item_id: "a", label: "unsure", fields: { wants_memory: 1 }, note: "hm" }, ctx).row;
  assert.equal(ok.label, "unsure", "Unsure is always a legal label");
  assert.equal(ok.fields.wants_memory, true);
  assert.equal(ok.source, "human");
  assert.ok(ok.at);
  const st = buildRow({ item_id: "a", label: "keep", confidence: 0.8, rationale: "r" }, { ...ctx, source: "model-standin" }).row;
  assert.equal(st.source, "model-standin");
  assert.equal(st.confidence, 0.8);
  assert.equal(buildRow({ item_id: "a", label: null }, ctx).row.label, null);
});

test("concurrent appends never interleave or drop rows", async () => {
  const dir = tmpdir();
  const f = reviewerFile(dir, "me");
  const N = 300;
  await Promise.all(Array.from({ length: N }, (_, i) =>
    i % 3 === 0 ? appendRows(f, [{ item_id: `x${i}`, label: "keep" }, { item_id: `x${i}`, label: "noise" }])
      : appendRow(f, { item_id: `x${i}`, label: "keep", note: "n".repeat(i * 7) })));
  const text = fs.readFileSync(f, "utf8");
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, N + N / 3);
  for (const l of lines) JSON.parse(l); // every line is whole
  const { reviewers } = readTaskLabels(dir);
  assert.equal(reviewers.me.states.size, N);
  assert.equal(reviewers.me.states.get("x0").label, "noise", "within one batch, the later row wins");
});
