// Line comments: the append-only store (lib/comments.js), the browser helpers
// (public/comment-logic.js), the HTTP API, Results grouping, `labels.js comments`
// and the `commented` waits.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildCommentRow, foldComments, letterModels, anchorLetter, commentSummary, normalizeCommentTags, DEFAULT_COMMENT_TAGS } from "../lib/comments.js";
import { normalizeTask, loadTask } from "../lib/task.js";
import { parseUntil } from "../lib/wait.js";
import { labelCondition } from "../lib/label-api.js";
import { copyExamples, startServer, TOOL } from "./helpers.js";

await import("../public/comment-logic.js");
const CL = globalThis.CommentLogic;

function run(script, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: TOOL, env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

const variantTask = () => normalizeTask({
  labels: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "tie" }],
  models: [{ id: "prod", verdict_path: "hidden.prod_letter" }, { id: "v4", verdict_path: "hidden.v4_letter" }],
}, "t").task;

test("comment tags default, can be configured, and bad ones warn", () => {
  assert.deepEqual(normalizeCommentTags(undefined).map((t) => t.id), [...DEFAULT_COMMENT_TAGS]);
  assert.deepEqual(normalizeCommentTags(["names", { id: "tone", label: "Tone" }]), [{ id: "names", label: "names" }, { id: "tone", label: "Tone" }]);
  assert.deepEqual(normalizeCommentTags([]), []);
  const w = [];
  normalizeCommentTags(["ok", "bad tag!", "ok"], w);
  assert.equal(w.length, 2);
  assert.deepEqual(normalizeTask({ labels: [{ id: "a" }], comment_tags: ["x"] }, "t").task.comment_tags, [{ id: "x", label: "x" }]);
});

test("comment rows: create, edit, delete, restore fold latest-wins; only your own change", () => {
  const task = variantTask();
  const ids = new Set(["i1"]);
  const c = buildCommentRow({ item_id: "i1", anchor: "A", quote: "Nik Shevchenko", start: 3, end: 17, text: "didn't name Kory", tags: ["missing"] }, { task, itemIds: ids, reviewer: "david", own: new Map() });
  assert.ok(c.row, c.error);
  assert.equal(c.row.anchor, "A");
  assert.match(c.row.comment_id, /^c-/);
  assert.equal(c.row.source, "human");
  let own = foldComments([c.row]);
  const e = buildCommentRow({ action: "edit", comment_id: c.row.comment_id, text: "missing Kory and Ana" }, { task, reviewer: "david", own });
  const d = buildCommentRow({ action: "delete", comment_id: c.row.comment_id }, { task, reviewer: "david", own });
  const r = buildCommentRow({ action: "restore", comment_id: c.row.comment_id }, { task, reviewer: "david", own });
  own = foldComments([c.row, e.row]);
  assert.equal(own.get(c.row.comment_id).text, "missing Kory and Ana");
  assert.deepEqual(own.get(c.row.comment_id).tags, ["missing"], "an edit without tags keeps them");
  assert.equal(foldComments([c.row, e.row, d.row]).get(c.row.comment_id).deleted, true);
  assert.equal(foldComments([c.row, e.row, d.row, r.row]).get(c.row.comment_id).deleted, false);
  assert.equal(foldComments([c.row, d.row, r.row]).get(c.row.comment_id).quote, "Nik Shevchenko", "delete rows never erase the quote");
  // Someone else's comment, and bad input.
  assert.match(buildCommentRow({ action: "delete", comment_id: c.row.comment_id }, { task, reviewer: "eve", own: new Map() }).error, /only your own/);
  assert.match(buildCommentRow({ item_id: "nope", anchor: "A", quote: "x", start: 0, end: 1, text: "t" }, { task, itemIds: ids, reviewer: "d" }).error, /unknown item_id/);
  assert.match(buildCommentRow({ item_id: "i1", anchor: "A", quote: "x", start: 3, end: 3, text: "t" }, { task, itemIds: ids, reviewer: "d" }).error, /offsets/);
  assert.match(buildCommentRow({ item_id: "i1", anchor: "A", quote: "x", start: 0, end: 1, tags: ["nope"] }, { task, itemIds: ids, reviewer: "d" }).error, /unknown tag 'nope'/);
  assert.match(buildCommentRow({ item_id: "i1", anchor: "A", quote: "x", start: 0, end: 1 }, { task, itemIds: ids, reviewer: "d" }).error, /needs text or a tag/);
  assert.ok(buildCommentRow({ item_id: "i1", anchor: "A", quote: "x", start: 0, end: 1, tags: ["too-long"] }, { task, itemIds: ids, reviewer: "d" }).row, "a tag alone is a comment");
});

test("letters map to models via hidden.letters, else the verdict_path convention", () => {
  const task = variantTask();
  assert.deepEqual([...letterModels(task, { hidden: { letters: { A: "v4", B: "prod" } } })], [["A", "v4"], ["B", "prod"]]);
  assert.deepEqual([...letterModels(task, { hidden: { prod_letter: "C", v4_letter: "A" } })].sort(), [["A", "v4"], ["C", "prod"]]);
  assert.equal(anchorLetter("A"), "A");
  assert.equal(anchorLetter("Variant b"), "B");
  assert.equal(anchorLetter("seg:3"), null);
  assert.equal(anchorLetter("Summary"), null);
});

test("commentSummary groups by model and tag, and keeps unlabeled blind cards blind", () => {
  const task = variantTask();
  const items = [{ id: "i1", hidden: { letters: { A: "v4", B: "prod" } } }, { id: "i2", hidden: { letters: { A: "prod", B: "v4" } } }];
  const cm = (id, item_id, anchor, tags) => ({ comment_id: id, item_id, anchor, quote: "q", start: 0, end: 1, text: "t", tags, rows: 1 });
  const comments = [cm("1", "i1", "A", ["missing"]), cm("2", "i2", "B", ["missing", "wrong-name"]), cm("3", "i2", "A", []), cm("4", "i1", "seg:2", ["too-long"])];
  const s = commentSummary({ task, items, comments, revealed: (id) => id === "i1" || id === "i2" });
  const v4 = s.groups.find((g) => g.key === "v4");
  assert.equal(v4.total, 2);
  assert.equal(v4.items, 2);
  assert.deepEqual(v4.tags, { missing: 2, "wrong-name": 1 });
  assert.equal(s.groups.find((g) => g.key === "prod").untagged, 1);
  assert.equal(s.groups.find((g) => g.key === "seg:2").kind, "anchor");
  assert.equal(s.tagTotals.missing, 2);
  const blind = commentSummary({ task, items, comments, revealed: (id) => id === "i1" });
  assert.equal(blind.groups.find((g) => g.kind === "blind").total, 2, "letters on unlabeled cards are not mapped");
  assert.ok(!blind.groups.some((g) => g.key === "prod" && g.comments.some((c) => c.item_id === "i2")));
});

test("comment-logic: markdown splits at top-level headings; quotes are found again", () => {
  const secs = CL.splitSections("## A\n\nNotes one\n\n### Actions\n- x\n\n## B\n\nNotes two\n\n## B\n\nthree");
  assert.deepEqual(secs.map((s) => s.anchor), ["A", "B", "B (2)"]);
  assert.match(secs[0].md, /### Actions/, "nested headings stay in their variant");
  assert.deepEqual(CL.splitSections("intro\n\n# **Title**\nbody").map((s) => s.anchor), ["intro", "Title"]);
  assert.deepEqual(CL.splitSections("no headings").map((s) => s.anchor), ["body"]);
  assert.deepEqual(CL.splitSections("```\n# not a heading\n```\n## Real").map((s) => s.anchor), ["intro", "Real"]);
  const text = "David met Nik. Nik said hi to Nik.";
  assert.deepEqual(CL.locateQuote(text, "Nik", 10), { start: 10, end: 13 });
  assert.deepEqual(CL.locateQuote(text, "Nik", 31), { start: 30, end: 33 }, "the nearest occurrence when offsets drifted");
  assert.equal(CL.locateQuote(text, "Kory", 0), null);
  assert.deepEqual(CL.locateQuote("a  b\nc", "a b c", 0), { start: 0, end: 6 }, "whitespace-insensitive fallback");
  assert.deepEqual(CL.trimRange("  hello world ", 0, 14), { start: 2, end: 13, quote: "hello world" });
  assert.equal(CL.trimRange("   ", 0, 3), null);
  assert.deepEqual(CL.inverseOf({ kind: "comment", action: "create", comment_id: "c1" }), { action: "delete", comment_id: "c1" });
  assert.deepEqual(CL.inverseOf({ kind: "comment", action: "delete", comment_id: "c1" }), { action: "restore", comment_id: "c1" });
  assert.deepEqual(CL.inverseOf({ kind: "comment", action: "edit", comment_id: "c1", prev: { text: "old", tags: ["x"] } }), { action: "edit", comment_id: "c1", text: "old", tags: ["x"] });
  assert.equal(CL.inverseOf("item-id"), null, "label undo entries are not comments");
});

test("commented waits", () => {
  assert.deepEqual(parseUntil("commented", "label"), { kind: "commented" });
  assert.deepEqual(parseUntil("commented:2", "label"), { kind: "commented>=", n: 2 });
  assert.match(parseUntil("commented", "spec").error, /unknown until/);
  const base = {};
  assert.equal(labelCondition({ kind: "label", comments: 0, commentsEtag: "a" }, { kind: "commented" }, base).done, false);
  assert.equal(labelCondition({ kind: "label", comments: 1, commentsEtag: "b" }, { kind: "commented" }, base).done, true);
  assert.equal(labelCondition({ kind: "label", comments: 1 }, { kind: "commented>=", n: 2 }, {}).done, false);
});

test("HTTP + CLI: comments are created, read back, edited, deleted and restored; Results groups them", async () => {
  const root = copyExamples();
  const srv = await startServer({ LABELS_ROOT: path.join(root, "labels"), SPECS_DIR: "" });
  const T = "/api/task/variants-demo";
  try {
    const item = (await srv.get(`${T}/item/note-01`)).body;
    assert.deepEqual(item.comments, []);
    assert.equal(item.item.hidden, undefined, "still blind");
    const body = item.item.content.body;
    const sec = CL.splitSections(body).find((x) => x.anchor === "A");
    assert.ok(sec);
    // A comment the reviewer could make on letter A.
    let r = await srv.post(`${T}/comment`, { item_id: "note-01", anchor: "A", quote: "Supplier to be called", start: 40, end: 61, text: "no owner, no supplier name", tags: ["missing"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const cid = r.body.comment.comment_id;
    assert.equal(r.body.comments.length, 1);
    assert.equal(r.body.row.reviewer, "reviewer");
    // Attribution cannot be claimed.
    assert.equal((await srv.post(`${T}/comment`, { item_id: "note-01", anchor: "A", quote: "x", start: 0, end: 1, text: "t", reviewer: "someone-else" })).status, 400);
    assert.equal((await srv.post(`${T}/comment`, { item_id: "note-01", anchor: "A", quote: "x", start: 0, end: 1, tags: ["nope"] })).status, 400);
    // Read back three ways: the item, the comments endpoint, the task index.
    assert.equal((await srv.get(`${T}/item/note-01`)).body.comments[0].text, "no owner, no supplier name");
    assert.equal((await srv.get(`${T}/comments`)).body.comments.length, 1);
    assert.equal((await srv.get(`${T}`)).body.index.find((x) => x.id === "note-01").comments, 1);
    // Edit, delete, restore: rows appended, never rewritten.
    r = await srv.post(`${T}/comment`, { action: "edit", comment_id: cid, text: "no owner" });
    assert.equal(r.body.comments[0].text, "no owner");
    assert.equal(r.body.comments[0].edited, true);
    r = await srv.post(`${T}/comment`, { action: "delete", comment_id: cid });
    assert.equal(r.body.comments.length, 0);
    r = await srv.post(`${T}/comment`, { action: "restore", comment_id: cid });
    assert.equal(r.body.comments.length, 1);
    const file = path.join(root, "labels/variants-demo/comments/reviewer.jsonl");
    assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 4, "four append-only rows");
    assert.ok(!fs.existsSync(path.join(root, "labels/variants-demo/labels/reviewer.jsonl")), "comments never land in labels/");
    // Results: blind until the card is labeled, then counted against the model.
    let res = (await srv.get(`${T}/results`)).body;
    assert.equal(res.comments.total, 1);
    assert.equal(res.comments.groups[0].kind, "blind");
    await srv.post(`${T}/label`, { item_id: "note-01", label: "B" });
    res = (await srv.get(`${T}/results`)).body;
    assert.equal(res.comments.groups[0].key, "terse");
    assert.deepEqual(res.comments.groups[0].tags, { missing: 1 });
    // CLI maps letters to models.
    const cli = await run("labels.js", ["comments", path.join(root, "labels/variants-demo")]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /model terse: 1 comment\(s\) on 1 item\(s\) — missing 1/);
    assert.match(cli.stdout, /\[A\] "Supplier to be called" — no owner \(missing\)/);
    const js = JSON.parse((await run("labels.js", ["comments", path.join(root, "labels/variants-demo"), "--json"])).stdout);
    assert.equal(js.groups[0].key, "terse");
    // A waiter for the next comment.
    const w = srv.get(`${T}/wait?until=commented&timeout=5`);
    await new Promise((ok) => setTimeout(ok, 700));
    await srv.post(`${T}/comment`, { item_id: "note-02", anchor: "C", quote: "Rate up", start: 0, end: 7, tags: ["missing"] });
    const done = await w;
    assert.equal(done.body.status, "satisfied");
    assert.equal(done.body.comments, 2);
    const n = await srv.get(`${T}/wait?until=commented:2&timeout=1`);
    assert.equal(n.body.status, "satisfied");
    // validate.js reports comment counts.
    const v = await run("validate.js", ["--labels", path.join(root, "labels")], { SPECS_DIR: "" });
    assert.match(v.stdout, /ok {3}task variants-demo {2}\(3 items, 1 reviewer labels, 2 comments\)/);
  } finally {
    await srv.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the bundled variants demo loads with balanced letters", () => {
  const t = loadTask(path.join(TOOL, "../../examples/labels/variants-demo"), "variants-demo");
  assert.deepEqual(t.errors, []);
  assert.deepEqual(t.warnings, []);
  for (const it of t.items) assert.equal(new Set(Object.values(it.hidden.letters)).size, 3);
});
