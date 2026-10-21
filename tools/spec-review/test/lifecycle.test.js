// Workspaces, lifecycle, purpose, the hub config and the inbox.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeLifecycle, normalizePurpose, parseEnough, evaluateEnough, purposeWarnings, isStale, estimateMinutes, ARCHIVE_DIR } from "../lib/lifecycle.js";
import { discoverTasks, loadTask, normalizeTask } from "../lib/task.js";
import { copyExamples, startServer, tmpdir, TOOL } from "./helpers.js";

const runSync = (script, args, env = {}) => spawnSync(process.execPath, [script, ...args], { cwd: TOOL, encoding: "utf8", env: { ...process.env, DECISION_MILL_HUB: "", ...env } });

test("lifecycle and purpose fields normalize, with warnings for bad values", () => {
  const w = [];
  assert.deepEqual(normalizeLifecycle({ workspace: "Omi Notes", status: "Paused" }, w), { workspace: "omi-notes", status: "paused", created: null });
  assert.equal(normalizeLifecycle({ status: "zombie" }, w).status, "active");
  assert.ok(w.some((x) => /unknown status 'zombie'/.test(x)));
  assert.deepEqual(parseEnough(40), { labels: 40 });
  assert.deepEqual(parseEnough("labels>=40"), { labels: 40 });
  assert.deepEqual(parseEnough("ci<=0.1"), { ci_half_width: 0.1 });
  assert.deepEqual(parseEnough({ ci_half_width: 0.1, model: "v4" }), { ci_half_width: 0.1, model: "v4" });
  assert.match(parseEnough({ labelz: 3 }).error, /unknown key/);
  assert.match(parseEnough("when it feels right").error, /not machine-readable/);
  const p = normalizePurpose({ decision: "Ship v4?", enough_when: "when it feels right", minutes_per_round: 6 }, []);
  assert.deepEqual(p.enough_when, { text: "when it feels right" });
  assert.equal(p.minutes_per_round, 6);
  const t = normalizeTask({ labels: [{ id: "a" }] }, "t").task;
  assert.equal(t.status, "active");
  assert.equal(purposeWarnings(t).length, 3);
  assert.equal(purposeWarnings({ ...t, status: "done" }).length, 0);
});

test("enough_when: labels, rounds, comments and CI half-width", () => {
  assert.equal(evaluateEnough({ labels: 10 }, { labeled: 9, roundsDone: 0 }).met, false);
  const e = evaluateEnough({ labels: 10, rounds: 1 }, { labeled: 10, roundsDone: 1 });
  assert.equal(e.met, true);
  assert.match(e.text, /10 labels \(10 so far\) and 1 round done/);
  const ci = evaluateEnough({ ci_half_width: 0.1 }, { labeled: 30, roundsDone: 1, models: [{ id: "a", compared: 30, ci: [0.7, 0.88] }, { id: "b", compared: 30, ci: [0.5, 0.8] }] });
  assert.equal(ci.met, false);
  assert.match(ci.text, /widest now ±15 pts, b n=30/);
  assert.equal(evaluateEnough({ ci_half_width: 0.1, model: "a" }, { labeled: 30, models: [{ id: "a", compared: 30, ci: [0.7, 0.88] }, { id: "b", compared: 30, ci: [0.5, 0.8] }] }).met, true);
  assert.equal(evaluateEnough({ text: "vibes" }, { labeled: 99 }).met, false);
  assert.equal(isStale("active", Date.now() - 8 * 86400000), true);
  assert.equal(isStale("paused", Date.now() - 8 * 86400000), false);
  assert.equal(isStale("active", Date.now() - 86400000), false);
  assert.equal(estimateMinutes({ minutes_per_round: 6, round_size: 4 }, 2), 3);
  assert.equal(estimateMinutes({ round_size: 40 }, 9), 3, "20 s a card by default");
});

test("tasks under <root>/_archive/ are discovered as archived", () => {
  const root = copyExamples();
  try {
    const labels = path.join(root, "labels");
    fs.mkdirSync(path.join(labels, ARCHIVE_DIR));
    fs.renameSync(path.join(labels, "pair-demo"), path.join(labels, ARCHIVE_DIR, "pair-demo"));
    const found = discoverTasks([labels]);
    const pair = found.find((t) => t.id === "pair-demo");
    assert.equal(pair.archived, true);
    assert.equal(pair.root, labels);
    assert.equal(found.find((t) => t.id === "demo-task").archived, false);
    assert.equal(loadTask(pair.dir, pair.id).task.status, "archived");
    const v = runSync("validate.js", ["--labels", labels], { SPECS_DIR: "" });
    assert.equal(v.status, 0, v.stdout);
    assert.match(v.stdout, /ok {3}task pair-demo {2}\(archived, 4 items/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("HTTP: archive and restore move the directory and keep labels; home lists workspaces and the inbox", async () => {
  const root = copyExamples();
  const labels = path.join(root, "labels");
  const srv = await startServer({ LABELS_ROOT: labels, SPECS_DIR: "" });
  try {
    await srv.post("/api/task/pair-demo/label", { item_id: (await srv.get("/api/task/pair-demo")).body.index[0].id, label: "same" });
    let home = (await srv.get("/api/home")).body;
    const pair = home.tasks.find((t) => t.id === "pair-demo");
    assert.equal(pair.status, "active");
    assert.equal(pair.workspace, "demo", "from the bundled task.yaml");
    assert.equal(pair.waitingOn, "human");
    assert.equal(pair.remaining, 3);
    assert.equal(pair.minutes, 2, "3 cards at minutes_per_round 3 / 4 cards");
    assert.equal(pair.enough.met, false);
    assert.equal(pair.stale, false);
    assert.ok(pair.created && pair.lastActivity);
    assert.ok(home.workspaces.some((w) => w.id === "demo" && w.title === "Demo workspace" && w.owner === "nobody"), "workspace.yaml metadata");
    let r = await srv.post("/api/task/pair-demo/archive", {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(fs.existsSync(path.join(labels, "_archive/pair-demo/labels/reviewer.jsonl")), "labels move with the task");
    assert.ok(!fs.existsSync(path.join(labels, "pair-demo")));
    home = (await srv.get("/api/home")).body;
    assert.equal(home.tasks.find((t) => t.id === "pair-demo").status, "archived");
    assert.equal(home.tasks.find((t) => t.id === "pair-demo").labeled, 1);
    assert.equal((await srv.post("/api/task/pair-demo/archive", {})).status, 409);
    r = await srv.post("/api/task/pair-demo/restore", {});
    assert.equal(r.status, 200);
    assert.equal(r.body.task.status, "active");
    assert.ok(fs.existsSync(path.join(labels, "pair-demo/labels/reviewer.jsonl")));
    // A task that has met enough_when says so.
    const t = (await srv.get("/api/task/speaker-demo")).body.summary;
    assert.equal(t.enough.met, false);
    assert.match(t.enough.text, /3 labels/);
  } finally {
    await srv.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hub: one server serves several roots with workspaces; flags add to it", async () => {
  const root = copyExamples();
  const other = tmpdir();
  try {
    fs.cpSync(path.join(root, "labels/demo-task"), path.join(other, "solo-task"), { recursive: true });
    const tyaml = path.join(other, "solo-task/task.yaml");
    fs.writeFileSync(tyaml, fs.readFileSync(tyaml, "utf8").replace(/^workspace: demo$/m, "").replace(/^id: demo-task$/m, "id: solo-task"));
    const hub = path.join(root, "hub.yaml");
    fs.writeFileSync(hub, `title: Test hub
labels:
  - labels
  - {dir: ${other}, workspace: side-project}
specs:
  - {dir: specs, workspace: product}
workspaces:
  side-project: {title: Side project, owner: david}
`);
    const srv = await startServer({ DECISION_MILL_HUB: hub, SPECS_DIR: "", LABELS_ROOT: "" });
    try {
      const home = (await srv.get("/api/home")).body;
      assert.equal(home.hub.file, hub);
      assert.ok(home.tasks.some((t) => t.id === "demo-task" && t.workspace === "demo"));
      assert.ok(home.tasks.some((t) => t.id === "solo-task" && t.workspace === "side-project"), "the hub entry assigns a workspace");
      assert.equal(home.specSets[0].workspace, "product");
      const ws = Object.fromEntries(home.workspaces.map((w) => [w.id, w]));
      assert.equal(ws["side-project"].title, "Side project");
      assert.equal(ws["side-project"].tasks, 1);
      assert.equal(ws.product.specSets, 1);
      assert.match(srv.output(), /hub: .*hub\.yaml/);
    } finally { await srv.stop(); }
    const v = runSync("validate.js", ["--hub", hub], { SPECS_DIR: "", LABELS_ROOT: "" });
    assert.match(v.stdout, /ok {3}task solo-task/);
    assert.match(v.stdout, /ok {3}todo-lists\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});
