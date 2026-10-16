// The `proposal` content type: the inline diff the card shows (public/
// proposal-diff.js), validation (lib/proposal.js via parseItems), and the item
// API serving the bundled fictional demo.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { copyExamples, startServer } from "./helpers.js";
import { parseItems, loadTask } from "../lib/task.js";
import { proposalProblems, proposalText } from "../lib/proposal.js";
import { itemBlock } from "../lib/brief.js";

await import("../public/proposal-diff.js");
const D = globalThis.ProposalDiff;
const ops = (runs) => runs.map((r) => (r.op === "eq" ? r.text : r.op === "chg" ? `{${r.from}→${r.text}}` : `${r.op === "del" ? "-" : "+"}[${r.text}]`)).join("");
const rejoin = (runs, side) => runs.map((r) => (r.op === "eq" ? r.text : r.op === "chg" ? (side === "before" ? r.from : r.text) : r.op === (side === "before" ? "del" : "ins") ? r.text : "")).join("");

test("diff: word-level replacement keeps the unchanged words", () => {
  const runs = D.diffWords("I work at Nuvessa Glass.", "I now work at Nuvessa Ceramics.");
  assert.equal(ops(runs), "I +[now ]work at Nuvessa -[Glass]+[Ceramics].");
  const s = D.sides(runs);
  assert.equal(s.before.map((r) => r.text).join(""), "I work at Nuvessa Glass.");
  assert.equal(s.after.map((r) => r.text).join(""), "I now work at Nuvessa Ceramics.");
  assert.ok(D.keptShare(runs, "I work at Nuvessa Glass.", "I now work at Nuvessa Ceramics.") > 0.5);
});

test("diff: adjacent changed words join into one phrase", () => {
  assert.equal(ops(D.diffWords("the quick brown fox", "the slow red fox")), "the -[quick brown]+[slow red] fox");
});

test("diff: a one-word spelling change is a character diff", () => {
  const [r] = D.diffWords("Mirexah", "Mirexu");
  assert.equal(r.op, "chg");
  assert.equal(r.from, "Mirexah");
  assert.deepEqual(r.parts, [{ op: "eq", text: "Mirex" }, { op: "del", text: "ah" }, { op: "ins", text: "u" }]);
  const s = D.sides([r]);
  assert.deepEqual(s.before, [{ op: "eq", text: "Mirex" }, { op: "del", text: "ah" }]);
  assert.deepEqual(s.after, [{ op: "eq", text: "Mirex" }, { op: "ins", text: "u" }]);
  assert.equal(ops(D.diffWords("Send it to Mirexah today", "Send it to Mirexu today")), "Send it to {Mirexah→Mirexu} today");
  assert.equal(D.diffWords("colour", "color")[0].op, "chg");
  assert.equal(D.diffWords("Anneke", "anneke")[0].op, "chg", "a case-only change is a spelling change");
});

test("diff: different words, numbers and dates are not spelling changes", () => {
  assert.equal(ops(D.diffWords("on Friday", "on Thursday")), "on -[Friday]+[Thursday]");
  assert.equal(ops(D.diffWords("2026-03-10", "2026-03-12")), "-[2026-03-10]+[2026-03-12]");
  assert.equal(ops(D.diffWords("10:00–10:10", "10:05:01–10:15")), "-[10:00]+[10:05:01]–-[10:10]+[10:15]");
  const rewrite = D.diffWords("Kiln packing notes", "Mirexu kiln shipping checklist");
  assert.equal(D.keptShare(rewrite, "Kiln packing notes", "Mirexu kiln shipping checklist"), 0, "a rewrite keeps nothing → shown whole");
});

test("diff: empty before or after", () => {
  assert.deepEqual(D.diffWords("", "new value"), [{ op: "ins", text: "new value" }]);
  assert.deepEqual(D.diffWords("old value", ""), [{ op: "del", text: "old value" }]);
  assert.deepEqual(D.diffWords(null, undefined), []);
  assert.deepEqual(D.diffWords("same", "same"), [{ op: "eq", text: "same" }]);
  assert.equal(D.display(""), null);
  assert.equal(D.display(null), null);
  assert.equal(D.display(0), "0");
  assert.equal(D.display(false), "false");
  assert.equal(D.display(["a", 1]), '["a",1]');
  assert.ok(D.sameValue({ a: 1 }, { a: 1 }));
  assert.ok(!D.sameValue(2, 1));
  assert.ok(D.sameValue(null, ""));
});

test("diff: CJK is diffed per character, never as one giant word", () => {
  const runs = D.diffWords("東京オフィスの定例会議メモ", "大阪オフィスの定例会議メモ");
  assert.equal(ops(runs), "-[東京]+[大阪]オフィスの定例会議メモ");
  assert.equal(ops(D.diffWords("東京の会議", "東都の会議")), "東-[京]+[都]の会議");
  assert.equal(ops(D.diffWords("서울 회의", "부산 회의")), "-[서울]+[부산] 회의");
  assert.ok(runs.every((r) => r.op !== "chg"), "no Latin-style spelling runs in CJK");
  assert.deepEqual(D.tokenize("会議 meeting"), ["会", "議", " ", "meeting"]);
});

test("diff: long strings stay correct and fast", () => {
  const words = Array.from({ length: 4000 }, (_, i) => `w${i}`);
  const a = words.join(" ");
  const b = [...words.slice(0, 2000), "INSERTED", ...words.slice(2000, 3999), "w3999x"].join(" ");
  const t0 = Date.now();
  const runs = D.diffWords(a, b);
  assert.ok(Date.now() - t0 < 2000, "diffs 4000 words in under 2 s");
  assert.equal(rejoin(runs, "before"), a);
  assert.equal(rejoin(runs, "after"), b);
  assert.ok(runs.some((r) => r.op === "ins" && r.text.includes("INSERTED")));
  // Totally different long strings fall back to one del + one ins without the O(n·m) table.
  const x = "a ".repeat(3000), y = "b ".repeat(3000);
  const big = D.diffWords(x, y);
  assert.equal(rejoin(big, "before"), x);
  assert.equal(rejoin(big, "after"), y);
});

test("highlight: case-insensitive, every occurrence, longer terms win", () => {
  const text = "Please send it to Mirexah, not mirexu. Mirexah agreed.";
  const r = D.highlightRanges(text, ["Mirexah", "Mirexu"]);
  assert.deepEqual(r.map((x) => text.slice(x.start, x.end)), ["Mirexah", "mirexu", "Mirexah"]);
  assert.deepEqual(r.map((x) => x.index), [0, 1, 0]);
  const o = D.highlightRanges("I work at Luro Glass.", ["Luro", "I work at Luro Glass.", { text: "x" }]);
  assert.equal(o.length, 1, "the whole sentence wins over the word inside it; one-letter terms are ignored");
  assert.deepEqual(D.highlightRanges("東京オフィス", ["東京"]).map((x) => [x.start, x.end]), [[0, 2]]);
});

test("policy: one rule per sentence; abbreviations and decimals do not split", () => {
  const rules = D.splitSentences("Verification policy: Edits are data. Agree e.g. only with facts; joining is not reviewing. Overlap >= 0.5 of it. Missing evidence is insufficient.");
  assert.deepEqual(rules, ["Verification policy: Edits are data.", "Agree e.g. only with facts; joining is not reviewing.", "Overlap >= 0.5 of it.", "Missing evidence is insufficient."]);
  assert.deepEqual(D.splitSentences("重要な規則。次の規則。"), ["重要な規則。", "次の規則。"]);
  assert.deepEqual(D.splitSentences(["  a ", "", "b"]), ["a", "b"]);
  assert.deepEqual(D.splitSentences(""), []);
});

const good = { type: "proposal", question: "Accept?", change: { kind: "Title", target: "t/1", before: "Old", after: "New" },
  evidence: [{ title: "Conversation", tag: "Target", segments: [{ id: "s1", text: "New it is" }], cited: ["s1"], facts: { Title: "Old" }, raw: { a: 1 } }],
  highlight: ["Old", { text: "New", side: "after" }], policy: "Rule one. Rule two.", policy_focus: ["Rule two"] };

test("validate: a well-formed proposal item has no warnings", () => {
  assert.deepEqual(proposalProblems(good), []);
  const { items, errors, warnings } = parseItems(JSON.stringify({ id: "p1", content: good }), { labels: [] });
  assert.equal(items.length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(proposalProblems({ type: "proposal", change: { summary: "Merge", fields: [{ name: "Time", before: 1, after: 2 }], compare: true } }), []);
});

test("validate: malformed proposals are reported per item", () => {
  const bad = [
    [{ type: "proposal" }, /needs a change mapping/],
    [{ type: "proposal", change: { kind: "x" } }, /before\/after, fields, or a summary/],
    [{ type: "proposal", change: { fields: [{ before: 1 }] } }, /fields\[0\] needs a name/],
    [{ type: "proposal", change: { before: "a" }, evidence: {} }, /evidence must be a list/],
    [{ type: "proposal", change: { before: "a" }, evidence: [{ segments: "x" }] }, /evidence\[0\] needs a title/],
    [{ type: "proposal", change: { before: "a" }, evidence: [{ title: "t", cited: [1] }] }, /cited must be a list/],
    [{ type: "proposal", change: { before: "a" }, policy: 3 }, /policy must be a string/],
    [{ type: "proposal", change: { before: "a" }, policy_focus: "x" }, /policy_focus must be a list/],
    [{ type: "proposal", change: { before: "a" }, highlight: [3] }, /highlight must be a list/],
  ];
  for (const [content, re] of bad) {
    const { warnings } = parseItems(JSON.stringify({ id: "p", content }), { labels: [] });
    assert.ok(warnings.some((w) => re.test(w) && w.startsWith("p: ")), `${JSON.stringify(content)} → ${warnings}`);
  }
  const { warnings } = parseItems(JSON.stringify({ id: "q", content: { type: "nope" } }), { labels: [] });
  assert.match(warnings[0], /want transcript\|markdown\|text\|proposal/);
});

test("text: search and the stand-in brief see the change, the evidence and the policy", () => {
  const t = proposalText(good);
  assert.match(t, /Title: Old → New/);
  assert.match(t, /Evidence: Conversation \[Target\]/);
  assert.match(t, /New it is/);
  assert.match(t, /Policy: Rule one/);
  assert.match(proposalText({ change: { before: "", after: "x" } }), /\(new\) → x/);
  assert.match(proposalText({ change: { before: "x", after: null } }), /x → \(removed\)/);
  const block = itemBlock({ id: "p1", content: good }, { labels: [], user_label: "You" });
  assert.match(block, /Title: Old → New/);
});

test("server: the bundled proposal demo validates, serves blind, and is searchable", async () => {
  const root = copyExamples();
  const dir = path.join(root, "labels/proposal-demo");
  const { items, errors, warnings } = loadTask(dir, "proposal-demo");
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.ok(items.length >= 5 && items.every((it) => it.content.type === "proposal"));
  const srv = await startServer({ LABELS_ROOT: path.join(root, "labels"), REVIEWER: "rev" });
  try {
    const r = await srv.get("/api/task/proposal-demo/item/pd-spelling");
    assert.equal(r.status, 200);
    assert.equal(r.body.item.content.type, "proposal");
    assert.equal(r.body.item.content.change.after, "Anneke");
    assert.equal(r.body.item.hidden, undefined, "blind: model answers withheld before labeling");
    assert.equal(r.body.item.blinded, true);
    const l = await srv.post("/api/task/proposal-demo/label", { item_id: "pd-spelling", label: "accept", fields: { reason: "she spells it" } });
    assert.equal(l.status, 200);
    assert.equal(l.body.item.hidden.checker.verdict, "accept", "revealed after labeling");
    const s = await srv.get(`/api/search?q=${encodeURIComponent("harbour studio kiln")}`);
    assert.ok(s.body.results.some((x) => x.type === "item" && x.id === "pd-title"));
    const html = await (await fetch(srv.base + "/")).text();
    assert.ok(html.indexOf('src="proposal-diff.js"') < html.indexOf('src="label.js"'), "the diff helpers load before label mode");
    const js = await fetch(srv.base + "/proposal-diff.js");
    assert.equal(js.status, 200);
  } finally {
    await srv.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
