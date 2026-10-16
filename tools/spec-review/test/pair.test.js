// The `pair` content type: the client-side matching and similarity cue
// (public/pair-logic.js), validation and text (lib/pair.js), the converter from
// the DIVIDER transcript convention (scripts/transcript-to-pair.js), and the
// item API serving the fictional pair-demo task.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { TOOL, REPO, tmpdir, copyExamples, startServer } from "./helpers.js";
import { parseItems, normalizeTask } from "../lib/task.js";
import { pairProblems, pairText, transcriptToPair } from "../lib/pair.js";
import { itemBlock } from "../lib/brief.js";
import { convertJsonl } from "../scripts/transcript-to-pair.js";

await import("../public/pair-logic.js");
const P = globalThis.PairLogic;
const demo = fs.readFileSync(path.join(REPO, "examples/labels/pair-demo/items.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const byId = (id) => demo.find((x) => x.id === id);

test("line matching: rewordings and fragments match, different lines do not", () => {
  const T = P.MATCH_THRESHOLD;
  const same = [
    ["Was it the thick coat or the thin coat?", "Was it the thick coat or the thin one?"],
    ["Then we cut the silica back for Thursday's batch.", "Then we cut the silica back for the Thursday batch."],
    ["The thick coat, it crazed all over the rim.", "The thick coat. It crazed all over the rim, see here."],
    ["I can mix them tonight after class.", "I can mix them tonight after the class ends."],
    ["Twenty, paid by the school.", "Twenty. The school paid it."],
    ["OK.", "ok"],
  ];
  for (const [a, b] of same) assert.ok(P.lineScore(a, b) >= T, `should match: ${a} | ${b} (${P.lineScore(a, b).toFixed(2)})`);
  const different = [
    ["Hi, is this the plumber? The kitchen tap is leaking again.", "Coming up after the break, the garden show."],
    ["Tuesday morning works, around ten?", "This week we plant tulips in pots."],
    ["Keep your elbows on your knees, it steadies the wheel.", "Your bowl is a little off center, push with the heel of your hand."],
    ["Yes.", "No."],
    ["", "anything"],
  ];
  for (const [a, b] of different) assert.ok(P.lineScore(a, b) < T, `should not match: ${a} | ${b} (${P.lineScore(a, b).toFixed(2)})`);
  assert.deepEqual(P.words("It's the Blue-one, OK?"), ["it's", "the", "blue", "one", "ok"]);
});

test("mergeLines: same lines appear once as A+B, each line used once, time order kept", () => {
  const rows = P.mergeLines(byId("pair-glaze").content);
  const both = rows.filter((r) => r.kind === "both");
  assert.equal(both.length, 7, "all seven shared lines pair up");
  assert.ok(both.every((r) => r.a.side === "A" && r.b.side === "B"));
  assert.equal(rows.filter((r) => r.kind === "A").length, 1, "A's note to self is A-only");
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].start >= rows[i - 1].start);
  const used = new Set();
  for (const r of rows) for (const s of r.kind === "both" ? [r.a, r.b] : [r.seg]) { assert.ok(!used.has(s)); used.add(s); }
  // A different conversation that merely overlaps: nothing pairs.
  assert.equal(P.mergeLines(byId("pair-plumber").content).filter((r) => r.kind === "both").length, 0);
  // Identical text too far apart in time is not the same line.
  const far = { sides: [{ id: "A" }, { id: "B" }], segments: [{ side: "A", start: 0, text: "same words here" }, { side: "B", start: 100, text: "same words here" }] };
  assert.equal(P.mergeLines(far).filter((r) => r.kind === "both").length, 0);
});

test("overlap: explicit, from started_at, from axis starts, from segments, or none", () => {
  assert.deepEqual(P.overlapOf(byId("pair-glaze").content), { start: 1500, end: 1538 });
  assert.deepEqual(P.overlapOf(byId("pair-plumber").content), { start: 60, end: 91 });
  assert.equal(P.overlapOf(byId("pair-vet").content), null);
  assert.deepEqual(P.overlapOf({ ...byId("pair-vet").content, overlap: { start: 1, end: 2 } }), { start: 1, end: 2 });
  const fromSegs = { sides: [{ id: "A" }, { id: "B" }], segments: [{ side: "A", start: 10, end: 20, text: "x" }, { side: "B", start: 15, end: 40, text: "y" }] };
  assert.deepEqual(P.overlapOf(fromSegs), { start: 15, end: 20 });
});

test("similarity cue: shared-word shares in the overlap window and speaker counts", () => {
  const same = P.similarity(byId("pair-glaze").content);
  assert.ok(same.aInB > 0.8 && same.bInA > 0.8, JSON.stringify(same));
  assert.equal(same.speakersMatch, true);
  const diff = P.similarity(byId("pair-plumber").content);
  assert.ok(diff.aInB < 0.2 && diff.bInA < 0.2, JSON.stringify(diff));
  const extra = P.similarity(byId("pair-bakesale").content);
  assert.deepEqual(extra.speakers, [2, 3]);
  assert.equal(extra.speakersMatch, false);
  // B's 40 minutes of class chatter outside the window do not dilute the cue.
  const all = P.similarity(byId("pair-glaze").content, null);
  assert.ok(all.bInA < same.bInA);
});

test("windowRange: the overlap ±60 s, everything without an overlap", () => {
  const c = byId("pair-glaze").content;
  const rows = P.mergeLines(c);
  const [from, to] = P.windowRange(rows, P.overlapOf(c), 60);
  assert.ok(from > 0 && to < rows.length && to - from < 25, `${from}..${to} of ${rows.length}`);
  assert.ok(rows.slice(from, to).every((r) => r.start >= 1500 - 60 - 5 && r.start <= 1538 + 60));
  assert.deepEqual(P.windowRange(rows, null), [0, rows.length]);
});

// A transcript item in the older two-capture convention (fictional).
const legacy = {
  id: "cap-1", stratum: "far", title: "Two captures", url: "https://example.com/c/1", round: 2,
  meta: { started_at: "2026-10-08 09:23:00.999506+00:00", overlap_s: 34, pair_type: "same device" },
  summary: "A short chat.", truncated: true, hidden: { jev: { p: 0.7, verdict: "same" } },
  content: { type: "transcript", segments: [
    { speaker: "DIVIDER", is_user: false, name: "━━ Capture A", start: 2105.5, text: "Capture A starts 09:23:00 UTC, lasts 0m 34s" },
    { speaker: "A_0", is_user: false, name: "A · Speaker 0", start: 2105.5, text: "Shall we glaze today?" },
    { speaker: "A_3", is_user: true, name: "A · Speaker 3", start: 2108.8, text: "Yes, the blue one." },
    { speaker: "DIVIDER", is_user: false, name: "━━ Capture B", start: 0.0, text: "Capture B starts 08:47:55 UTC, lasts 1h 39m 51s" },
    { speaker: "B_0", is_user: false, name: "B · Speaker 0", start: 4.0, text: "Welcome to class." },
    { speaker: "B_1", is_user: false, name: "B · Speaker 1", start: 2106.0, end: 2108.0, text: "Shall we glaze today?" },
  ] },
};

test("converter: DIVIDER transcript -> pair, every other key kept", () => {
  const out = transcriptToPair(legacy);
  for (const k of ["id", "stratum", "title", "url", "round", "meta", "summary", "truncated", "hidden"]) assert.deepEqual(out[k], legacy[k], k);
  const c = out.content;
  assert.equal(c.type, "pair");
  assert.deepEqual(c.sides.map((s) => [s.id, s.label, s.start, s.duration_s]), [["A", "Capture A", 2105.5, 34], ["B", "Capture B", 0, 5991]]);
  // started_at anchored on meta.started_at (A's clock matches), B follows the axis.
  assert.equal(c.sides[0].started_at, "2026-10-08T09:23:01.000Z");
  assert.equal(c.sides[1].started_at, "2026-10-08T08:47:55.000Z");
  assert.equal(c.segments.length, 4, "dividers are dropped");
  assert.deepEqual(c.segments[1], { side: "A", speaker: "A_3", name: "Speaker 3", is_user: true, start: 2108.8, text: "Yes, the blue one." });
  assert.equal(c.segments[3].end, 2108);
  assert.deepEqual(pairProblems(c), []);
  assert.deepEqual(P.overlapOf(c), { start: 2105.5, end: 2139.5 });
  assert.equal(P.mergeLines(c).filter((r) => r.kind === "both").length, 1);
  // Not the convention: left alone.
  assert.equal(transcriptToPair({ id: "x", content: { type: "transcript", segments: [{ speaker: "SPEAKER_0", text: "hi", start: 0 }] } }), null);
  assert.equal(transcriptToPair({ id: "y", content: { type: "markdown", body: "x" } }), null);
  assert.equal(transcriptToPair(out), null, "already a pair");
});

test("converter CLI: converts a jsonl, passes others through, never overwrites its input", () => {
  const dir = tmpdir();
  const src = path.join(dir, "items.jsonl");
  const other = { id: "plain", content: { type: "text", body: "hello" } };
  fs.writeFileSync(src, `${JSON.stringify(legacy)}\n${JSON.stringify(other)}\n`);
  const res = convertJsonl(fs.readFileSync(src, "utf8"));
  assert.equal(res.converted, 1);
  assert.equal(res.kept, 1);
  const script = path.join(TOOL, "scripts/transcript-to-pair.js");
  const outFile = path.join(dir, "items.pair.jsonl");
  execFileSync(process.execPath, [script, src, "--out", outFile], { stdio: "pipe" });
  const lines = fs.readFileSync(outFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].content.type, "pair");
  assert.deepEqual(lines[1], other);
  const refuse = spawnSync(process.execPath, [script, src, "--out", src]);
  assert.equal(refuse.status, 2);
  assert.match(String(refuse.stderr), /refusing to overwrite/);
  assert.equal(fs.readFileSync(src, "utf8").split("\n")[0], JSON.stringify(legacy), "input untouched");
});

test("validation: malformed pair content is a warning, the demo is clean", () => {
  const { task } = normalizeTask({ labels: [{ id: "same" }, { id: "different" }] }, "t");
  const line = (c) => JSON.stringify({ id: `i${Math.random()}`, content: { type: "pair", ...c } });
  const { items, warnings } = parseItems([
    line({ sides: [{ id: "A" }], segments: [] }),
    line({ sides: [{ id: "A" }, { id: "A" }], segments: [] }),
    line({ sides: [{ id: "A" }, { id: "B", duration_s: "long" }], segments: [{ side: "C", start: 0, text: "x" }, { side: "A", text: "y" }] }),
    line({ sides: [{ id: "A" }, { id: "B" }], overlap: { start: 3 } }),
  ].join("\n"), task);
  assert.equal(items.length, 4, "warnings never drop an item");
  const w = warnings.join("\n");
  assert.match(w, /exactly two sides/);
  assert.match(w, /side ids must differ/);
  assert.match(w, /duration_s must be a number/);
  assert.match(w, /1 pair segment\(s\) name no known side/);
  assert.match(w, /1 pair segment\(s\) have no start time/);
  assert.match(w, /needs a segments list/);
  assert.match(w, /overlap must be/);
  const demoRes = parseItems(fs.readFileSync(path.join(REPO, "examples/labels/pair-demo/items.jsonl"), "utf8"), task);
  assert.deepEqual(demoRes.warnings, []);
});

test("pair text feeds search and the stand-in brief, in time order with side letters", () => {
  const t = pairText(byId("pair-bakesale").content);
  assert.match(t, /^Pendant \(pendant\), 50s \| Laptop \(laptop mic\), 62s/);
  assert.match(t, /\[0:10\] A · You: Let's start with the bake sale budget\./);
  assert.match(t, /B · Speaker 2: Sorry I'm late/);
  const block = itemBlock({ ...byId("pair-bakesale") }, { user_label: "You", labels: [] }, { maxChars: 4000 });
  assert.match(String(block), /Sorry I'm late/);
});

test("item API serves pair items blind, and search finds their lines", async () => {
  const root = copyExamples();
  const srv = await startServer({ LABELS_ROOT: path.join(root, "labels"), REVIEWER: "rev" });
  try {
    const r = await srv.get("/api/task/pair-demo/item/pair-glaze");
    assert.equal(r.status, 200);
    assert.equal(r.body.item.content.type, "pair");
    assert.equal(r.body.item.hidden, undefined, "model answers stay hidden while blind");
    const s = await srv.get(`/api/search?q=${encodeURIComponent("silica back")}`);
    assert.ok(s.body.results.some((x) => x.type === "item" && x.task === "pair-demo" && x.id === "pair-glaze"), JSON.stringify(s.body.results.slice(0, 3)));
    const page = await fetch(`${srv.base}/pair-logic.js`);
    assert.equal(page.status, 200);
  } finally {
    await srv.stop();
  }
});
