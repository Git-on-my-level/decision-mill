// Per-card answer options (FORMAT.md "Card options"): the set's option library,
// effective-option resolution and keys, write resolution, the linter, and the
// server's write path on the bundled flag-review example.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { effectiveOptions, normalizeOptionLibrary, resolveWrite, optionFor } from "../lib/options.js";
import { normalizeDecisions, loadSpecSetConfig, publicSetConfig, DEFAULT_DECISIONS } from "../lib/specset.js";
import { validateSpecText } from "../lib/parser.js";
import { tmpdir, startServer, REPO } from "./helpers.js";

const FLAG_SET = {
  decisions: normalizeDecisions([
    { id: "accept", tone: "positive" },
    { id: "change", requires_detail: true },
    { id: "defer" },
  ]).decisions,
  options: normalizeOptionLibrary([
    { id: "graduate", label: "Graduate now", hint: "delete the flag", tone: "positive" },
    { id: "extend", requires_detail: true },
    { id: "ops_kill", label: "Keep as ops kill" },
    { id: "kill", tone: "negative" },
  ]).options,
};
const card = (meta, kind = "decision", id = "DEC-X-001") => ({ id, kind, meta: { kind, ...meta } });
const keys = (eff) => eff.options.map((o) => `${o.id}:${o.key ?? "-"}${o.hidden ? "h" : ""}${o.recommended ? "*" : ""}`);

test("option library: shape, duplicate ids, reserved keys, unknown fields", () => {
  const ok = normalizeOptionLibrary([{ id: "graduate", label: "Graduate now" }, "kill", { id: "ops_kill", key: "o" }]);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.options.map((o) => [o.id, o.label, o.key]), [["graduate", "Graduate now", null], ["kill", "Kill", null], ["ops_kill", "Ops kill", "o"]]);
  const bad = normalizeOptionLibrary([{ id: "Grad" }, { id: "x" }, { id: "x" }, { id: "y", key: "j" }, { id: "unify" }, { id: "z", colour: "red" }]);
  assert.ok(bad.errors.some((e) => /'Grad' must be lowercase/.test(e)));
  assert.ok(bad.errors.some((e) => /duplicate option id 'x'/.test(e)));
  assert.ok(bad.errors.some((e) => /key 'j' is reserved/.test(e)));
  assert.ok(bad.errors.some((e) => /'unify' is the unify flow/.test(e)));
  assert.ok(bad.warnings.some((w) => /unknown key 'colour'/.test(w)));
  assert.ok(normalizeOptionLibrary("nope").errors.length);
});

test("a card without options gets the set's verdicts unchanged, with the proposed one marked", () => {
  const eff = effectiveOptions(card({ proposed: "accept" }), FLAG_SET);
  assert.equal(eff.own, false);
  assert.deepEqual(keys(eff), ["accept:1*", "change:2", "defer:3"]);
  assert.equal(eff.recommended, "accept");
  // The default set on a divergence keeps unify; on anything else it does not.
  assert.deepEqual(keys(effectiveOptions(card({ proposed: "keep" }, "divergence", "DIV-X-001"), { decisions: DEFAULT_DECISIONS })), ["keep:1*", "change:2", "defer:3", "unify:-"]);
  assert.deepEqual(keys(effectiveOptions(card({ proposed: "n/a" }, "unknown", "UNK-X-001"), { decisions: DEFAULT_DECISIONS })), ["keep:1", "change:2", "defer:3"]);
});

test("card options: library refs and overrides, digits in card order, verdicts move to letters", () => {
  const eff = effectiveOptions(card({ proposed: "extend", options: ["graduate", { id: "extend", label: "Extend to 11-06", requires_detail: false }, "ops_kill", "kill"] }), FLAG_SET);
  assert.deepEqual(eff.errors, []);
  assert.equal(eff.own, true);
  assert.equal(eff.recommended, "extend");
  // Accept folds into the recommended option; Change is the Answer box. Both stay valid.
  assert.deepEqual(keys(eff), ["graduate:1", "extend:2*", "ops_kill:3", "kill:4", "accept:-h", "change:-h", "defer:d"]);
  const ext = optionFor(eff, "extend");
  assert.equal(ext.label, "Extend to 11-06");
  assert.equal(ext.requires_detail, false, "a card overrides the library");
  assert.equal(optionFor(eff, "graduate").hint, "delete the flag");
  assert.equal(optionFor(eff, "kill").tone, "negative");
});

test("card options: explicit keys win, digits skip them, a card may list a set verdict", () => {
  const eff = effectiveOptions(card({ proposed: "kill", options: [{ id: "kill", key: "3" }, { id: "raise_cap", label: "Raise the cap" }, "defer", { id: "later", key: "x" }] }), FLAG_SET);
  assert.deepEqual(eff.errors, []);
  assert.deepEqual(keys(eff), ["kill:3*", "raise_cap:1", "defer:2", "later:x", "accept:-h", "change:-h"]);
  // Without a recommendation the accept verdict stays a button (letter-keyed).
  const none = effectiveOptions(card({ proposed: "n/a", options: ["graduate", "kill"] }), FLAG_SET);
  assert.deepEqual(keys(none), ["graduate:1", "kill:2", "accept:c", "change:-h", "defer:d"]);
});

test("card options: duplicate ids and keys, reserved keys, unknown refs and proposals", () => {
  const eff = effectiveOptions(card({ proposed: "graduate_now", options: ["graduate", "graduate", { id: "a1", key: "5" }, { id: "a2", key: "5" }, { id: "a3", key: "k" }, "nonesuch", { label: "no id" }] }), FLAG_SET);
  assert.ok(eff.errors.some((e) => /duplicate option id 'graduate'/.test(e)));
  assert.ok(eff.errors.some((e) => /key '5' bound twice/.test(e)));
  assert.ok(eff.errors.some((e) => /key 'k' is reserved/.test(e)));
  assert.ok(eff.errors.some((e) => /'nonesuch' is not in the set's options or decisions/.test(e)));
  assert.ok(eff.errors.some((e) => /needs an id/.test(e)));
  assert.ok(eff.warnings.some((w) => /proposed 'graduate_now' is not one of this card's options/.test(w)));
  assert.ok(effectiveOptions(card({ options: "graduate" }), FLAG_SET).errors.some((e) => /must be a list/.test(e)));
});

test("resolveWrite: option ids pass, accept picks the recommendation, anything else is refused", () => {
  const eff = effectiveOptions(card({ proposed: "extend", options: ["graduate", "extend", "kill"] }), FLAG_SET);
  assert.deepEqual(resolveWrite(eff, "graduate"), { decision: "graduate" });
  assert.deepEqual(resolveWrite(eff, "accept"), { decision: "extend", via: "accept" });
  assert.deepEqual(resolveWrite(eff, "change"), { decision: "change" }, "the typed answer still records");
  assert.deepEqual(resolveWrite(eff, "defer"), { decision: "defer" });
  assert.match(resolveWrite(eff, "keep").error, /not one of this card's options — want graduate\|extend\|kill\|accept\|change\|defer/);
  assert.match(resolveWrite(eff, "unify-on-web").error, /not one of this card's options/);
  // Divergences keep the unify flow.
  const div = effectiveOptions(card({ proposed: "keep", options: [{ id: "web", label: "Do it like web" }] }, "divergence", "DIV-X-001"), { decisions: DEFAULT_DECISIONS });
  assert.deepEqual(resolveWrite(div, "unify-on-web"), { decision: "unify-on-web" });
  assert.deepEqual(resolveWrite(div, "keep"), { decision: "keep" }, "no recommendation among the options: keep stays itself");
  // Cards without options keep the set-wide rules.
  assert.equal(resolveWrite(effectiveOptions(card({}), FLAG_SET), "file").legacy, true);
});

test("decision-mill.yaml: an options library loads, and reaches the browser", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "decision-mill.yaml"), "decisions: [accept, change, defer]\noptions:\n  - {id: graduate, label: Graduate now}\n  - {id: kill, key: j}\n");
  const cfg = loadSpecSetConfig(dir);
  assert.deepEqual(cfg.options.map((o) => o.id), ["graduate", "kill"]);
  assert.ok(cfg.errors.some((e) => /decision-mill\.yaml: option 'kill': key 'j' is reserved/.test(e)));
  assert.deepEqual(publicSetConfig(cfg, {}).options.map((o) => o.label), ["Graduate now", "Kill"]);
  assert.deepEqual(loadSpecSetConfig(tmpdir()).options, [], "no file: no library");
});

const spec = (items) => `---\nspec: s\ntitle: T\nstatus: draft\nbaseline: abc\n---\n\n` + items.map(([id, meta]) =>
  `### ${id} — title ${id}\n\n\`\`\`adjudication\nid: ${id}\nkind: decision\n${meta}\n\`\`\`\n\nprose\n`).join("\n")
  + "\n### GEN-S-001 — General notes\n\n```adjudication\nid: GEN-S-001\nkind: general\n```\n";

test("validate: options blocks are checked, decisions must be the card's own, old decisions still pass", () => {
  const opts = { decisions: FLAG_SET.decisions, setDecisions: FLAG_SET.decisions, options: FLAG_SET.options };
  const r = validateSpecText(spec([
    ["DEC-S-001", "proposed: extend\noptions: [graduate, extend]\nstatus: decided\ndecision: graduate"],
    ["DEC-S-002", "proposed: nope\noptions: [graduate, graduate, {id: x, key: '1'}, {id: y, key: '1'}]"],
    ["DEC-S-003", "proposed: kill\noptions: [graduate, kill]\nstatus: decided\ndecision: keep"],
    ["DEC-S-004", "proposed: extend\noptions: [extend]\nstatus: decided\ndecision: extend"],
    ["DEC-S-005", "proposed: accept\nstatus: decided\ndecision: change\ndecision_detail: \"change: Graduate now\""],
    ["DEC-S-006", "proposed: kill\noptions: [kill]\nstatus: decided\ndecision: change\ndecision_detail: \"change: graduate instead\""],
  ]), "s", opts);
  assert.ok(r.errors.some((e) => /DEC-S-002: duplicate option id 'graduate'/.test(e)));
  assert.ok(r.errors.some((e) => /DEC-S-002: key '1' bound twice/.test(e)));
  assert.ok(r.warnings.some((w) => /DEC-S-002: proposed 'nope' is not one of this card's options/.test(w)));
  assert.ok(r.warnings.some((w) => /DEC-S-003: decision 'keep' is not one of this card's options/.test(w)));
  assert.ok(r.warnings.some((w) => /DEC-S-004: 'extend' requires a decision_detail/.test(w)));
  assert.ok(!r.errors.concat(r.warnings).some((m) => /DEC-S-00[156]/.test(m)), r.warnings.join("\n"));
});

test("HTTP: card options on the flag-review example — write path, accept, requires_detail, legacy cards", async () => {
  const root = tmpdir();
  fs.cpSync(path.join(REPO, "examples/flag-review"), path.join(root, "flag-review"), { recursive: true });
  fs.cpSync(path.join(REPO, "examples/code"), path.join(root, "code"), { recursive: true });
  const srv = await startServer({ SPECS_DIR: path.join(root, "flag-review"), LABELS_ROOT: "", REPO_ROOT: REPO });
  const post = (id, body) => srv.post(`/api/spec/flags/item/${id}`, { action: "decision", ...body });
  try {
    let r = await srv.get("/api/specs");
    assert.deepEqual(r.body.config.options.map((o) => o.id), ["graduate", "extend", "ops_kill", "kill"]);
    r = await srv.get("/api/spec/flags");
    assert.deepEqual(r.body.parseErrors, []);
    assert.deepEqual(r.body.warnings, []);
    assert.equal(r.body.items[0].meta.options[1].label, "Extend to 11-06");

    r = await post("DEC-FLAG-001", { decision: "nope" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /'nope' is not one of this card's options — want graduate\|extend\|ops_kill\|kill\|accept\|change\|defer/);
    r = await post("DEC-FLAG-001", { decision: "keep" });
    assert.equal(r.status, 400, "a built-in the card does not offer is refused");
    r = await post("DEC-FLAG-001", { decision: "graduate", decision_detail: "mobile port slipped anyway" });
    assert.equal(r.status, 200);
    assert.equal(r.body.item.meta.decision, "graduate");
    assert.equal(r.body.item.meta.decision_detail, "mobile port slipped anyway");
    assert.equal(r.body.item.meta.status, "decided");
    assert.equal(r.body.item.meta.notes.at(-1).text, "decision: graduate — mobile port slipped anyway");
    // Accept records the card's recommendation (DEC-FLAG-002 proposes kill).
    r = await post("DEC-FLAG-002", { decision: "accept" });
    assert.equal(r.body.item.meta.decision, "kill");
    r = await post("DEC-FLAG-002", { decision: "raise_cap" });
    assert.equal(r.body.item.meta.decision, "raise_cap", "card-only options store their id");
    // The library's extend needs a detail unless the card overrides it.
    r = await post("DEC-FLAG-004", { decision: "extend" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /'Extend' needs a decision_detail/);
    r = await post("DEC-FLAG-001", { decision: "extend" });
    assert.equal(r.status, 200, "DEC-FLAG-001 overrides requires_detail: false");
    r = await post("DEC-FLAG-004", { decision: "defer" });
    assert.equal(r.body.item.meta.status, "open", "defer keeps the item open");
    // A card without options keeps the set's rules: change still needs its detail.
    r = await post("DEC-FLAG-003", { decision: "change" });
    assert.equal(r.status, 400);
    r = await post("DEC-FLAG-003", { decision: "change", decision_detail: "change: Graduate now" });
    assert.equal(r.body.item.meta.decision, "change");
    // Undo is unchanged.
    r = await srv.post("/api/spec/flags/item/DEC-FLAG-001", { action: "undecide" });
    assert.equal(r.body.item.meta.decision, null);
    // What landed on disk still validates.
    r = await srv.get("/api/validate");
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    // The browser gets the resolver.
    const page = await fetch(`${srv.base}/`).then((x) => x.text());
    assert.ok(page.indexOf("options-logic.js") < page.indexOf("spec.js"), "options-logic loads before spec mode");
    assert.equal((await fetch(`${srv.base}/options-logic.js`)).status, 200);
    assert.match(srv.output(), /options graduate extend ops_kill kill/, "startup banner lists the library");
  } finally { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
