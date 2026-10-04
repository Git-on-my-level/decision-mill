// End-to-end over HTTP against a real server process, on temp copies of the
// bundled examples: spec writes stay surgical, and the label API behaves.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { copyExamples, startServer, REPO } from "./helpers.js";
import { parseSpec } from "../lib/parser.js";

const root = copyExamples();
const SPEC = path.join(root, "specs/todo-lists.md");
const srv = await startServer({ SPECS_DIR: path.join(root, "specs"), LABELS_ROOT: path.join(root, "labels"), REPO_ROOT: REPO });
test.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });

// Everything outside item `id`'s fence body must be byte-identical.
function outsideFence(text, id) {
  const it = parseSpec(text).items.find((x) => x.id === id);
  return text.slice(0, it.fenceBodyStart) + "\u0000" + text.slice(it.fenceBodyEnd);
}

test("spec mode: decision, note, undo rewrite only the target fence", async () => {
  const before = fs.readFileSync(SPEC, "utf8");
  const id = "DIV-TODO-001";
  let r = await srv.post(`/api/spec/todo-lists/item/${id}`, { action: "decision", decision: "change", decision_detail: "unify on optimistic" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.item.meta.decision, "change");
  r = await srv.post(`/api/spec/todo-lists/item/${id}`, { action: "note", text: "checked with mobile" });
  assert.equal(r.status, 200);
  const mid = fs.readFileSync(SPEC, "utf8");
  assert.equal(outsideFence(mid, id), outsideFence(before, id), "prose, frontmatter and other items untouched");
  assert.notEqual(mid, before);
  r = await srv.post(`/api/spec/todo-lists/item/${id}`, { action: "undecide" });
  assert.equal(r.status, 200);
  const after = fs.readFileSync(SPEC, "utf8");
  assert.equal(outsideFence(after, id), outsideFence(before, id));
  const meta = parseSpec(after).items.find((x) => x.id === id).meta;
  assert.equal(meta.decision, null);
  assert.deepEqual(meta.notes.map((n) => n.text), ["decision: change — unify on optimistic", "checked with mobile", "decision cleared"]);
});

test("spec mode: set-less and set-qualified routes both work", async () => {
  const sets = await srv.get("/api/specsets");
  const id = sets.body.sets[0].id;
  const a = await srv.get("/api/spec/todo-lists");
  const b = await srv.get(`/api/spec/todo-lists?set=${id}`);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.items.length, b.body.items.length);
  assert.equal((await srv.get("/api/spec/todo-lists?set=nope")).status, 404);
});

test("writes must be same-origin JSON", async () => {
  const form = await fetch(`${srv.base}/api/task/demo-task/label`, { method: "POST", headers: { "content-type": "text/plain" }, body: '{"item_id":"conv-001","label":"keep"}' });
  assert.equal(form.status, 403);
  const cross = await srv.post("/api/task/demo-task/label", { item_id: "conv-001", label: "keep" }, { origin: "https://evil.example" });
  assert.equal(cross.status, 403);
  const same = await srv.post("/api/task/demo-task/label", { item_id: "conv-001", label: "keep" }, { origin: srv.base });
  assert.equal(same.status, 200);
  const proxied = await srv.post("/api/task/demo-task/undo", { item_id: "conv-001" }, { origin: "https://box.tailnet.ts.net", "tailscale-user-login": "someone@example.com" });
  assert.equal(proxied.status, 200, "a request through tailscale serve is trusted");
});

test("label mode: blind until labeled, then revealed; undo re-blinds", async () => {
  const first = await srv.get("/api/task/demo-task/item/conv-003");
  assert.equal(first.body.item.blinded, true);
  assert.equal(first.body.item.hidden, undefined, "hidden model answers withheld by the server");
  assert.equal(first.body.item.stratum, undefined, "stratum withheld too — it encodes model answers");
  const idx = await srv.get("/api/task/demo-task");
  assert.ok(idx.body.index.every((r) => !("stratum" in r) || r.label != null));
  const r = await srv.post("/api/task/demo-task/label", { item_id: "conv-003", label: "keep", fields: { wants_memory: true }, note: "deadline + task" });
  assert.equal(r.status, 200);
  assert.equal(r.body.item.blinded, false);
  assert.ok(r.body.item.reveal.some((x) => x.model === "ranker" && x.score === 0.55));
  assert.equal(r.body.state.note, "deadline + task");
  const u = await srv.post("/api/task/demo-task/undo", { item_id: "conv-003" });
  assert.equal(u.body.state.label, null);
  assert.equal(u.body.item.blinded, true);
  assert.equal(u.body.state.note, "deadline + task", "undo clears the label, not the note");
});

test("label mode: reviewer comes from REVIEWER, else Tailscale-User-Login", async () => {
  await srv.post("/api/task/demo-task/label", { item_id: "conv-005", label: "keep" }, { "tailscale-user-login": "alice@example.com" });
  const file = path.join(root, "labels/demo-task/labels/alice@example.com.jsonl");
  assert.ok(fs.existsSync(file));
  const row = JSON.parse(fs.readFileSync(file, "utf8").trim());
  assert.equal(row.reviewer, "alice@example.com");
  assert.equal(row.source, "human");
  const spoof = await srv.post("/api/task/demo-task/label", { item_id: "conv-005", label: "keep", reviewer: "bob" });
  assert.equal(spoof.status, 400, "a human label cannot claim another reviewer");
});

test("label mode: concurrent writes all land, latest wins", async () => {
  const ids = ["conv-001", "conv-002", "conv-004", "conv-006", "conv-007", "conv-008", "doc-009", "conv-010", "txt-011", "conv-012"];
  const reqs = [];
  for (let round = 0; round < 5; round++) for (const id of ids) reqs.push(srv.post("/api/task/demo-task/label", { item_id: id, label: round % 2 ? "noise" : "keep" }, { "tailscale-user-login": "carol" }));
  const res = await Promise.all(reqs);
  assert.ok(res.every((r) => r.status === 200));
  const lines = fs.readFileSync(path.join(root, "labels/demo-task/labels/carol.jsonl"), "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 50);
  lines.forEach((l) => JSON.parse(l));
  const all = await srv.get("/api/task/demo-task/labels?reviewer=carol");
  assert.equal(all.body.reviewers.carol.labeled, 10);
});

test("agent API: model-standin batch, read back, results", async () => {
  const bad = await srv.post("/api/task/demo-task/labels", { reviewer: "opus", source: "human", labels: [{ item_id: "conv-001", label: "keep" }] });
  assert.equal(bad.status, 400, "batch writes are never human");
  const invalid = await srv.post("/api/task/demo-task/labels", { reviewer: "opus", labels: [{ item_id: "conv-001", label: "keep" }, { item_id: "nope", label: "keep" }] });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /labels\[1\]/, "all-or-nothing: nothing appended");
  const ok = await srv.post("/api/task/demo-task/labels", { reviewer: "opus", labels: [{ item_id: "conv-001", label: "keep", confidence: 0.9, rationale: "a plan with a time" }, { item_id: "conv-002", label: "noise" }] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.appended, 2);
  const read = await srv.get("/api/task/demo-task/labels?source=model-standin");
  assert.equal(read.body.reviewers.opus.labels.length, 2);
  assert.equal(read.body.reviewers.opus.labels[0].confidence, 0.9);
  const res = await srv.get("/api/task/demo-task/results?reviewer=carol");
  assert.equal(res.status, 200);
  assert.ok(res.body.models.some((m) => m.id === "opus" && m.kind === "standin"));
  assert.ok(res.body.models.find((m) => m.id === "ranker").curve);
  assert.ok(res.body.usefulness.headline);
});

test("media: served with Range support, confined to media/", async () => {
  const full = await fetch(`${srv.base}/api/task/demo-task/media?src=media/conv-001.m4a`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  const part = await fetch(`${srv.base}/api/task/demo-task/media?src=media/conv-001.m4a`, { headers: { range: "bytes=0-99" } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.equal((await srv.get("/api/task/demo-task/media?src=../task.yaml")).status, 400);
  assert.equal((await srv.get("/api/task/demo-task/media?src=items.jsonl")).status, 400);
});

test("home and search cover both modes; client URLs are relative", async () => {
  const home = await srv.get("/api/home");
  assert.equal(home.body.specSets.length, 1);
  assert.equal(home.body.tasks[0].id, "demo-task");
  const s = await srv.get("/api/search?q=grant%20deadline");
  assert.ok(s.body.results.some((r) => r.type === "item" && r.id === "conv-003"));
  const s2 = await srv.get("/api/search?q=optimistic");
  assert.ok(s2.body.results.some((r) => r.type === "spec"));
  const html = await (await fetch(srv.base + "/")).text();
  assert.doesNotMatch(html, /(src|href)="\//, "no absolute asset URLs (reverse-proxy safe)");
  for (const f of ["common.js", "spec.js", "label.js", "shell.js"]) {
    const js = await (await fetch(`${srv.base}/${f}`)).text();
    assert.doesNotMatch(js, /(fetch|api|postJSON)\(\s*[`"']\/api/, `${f} uses only relative API URLs`);
  }
});
