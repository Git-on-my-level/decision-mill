// Waiting for the human without polling: the long-poll endpoints, wait.js and
// `labels.js wait`, and their exit codes (0 satisfied, 2 timeout, 1 error).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import * as yaml from "js-yaml";
import { parseDuration, parseUntil, waitLoop } from "../lib/wait.js";
import { labelCondition } from "../lib/label-api.js";
import { copyExamples, startServer, freePort, TOOL, REPO } from "./helpers.js";

// Run a CLI asynchronously (the server under test runs in this process's event loop).
function run(script, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: TOOL, env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("durations and conditions parse; bad ones are refused", () => {
  assert.equal(parseDuration("3h"), 10800);
  assert.equal(parseDuration("1h30m"), 5400);
  assert.equal(parseDuration("45"), 45);
  assert.equal(parseDuration("2x"), null);
  assert.deepEqual(parseUntil("decided>=5", "spec"), { kind: "decided>=", n: 5 });
  assert.deepEqual(parseUntil("labeled:20", "label"), { kind: "labeled>=", n: 20 }, "shell-safe spelling");
  assert.deepEqual(parseUntil("all-decided", "spec"), { kind: "all-decided" });
  assert.match(parseUntil("labeled>=3", "spec").error, /not a spec-mode condition/);
  assert.match(parseUntil("wave-ready", "spec").error, /unknown until/);
  assert.match(parseUntil("all-decided", "label").error, /wave-ready \| round-done/);
});

test("label conditions: impossible waits are errors, round-done pins the starting round", () => {
  const st = { kind: "label", items: 4, labeled: 2, unit: "round", current: 2, rounds: [{ n: 1, size: 2, labeled: 2 }, { n: 2, size: 2, labeled: 0 }], waves: null, etag: "e1" };
  assert.match(labelCondition(st, { kind: "labeled>=", n: 9 }, {}).error, /can never hold/);
  assert.match(labelCondition(st, { kind: "wave-ready" }, {}).error, /uses rounds/);
  const base = {};
  assert.equal(labelCondition(st, { kind: "round-done" }, base).done, false);
  assert.equal(base.round, 2);
  assert.equal(labelCondition({ ...st, rounds: [st.rounds[0], { n: 2, size: 2, labeled: 2 }], current: null }, { kind: "round-done" }, base).done, true);
  const ch = {};
  assert.equal(labelCondition(st, { kind: "change" }, ch).done, false);
  assert.equal(labelCondition({ ...st, etag: "e2" }, { kind: "change" }, ch).done, true);
  assert.equal(labelCondition({ ...st, kind: "speakers" }, { kind: "done" }, {}).error, "speaker tasks support only labeled>=N and change");
});

test("waitLoop chains requests with the last etag and maps outcomes to exit codes", async () => {
  const urls = [];
  const replies = [{ status: "timeout", etag: "a" }, { status: "timeout", etag: "b" }, { status: "satisfied", etag: "c" }];
  const fetchImpl = async (u) => { urls.push(u); return { ok: true, status: 200, json: async () => replies.shift() }; };
  const r = await waitLoop({ totalS: 60, fetchImpl, buildUrl: ({ since }) => `x?since=${since}` });
  assert.equal(r.code, 0);
  assert.deepEqual(urls, ["x?since=null", "x?since=a", "x?since=b"]);
  const err = await waitLoop({ totalS: 60, fetchImpl: async () => ({ ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "never" }) }), buildUrl: () => "x" });
  assert.equal(err.code, 1);
  assert.match(err.message, /409: never/);
  const down = await waitLoop({ totalS: 60, fetchImpl: async () => { throw new Error("fetch failed"); }, buildUrl: () => "x" });
  assert.equal(down.code, 1);
  const to = await waitLoop({ totalS: 0, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: "timeout" }) }), buildUrl: () => "x" });
  assert.equal(to.code, 2);
});

const root = copyExamples();
// The demo task in waves mode, plus a copy in rounds mode, plus a pending task
// whose items have already landed (the stale `pending:` case).
const demo = path.join(root, "labels/demo-task");
fs.cpSync(demo, path.join(root, "labels/waves-task"), { recursive: true });
const wraw = yaml.load(fs.readFileSync(path.join(root, "labels/waves-task/task.yaml"), "utf8"));
fs.writeFileSync(path.join(root, "labels/waves-task/task.yaml"), yaml.dump({ ...wraw, waves: { count: 2, size: 3 } }));
fs.mkdirSync(path.join(root, "labels/stale-pending"));
fs.writeFileSync(path.join(root, "labels/stale-pending/task.yaml"), "title: Stale\nlabels: [{id: a}]\npending: |\n  Run fetch.sh.\n");
fs.writeFileSync(path.join(root, "labels/stale-pending/items.jsonl"), '{"id":"x","content":{"type":"text","body":"b"}}\n');
fs.mkdirSync(path.join(root, "labels/still-pending"));
fs.writeFileSync(path.join(root, "labels/still-pending/task.yaml"), "title: Still\nlabels: [{id: a}]\npending: |\n  Run fetch.sh.\n");
const srv = await startServer({ SPECS_DIR: path.join(root, "specs"), LABELS_ROOT: path.join(root, "labels"), REPO_ROOT: REPO, REVIEWER: "rev" });
test.after(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
const decide = (id, decision, detail) => srv.post(`/api/spec/todo-lists/item/${id}`, { action: "decision", decision, decision_detail: detail || null });

test("GET /api/specs/wait: timeout status, then satisfied as soon as the reviewer decides", async () => {
  let r = await srv.get("/api/specs/wait?until=decided>=1&timeout=0.3");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "timeout");
  assert.equal(r.body.counts.decided, 0);
  const etag = r.body.etag;
  const pending = srv.get(`/api/specs/wait?until=decided%3E%3D1&spec=todo-lists&timeout=20`);
  await sleep(300);
  await decide("DIV-TODO-002", "keep");
  r = await pending;
  assert.equal(r.body.status, "satisfied");
  assert.equal(r.body.spec, "todo-lists");
  assert.equal(r.body.counts.decided, 1);
  assert.notEqual(r.body.etag, etag);
  // change: since= an old etag is satisfied immediately; no since waits for the next write.
  r = await srv.get(`/api/specs/wait?until=change&since=${etag}&timeout=5`);
  assert.equal(r.body.status, "satisfied");
  r = await srv.get("/api/specs/wait?until=change&timeout=0.3");
  assert.equal(r.body.status, "timeout");
  assert.equal((await srv.get("/api/specs/wait?until=bogus")).status, 400);
  assert.equal((await srv.get("/api/specs/wait?spec=nope&timeout=0")).status, 404);
  assert.equal((await srv.get("/api/specs/wait?timeout=soon")).status, 400);
  await srv.post("/api/spec/todo-lists/item/DIV-TODO-002", { action: "undecide" });
});

test("wait.js: exits 0 when the condition holds, 2 on timeout, 1 when unreachable", async () => {
  let r = await run("wait.js", ["--url", srv.base, "--until", "all-decided", "--timeout", "1s"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stdout, /^timeout: all-decided not reached after 1s — 0\/7 decided/);
  const waiter = run("wait.js", ["--url", srv.base, "--until", "no-open", "--spec", "todo-lists", "--timeout", "30s"]);
  await sleep(400);
  for (const id of ["DIV-TODO-001", "DIV-TODO-003", "INV-TODO-001", "FC-TODO-001", "FEAT-TODO-001"]) await decide(id, "defer");
  await decide("DIV-TODO-002", "change", "change: collapse on both");
  r = await waiter;
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^satisfied: no-open — 1\/7 decided, 0 open, 5 deferred, 1 needs-metrics in .*\/todo-lists/);
  r = await run("wait.js", ["--url", `http://127.0.0.1:${await freePort()}`, "--timeout", "5s"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /server unreachable/);
  r = await run("wait.js", ["--url", srv.base, "--until", "labeled>=2"]);
  assert.equal(r.status, 1);
  r = await run("wait.js", ["--url", srv.base, "--until", "decided:1", "--json"]);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).status, "satisfied");
});

test("GET /api/task/<id>/wait: wave-ready, labeled>=N, impossible conditions", async () => {
  let r = await srv.get("/api/task/demo-task/wait?until=wave-ready&timeout=0");
  assert.equal(r.status, 409, "a rounds task can never be wave-ready");
  r = await srv.get("/api/task/demo-task/wait?until=labeled>=99");
  assert.equal(r.status, 409);
  await srv.get("/api/task/waves-task"); // opening the task freezes wave 1
  r = await srv.get("/api/task/waves-task/wait?until=wave-ready&timeout=0.2");
  assert.equal(r.body.status, "timeout");
  assert.equal(r.body.waves.state, "labeling");
  const wave1 = (await srv.get("/api/task/waves-task")).body.rounds[0].ids;
  const pending = srv.get("/api/task/waves-task/wait?until=wave-ready&timeout=20");
  await sleep(300);
  for (const id of wave1) await srv.post("/api/task/waves-task/label", { item_id: id, label: "keep" });
  r = await pending;
  assert.equal(r.body.status, "satisfied");
  assert.equal(r.body.waves.state, "inferring");
  assert.equal(r.body.reviewer, "rev");
  assert.equal(r.body.labeled, 3);
});

test("labels.js wait: --url long-polls the server; without it, it watches the files", async () => {
  const waiter = run("labels.js", ["wait", "demo-task", "--url", srv.base, "--until", "round-done", "--timeout", "30s"]);
  await sleep(400);
  const round1 = (await srv.get("/api/task/demo-task")).body.rounds[0].ids;
  for (const id of round1) await srv.post("/api/task/demo-task/label", { item_id: id, label: "keep" });
  let r = await waiter;
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^satisfied: round-done — 6\/12 labeled by rev · round 2 of 2 current/);
  r = await run("labels.js", ["wait", path.join(root, "labels/demo-task"), "--until", "labeled:6", "--timeout", "5s"], { LABELS_ROOT: "" });
  assert.equal(r.status, 0, r.stderr);
  r = await run("labels.js", ["wait", path.join(root, "labels/demo-task"), "--until", "labeled:7", "--timeout", "1s"], { LABELS_ROOT: "" });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^timeout: labeled:7/);
  r = await run("labels.js", ["wait", "demo-task", "--url", srv.base, "--until", "wave-ready", "--timeout", "5s"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /uses rounds, not waves/);
  r = await run("labels.js", ["wait", "demo-task", "--url", srv.base, "--until", "everything"]);
  assert.equal(r.status, 1);
  r = await run("labels.js", ["wait", "demo-task", "--url", `http://127.0.0.1:${await freePort()}`, "--until", "done", "--timeout", "5s"]);
  assert.equal(r.status, 1);
});

test("a pending note is reported only while items are empty, and warns once items exist", async () => {
  const r = await srv.get("/api/tasks");
  const byId = Object.fromEntries(r.body.tasks.map((t) => [t.id, t]));
  assert.equal(byId["stale-pending"].pending, false);
  assert.equal(byId["stale-pending"].warnings, 1);
  assert.equal(byId["still-pending"].pending, true);
  const v = await run("validate.js", ["--labels", path.join(root, "labels")], { SPECS_DIR: "" });
  assert.match(v.stdout, /warn task stale-pending: pending note set but items present — remove it from task\.yaml/);
  assert.doesNotMatch(v.stdout, /warn task still-pending/);
});
