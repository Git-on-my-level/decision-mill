// The `variants` content type: the client-side alignment and difference marks
// (public/variants-logic.js), validation and text (lib/variants.js), and the
// fictional variants-asr-demo task parsing clean.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./helpers.js";
import { parseItems, normalizeTask } from "../lib/task.js";
import { variantsProblems, variantsText } from "../lib/variants.js";
import { itemBlock } from "../lib/brief.js";

await import("../public/variants-logic.js");
const V = globalThis.VariantsLogic;
const oddWords = (a) => a.pieces.filter((p) => p.odd).map((p) => p.text);

test("a word only one of three versions says is marked on that version alone", () => {
  const a = V.analyze([
    { id: "A", text: "Call Mirexu about the cobalt." },
    { id: "B", text: "Call Mirexu about the cobalt." },
    { id: "C", text: "Call Miro about the cobalt." },
  ]);
  assert.deepEqual(oddWords(a[0]), []);
  assert.deepEqual(oddWords(a[1]), []);
  assert.deepEqual(oddWords(a[2]), ["Miro"]);
});

test("identical wording is reported as the same, ignoring case and punctuation", () => {
  const a = V.analyze([{ id: "A", text: "Thank you." }, { id: "B", text: "thank you" }, { id: "C", text: "Thanks a lot" }]);
  assert.deepEqual(a[0].same, ["B"]);
  assert.deepEqual(a[1].same, ["A"]);
  assert.deepEqual(a[2].same, []);
});

test("with two versions each difference is marked on both", () => {
  const a = V.analyze([{ id: "A", text: "load the kiln tonight" }, { id: "B", text: "load the kill tonight" }]);
  assert.deepEqual(oddWords(a[0]), ["kiln"]);
  assert.deepEqual(oddWords(a[1]), ["kill"]);
});

test("a missing tail is not marked on the versions that have it when most others also have it", () => {
  const a = V.analyze([
    { id: "A", text: "move the order to Thursday and call Mirexu" },
    { id: "B", text: "move the order to Thursday and call Mirexu" },
    { id: "C", text: "move the order to Thursday" },
  ]);
  assert.deepEqual(oddWords(a[0]), []);
  assert.deepEqual(oddWords(a[1]), []);
});

test("an empty version has no words and does not break the others", () => {
  const a = V.analyze([{ id: "A", text: "" }, { id: "B", text: "hello there" }, { id: "C", text: "hello there" }]);
  assert.equal(a[0].words, 0);
  assert.deepEqual(oddWords(a[1]), []);
});

test("Japanese is compared per character so one changed character is pinned down", () => {
  const a = V.analyze([
    { id: "A", text: "家賃は来月から上がります。" },
    { id: "B", text: "家賃は来月から上がります。" },
    { id: "C", text: "家賃は再来月から下がります。" },
  ]);
  assert.deepEqual(oddWords(a[0]), []);
  assert.ok(oddWords(a[2]).includes("再") && oddWords(a[2]).includes("下"));
  assert.ok(a[0].same.includes("B"));
});

test("runs merge adjacent pieces and keep the original text intact", () => {
  const texts = ["Call Miro about the cobalt.", "Call Mirexu about the cobalt.", "Call Mirexu about the cobalt."];
  const a = V.analyze(texts.map((t, i) => ({ id: "ABC"[i], text: t })));
  for (let i = 0; i < 3; i++) assert.equal(V.runs(a[i].pieces).map((r) => r.text).join(""), texts[i]);
});

test("variantsProblems: needs 2 to 6 distinct variants with text", () => {
  assert.deepEqual(variantsProblems({ variants: [{ id: "A", text: "x" }, { id: "B", text: "" }] }), []);
  assert.ok(variantsProblems({}).length);
  assert.ok(variantsProblems({ variants: [{ id: "A", text: "x" }] }).some((p) => /2 to 6/.test(p)));
  assert.ok(variantsProblems({ variants: [{ id: "A", text: "x" }, { id: "A", text: "y" }] }).some((p) => /differ/.test(p)));
  assert.ok(variantsProblems({ variants: [{ id: "A", text: "x" }, { id: "B" }] }).some((p) => /text must be a string/.test(p)));
});

test("variantsText and the stand-in brief name each version, with (nothing) for an empty one", () => {
  const c = { type: "variants", variants: [{ id: "A", text: "one two" }, { id: "B", text: "", note: "fast" }] };
  assert.equal(variantsText(c), "A: one two\nB (fast): (nothing)");
  const block = itemBlock({ id: "x", content: c }, { labels: [] }, {});
  assert.match(String(block), /A: one two/);
});

test("the fictional variants-asr-demo task parses with no warnings", () => {
  const dir = path.join(REPO, "examples/labels/variants-asr-demo");
  assert.ok(fs.existsSync(path.join(dir, "items.jsonl")));
  const { task } = normalizeTask(JSON.parse(JSON.stringify({ labels: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }, { id: "tie" }, { id: "none" }] })), "t");
  const res = parseItems(fs.readFileSync(path.join(dir, "items.jsonl"), "utf8"), task);
  assert.deepEqual(res.errors, []);
  assert.equal(res.items.length, 4);
  assert.deepEqual(res.warnings.filter((w) => /variants|content/.test(w)), []);
});
