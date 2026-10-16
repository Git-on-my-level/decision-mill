// Outbound links (LABELS.md: item `url`, evidence[].`url`): only http(s) URLs are
// links, the validator warns on anything else, blind mode serves them (a source
// link is not a model answer), and search text and stand-in briefs ignore them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { TOOL, copyExamples, startServer } from "./helpers.js";
import { parseItems, loadTask, normalizeTask } from "../lib/task.js";
import { proposalProblems, proposalText } from "../lib/proposal.js";
import { itemBlock, buildBrief } from "../lib/brief.js";
import { httpUrl } from "../lib/url.js";

// The browser twin, run as the plain script it is (no DOM needed to load it).
const ctx = { URL };
vm.runInNewContext(fs.readFileSync(path.join(TOOL, "public/common.js"), "utf8"), ctx);
const { httpHref } = ctx;

const CASES = [
  ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/1"],
  ["http://example.com/a?b=c#d", "http://example.com/a?b=c#d"],
  ["  https://example.com/x  ", "https://example.com/x"],
  ["HTTPS://EXAMPLE.com", "https://example.com/"],
  ["javascript:alert(1)", null],
  ["JavaScript:alert(1)", null],
  ["data:text/html,<script>alert(1)</script>", null],
  ["ftp://example.com/f", null],
  ["mailto:a@example.com", null],
  ["/relative/path", null],
  ["example.com/no-scheme", null],
  ["", null],
  [42, null],
  [null, null],
  [{ href: "https://example.com" }, null],
];

test("httpUrl and the browser's httpHref accept http(s) only, and agree", () => {
  for (const [input, want] of CASES) {
    assert.equal(httpUrl(input), want, `httpUrl(${JSON.stringify(input)})`);
    assert.equal(httpHref(input), want, `httpHref(${JSON.stringify(input)})`);
  }
});

test("validation: a non-http(s) item url is a warning; an http(s) one is clean", () => {
  const { task } = normalizeTask({ labels: [{ id: "keep" }] }, "t");
  const line = (o) => JSON.stringify({ content: { type: "text", body: "x" }, ...o });
  const text = [
    line({ id: "ok", url: "https://example.com/pr/1" }),
    line({ id: "none" }),
    line({ id: "js", url: "javascript:alert(1)" }),
    line({ id: "rel", url: "pull/1" }),
    line({ id: "num", url: 7 }),
  ].join("\n");
  const { items, errors, warnings } = parseItems(text, task);
  assert.equal(items.length, 5, "a bad url never drops the item");
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /^js: url must be an http\(s\) URL \(got 'javascript:alert\(1\)'\)/);
  assert.match(warnings[1], /^rel: url must be an http\(s\) URL/);
  assert.match(warnings[2], /^num: url must be an http\(s\) URL \(got '7'\)/);
});

test("validation: a non-http(s) evidence url is a proposal problem", () => {
  const base = { change: { before: "a", after: "b" } };
  assert.deepEqual(proposalProblems({ ...base, evidence: [{ title: "Check run", url: "https://ci.example.com/run/9" }] }), []);
  assert.deepEqual(proposalProblems({ ...base, evidence: [{ title: "No link" }] }), []);
  const w = proposalProblems({ ...base, evidence: [{ title: "A", url: "https://ok.example.com" }, { title: "B", url: "javascript:void(0)" }] });
  assert.equal(w.length, 1);
  assert.match(w[0], /^proposal evidence\[1\]\.url must be an http\(s\) URL/);
  // Through parseItems, the warning carries the item id like every proposal problem.
  const { task } = normalizeTask({ labels: [{ id: "accept" }] }, "t");
  const { warnings } = parseItems(JSON.stringify({ id: "p1", content: { type: "proposal", ...base, evidence: [{ title: "B", url: "file:///etc/passwd" }] } }), task);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^p1: proposal evidence\[0\]\.url must be an http\(s\) URL/);
});

test("flattened text leaves urls out: proposalText, itemBlock, the stand-in brief", () => {
  const c = { type: "proposal", change: { before: "a", after: "b" }, evidence: [{ title: "Check run", url: "https://ci.example.com/run/9", text: "failed" }] };
  const item = { id: "p1", title: "PR review", url: "https://code.example.com/pr/1", content: c };
  assert.doesNotMatch(proposalText(c), /example\.com/);
  assert.match(proposalText(c), /Evidence: Check run/, "the title still counts");
  const task = normalizeTask({ labels: [{ id: "accept" }] }, "t").task;
  assert.doesNotMatch(itemBlock(item, task), /example\.com/);
  const brief = buildBrief({ task, items: [item], human: new Map(), standinName: "s" });
  assert.doesNotMatch(brief, /example\.com/);
});

test("server: blind mode serves item and evidence urls; search ignores them", async () => {
  const root = copyExamples();
  const labels = path.join(root, "labels");
  for (const id of ["demo-task", "proposal-demo"]) {
    const t = loadTask(path.join(labels, id), id);
    assert.deepEqual(t.warnings.filter((w) => /url/.test(w)), [], `${id}: example urls validate`);
  }
  const srv = await startServer({ LABELS_ROOT: labels, REVIEWER: "rev" });
  try {
    const doc = await srv.get("/api/task/demo-task/item/doc-009");
    assert.equal(doc.status, 200);
    assert.equal(doc.body.item.blinded, true);
    assert.equal(doc.body.item.hidden, undefined, "model answers withheld");
    assert.equal(doc.body.item.url, "https://docs.example.com/notes/offsite-agenda", "the source link is visible meta");
    const pd = await srv.get("/api/task/proposal-demo/item/pd-spelling");
    assert.equal(pd.body.item.blinded, true);
    assert.equal(pd.body.item.content.evidence[0].url, "https://notes.example.com/42");
    for (const q of ["docs.example.com", "notes.example.com", "offsite-agenda"]) {
      const s = await srv.get(`/api/search?q=${encodeURIComponent(q)}`);
      assert.deepEqual(s.body.results.filter((x) => x.type === "item"), [], `search for ${q}`);
    }
    const s = await srv.get(`/api/search?q=${encodeURIComponent("offsite agenda")}`);
    assert.ok(s.body.results.some((x) => x.id === "doc-009"), "the title is still searchable");
    const js = await (await fetch(srv.base + "/label.js")).text();
    assert.match(js, /httpHref\(item\.url\)/);
    assert.match(js, /httpHref\(e\.url\)/);
  } finally {
    await srv.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
