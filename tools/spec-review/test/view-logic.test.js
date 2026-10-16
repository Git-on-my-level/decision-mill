// The card-layout helpers behind the decluttered spec cards and the phone
// layout (public/view-logic.js): note folding, decided-item folding, the
// overflow menu's facts, next/previous, swipes, and the disclosure store.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TOOL } from "./helpers.js";

await import("../public/view-logic.js");
const V = globalThis.ViewLogic;

test("classifyNote reads decisions, recommendations and status flips", () => {
  assert.deepEqual(V.classifyNote("decision: accept — ship it"), { type: "decision", verdict: "accept", rest: "ship it" });
  assert.deepEqual(V.classifyNote("decision: defer"), { type: "decision", verdict: "defer", rest: "" });
  assert.deepEqual(V.classifyNote("rec: change — too wide"), { type: "rec", verdict: "change", rest: "too wide" });
  assert.equal(V.classifyNote("status: team").type, "sys");
  assert.equal(V.classifyNote("decision cleared").type, "sys");
  assert.deepEqual(V.classifyNote("just a thought"), { type: "note", verdict: null, rest: "just a thought" });
  assert.equal(V.classifyNote(null).type, "note");
});

test("splitNotes folds long histories to the last two", () => {
  const n = (i) => ({ text: `n${i}` });
  assert.deepEqual(V.splitNotes([n(1), n(2), n(3)]), { earlier: [], recent: [n(1), n(2), n(3)] });
  const r = V.splitNotes([n(1), n(2), n(3), n(4), n(5)]);
  assert.deepEqual(r.earlier.map((x) => x.text), ["n1", "n2", "n3"]);
  assert.deepEqual(r.recent.map((x) => x.text), ["n4", "n5"]);
  assert.deepEqual(V.splitNotes(undefined), { earlier: [], recent: [] });
  assert.deepEqual(V.splitNotes([null, n(1)]).recent, [n(1)]);
});

test("decided items fold by default; deferred, parked and GEN items never do", () => {
  const it = (meta, kind = "decision", id = "X") => ({ id, kind, meta });
  assert.equal(V.collapsedByDefault(it({ status: "decided", decision: "accept" })), true);
  assert.equal(V.collapsedByDefault(it({ status: "decided", decision: "accept" }), new Set(["X"])), false, "expanded by the reviewer");
  assert.equal(V.collapsedByDefault(it({ status: "open", decision: "defer" })), false);
  assert.equal(V.collapsedByDefault(it({ status: "team" })), false);
  assert.equal(V.collapsedByDefault(it({ status: "decided", decision: "accept" }, "general")), false);
  assert.equal(V.collapsedByDefault(it({ status: "open", decision: null })), false);
});

test("decidedSummary drops the FORMAT.md prefix and squashes whitespace", () => {
  assert.deepEqual(V.decidedSummary({ decision: "change", decision_detail: "change: kill,\n not extend", decided_at: "2026-10-16" }), { decision: "change", detail: "kill, not extend", at: "2026-10-16" });
  assert.deepEqual(V.decidedSummary({ decision: "accept" }), { decision: "accept", detail: "", at: "" });
  assert.equal(V.decidedSummary({ decision: null }), null);
});

test("itemFacts lists what moved into the ⋯ menu", () => {
  const facts = V.itemFacts({ kind: "divergence", meta: { proposed: "toss", confidence: "low", status: "open" } }, { divergence: "DIV" });
  assert.deepEqual(facts, [["kind", "DIV · divergence"], ["proposed", "change"], ["confidence", "low"], ["status", "open"]]);
  assert.deepEqual(V.itemFacts({ kind: "decision", meta: { proposed: "n/a" } }), [["kind", "decision"], ["status", "open"]]);
});

test("stepIndex and nextPending", () => {
  assert.equal(V.stepIndex(0, -1, 1), -1);
  assert.equal(V.stepIndex(3, -1, 1), 0);
  assert.equal(V.stepIndex(3, -1, -1), 2);
  assert.equal(V.stepIndex(3, 2, 1), 2);
  assert.equal(V.stepIndex(3, 0, -1), 0);
  const pending = new Set(["a", "d"]);
  assert.equal(V.nextPending(["a", "b", "c", "d"], "b", (x) => pending.has(x)), "d");
  assert.equal(V.nextPending(["a", "b", "c", "d"], "d", (x) => pending.has(x)), "a", "wraps around");
  assert.equal(V.nextPending(["a", "b"], "a", () => false), null);
});

test("swipeDirection needs a long, clearly sideways move", () => {
  assert.equal(V.swipeDirection(-120, 10), 1);
  assert.equal(V.swipeDirection(120, -20), -1);
  assert.equal(V.swipeDirection(-50, 0), 0, "too short");
  assert.equal(V.swipeDirection(-100, 70), 0, "too diagonal");
  assert.equal(V.swipeDirection(NaN, 0), 0);
});

test("disclosureStore remembers, and survives missing or throwing storage", () => {
  const mem = new Map();
  const ok = V.disclosureStore({ getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) });
  assert.equal(ok.get("sources"), false);
  ok.set("sources", true);
  assert.equal(ok.get("sources"), true);
  assert.equal(mem.get("dm:disc:sources"), "1");
  const boom = V.disclosureStore({ getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } });
  assert.equal(boom.get("notes", true), true);
  assert.doesNotThrow(() => boom.set("notes", false));
  assert.equal(V.disclosureStore(null).get("x"), false);
});

test("the page ships the phone layout: safe areas, 16px fields, and the helpers load", () => {
  const html = fs.readFileSync(path.join(TOOL, "public/index.html"), "utf8");
  assert.match(html, /viewport-fit=cover/);
  for (const f of ["view-logic.js", "pair-logic.js"]) assert.match(html, new RegExp(`<script src="${f}"></script>`));
  assert.ok(html.indexOf("view-logic.js") < html.indexOf("spec.js"), "view-logic loads before spec mode");
  const css = fs.readFileSync(path.join(TOOL, "public/style.css"), "utf8");
  const phone = css.slice(css.indexOf("@media (max-width: 640px)"));
  assert.match(phone, /input, textarea, select[^{]*\{ font-size: 16px !important; \}/, "iOS does not zoom into fields");
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(css, /^\.note \{/m, "the label note style is scoped, not a bare .note");
});
