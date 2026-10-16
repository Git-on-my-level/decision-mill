// Spec-set config (decision-mill.yaml), the DEC kind, several locator roots, and
// the set-level lint rules: unit tests, the validator CLI, and the server.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeDecisions, loadSpecSetConfig, rootsForSet, splitLocator, DEFAULT_DECISIONS, declaredIds } from "../lib/specset.js";
import { parseLocatorRoots } from "../lib/config.js";
import { parseSpec, validateSpecText, canonicalDecision, isValidDecision, proseLocators, checkLocators, crossFileWarnings } from "../lib/parser.js";
import { tmpdir, copyExamples, startServer, TOOL, REPO } from "./helpers.js";

const spec = (slug, items, fm = "") => `---\nspec: ${slug}\ntitle: T\nstatus: draft\nbaseline: abc\n${fm}---\n\n` + items.map(([id, meta, prose = ""]) =>
  `### ${id} — title ${id}\n\n\`\`\`adjudication\nid: ${id}\n${meta}\n\`\`\`\n\n${prose}\n`).join("\n");

test("decisions: keys follow the declared order, unify gets none unless declared", () => {
  const { decisions, errors } = normalizeDecisions([{ id: "accept", key: "a" }, "change", { id: "unify" }, { id: "defer", requires_detail: true }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(decisions.map((d) => [d.id, d.key]), [["accept", "a"], ["change", "1"], ["unify", null], ["defer", "2"]]);
  assert.equal(decisions[0].label, "Accept");
  assert.equal(decisions[1].tone, "negative");
  assert.deepEqual(decisions[2].kinds, ["divergence"]);
  assert.equal(decisions[3].requires_detail, true);
});

test("decisions: bad ids, duplicates, reserved and doubled keys are errors", () => {
  const { errors } = normalizeDecisions([{ id: "Keep" }, { id: "x" }, { id: "x" }, { id: "y", key: "j" }, { id: "z", key: "1" }, { id: "w", key: "1" }, { id: "unify-on-web" }]);
  assert.ok(errors.some((e) => /'Keep' must be lowercase/.test(e)));
  assert.ok(errors.some((e) => /duplicate decision id 'x'/.test(e)));
  assert.ok(errors.some((e) => /reserved key 'j'/.test(e)));
  assert.ok(errors.some((e) => /key '1' bound twice/.test(e)));
  assert.ok(errors.some((e) => /declare \{id: unify\}/.test(e)));
  assert.ok(normalizeDecisions([]).errors.length);
});

test("an absent decision-mill.yaml means the default buttons and global roots", () => {
  const dir = tmpdir();
  const cfg = loadSpecSetConfig(dir);
  assert.equal(cfg.present, false);
  assert.equal(cfg.customDecisions, false);
  assert.deepEqual(cfg.decisions.map((d) => d.id), DEFAULT_DECISIONS.map((d) => d.id));
  assert.deepEqual(rootsForSet(cfg, { repo: "/r" }, new Set()), { repo: "/r" });
  assert.equal(declaredIds(cfg).size, 0);
});

test("decision-mill.yaml: instructions, decisions, locator roots relative to the file", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "decision-mill.yaml"), "instructions: |\n  Read **this**.\ndecisions:\n  - {id: accept, hint: as written}\n  - {id: change, requires_detail: true}\nlocator_roots:\n  kb: ../kb\nbogus: 1\n");
  const cfg = loadSpecSetConfig(dir);
  assert.deepEqual(cfg.errors, []);
  assert.ok(cfg.warnings.some((w) => /unknown key 'bogus'/.test(w)));
  assert.match(cfg.instructions, /Read \*\*this\*\*/);
  assert.deepEqual(cfg.decisions.map((d) => [d.id, d.key]), [["accept", "1"], ["change", "2"]]);
  assert.equal(cfg.locatorRoots.kb, path.resolve(dir, "../kb"));
  // The implicit default root drops out; an explicitly configured env root wins.
  assert.deepEqual(rootsForSet(cfg, { repo: "/r" }, new Set()), { kb: path.resolve(dir, "../kb") });
  assert.deepEqual(rootsForSet(cfg, { repo: "/r", kb: "/env-kb" }, new Set(["repo", "kb"])), { repo: "/r", kb: "/env-kb" });
  fs.writeFileSync(path.join(dir, "decision-mill.yaml"), "decisions: nope\n");
  assert.ok(loadSpecSetConfig(dir).errors.some((e) => /non-empty list/.test(e)));
  fs.writeFileSync(path.join(dir, "decision-mill.yaml"), "decisions: [\n");
  assert.ok(loadSpecSetConfig(dir).errors.length, "yaml errors are reported, not thrown");
});

test("LOCATOR_ROOTS parsing and locator splitting across roots", () => {
  const { roots, errors } = parseLocatorRoots("omi=/a, kb:=~/b ,bad", "/base");
  assert.equal(roots.omi, "/a");
  assert.ok(roots.kb.endsWith("/b"));
  assert.ok(errors.some((e) => /bad locator root 'bad'/.test(e)));
  const r = { omi: "/a", kb: "/b" };
  assert.deepEqual(splitLocator("kb:docs/x.md", r), { scheme: "kb", rel: "docs/x.md", root: "/b" });
  assert.match(splitLocator("repo:x", r).error, /unknown locator scheme 'repo:' \(declared: omi: or kb:\)/);
  assert.match(splitLocator("omi:../x", r).error, /invalid locator path/);
  assert.match(splitLocator("omi:/etc/passwd", r).error, /invalid locator path/);
});

test("DEC kind parses, validates and gets no unify", () => {
  const text = spec("flags", [["DEC-FLAGS-001", "kind: decision\nstatus: open\ndecision: null"], ["GEN-FLAGS-001", "kind: general"]]);
  const { items, errors, warnings } = validateSpecText(text, "flags", { schemes: ["repo"] });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(items[0].kind, "decision");
  assert.match(validateSpecText(spec("x", [["DEX-A-001", "kind: decision"]]), "x").errors.join(";"), /looks like an item/);
});

test("declared decision ids validate; legacy values still do; accept stays accept when declared", () => {
  const decisions = normalizeDecisions([{ id: "accept" }, { id: "graduate", requires_detail: true }, { id: "change" }, { id: "defer" }]).decisions;
  const declared = new Set(decisions.map((d) => d.id));
  assert.equal(canonicalDecision("accept", declared), "accept");
  assert.equal(canonicalDecision("accept"), "keep", "without a declaration accept is legacy keep");
  assert.equal(canonicalDecision("toss", declared), "change");
  assert.ok(isValidDecision("graduate", declared));
  assert.ok(!isValidDecision("graduate"));
  const text = spec("s", [
    ["DEC-S-001", "kind: decision\nstatus: decided\ndecision: graduate\ndecision_detail: null"],
    ["DEC-S-002", "kind: decision\nstatus: decided\ndecision: accept"],
    ["DEC-S-003", "kind: decision\nstatus: decided\ndecision: change\ndecision_detail: tighten the cohort"],
    ["DEC-S-004", "kind: decision\nstatus: decided\ndecision: keep"],
    ["DEC-S-005", "kind: decision\nstatus: decided\ndecision: ops_kill"],
  ]);
  const { warnings } = validateSpecText(text, "s", { decisions });
  assert.ok(warnings.some((w) => /DEC-S-001: 'graduate' requires a decision_detail/.test(w)));
  assert.ok(!warnings.some((w) => /DEC-S-002/.test(w)), "a declared accept is not a legacy spelling");
  assert.ok(warnings.some((w) => /DEC-S-003: change detail lacks remove:\/change:\/resolved:\/moot: prefix/.test(w)), "the change prefix rule still applies to a declared change");
  assert.ok(!warnings.some((w) => /DEC-S-004/.test(w)), "legacy/default values stay valid");
  assert.ok(warnings.some((w) => /DEC-S-005: unknown decision 'ops_kill'/.test(w)));
  // Without the set config, the same file reads as before.
  const plain = validateSpecText(text, "s").warnings;
  assert.ok(plain.some((w) => /DEC-S-002: legacy decision 'accept'/.test(w)));
  assert.ok(plain.some((w) => /unknown decision 'graduate'/.test(w)));
});

test("prose locators: any declared scheme, wrapped paths, elisions skipped, no partial-word matches", () => {
  const prose = "See omi:app/a.ts:10-20, and kb:docs/b-\n  c.md. Not myomi:x or omi:.../y.ts or omi: alone.";
  assert.deepEqual(proseLocators(prose, ["omi", "kb"]), [{ locator: "omi:app/a.ts", lines: "10-20" }, { locator: "kb:docs/b-c.md", lines: null }]);
  const items = parseSpec(spec("s", [["DIV-S-001", "kind: divergence\nevidence:\n  - locator: omi:app/a.ts\n  - locator: kb:gone.md", prose]])).items;
  const have = new Set(["omi:app/a.ts", "kb:docs/b-c.md"]);
  const bad = checkLocators(items, (scheme, rel) => have.has(`${scheme}:${rel}`), { schemes: ["omi", "kb"] });
  assert.deepEqual(bad, ["DIV-S-001: evidence locator not in checkout: kb:gone.md"]);
  const bad2 = checkLocators(items, (scheme, rel) => rel !== "docs/b-c.md", { schemes: ["omi", "kb"] });
  assert.deepEqual(bad2, ["DIV-S-001: prose locator not in checkout: kb:docs/b-c.md"]);
});

test("evidence with an undeclared scheme is an error naming the declared ones", () => {
  const text = spec("s", [["DIV-S-001", "kind: divergence\nevidence:\n  - locator: repo:a.ts\n  - locator: kb:/abs.md"]]);
  const { errors } = validateSpecText(text, "s", { schemes: ["omi", "kb"] });
  assert.ok(errors.some((e) => /bad evidence locator \(want omi:<path> or kb:<path>\): repo:a\.ts/.test(e)));
  assert.ok(errors.some((e) => /non-portable evidence locator: kb:\/abs\.md/.test(e)));
});

test("a <CAP> code reused across spec files warns", () => {
  const files = ["a", "b", "c"].map((slug) => ({ slug, items: parseSpec(spec(slug, [["UNK-CAP-001", "kind: unknown"], [`GEN-${slug.toUpperCase()}-001`, "kind: general"]])).items }));
  const w = crossFileWarnings(files);
  assert.deepEqual(w.get("a"), []);
  assert.ok(w.get("b").some((x) => /CAP code 'CAP' is also used by a\.md/.test(x)));
  assert.ok(w.get("c").some((x) => /UNK-CAP-001: id also defined in a\.md/.test(x)));
});

function runValidate(args, env = {}) {
  return spawnSync(process.execPath, ["validate.js", ...args], { cwd: TOOL, encoding: "utf8", env: { ...process.env, SPECS_DIR: "", LABELS_ROOT: "", LOCATOR_ROOTS: "", LOCATOR_PREFIX: "", REPO_ROOT: "", ...env } });
}

test("validate.js: several locator roots, prose locators, set config, duplicate CAP codes", () => {
  const root = tmpdir();
  const specs = path.join(root, "specs");
  fs.mkdirSync(specs);
  fs.mkdirSync(path.join(root, "a/src"), { recursive: true });
  fs.mkdirSync(path.join(root, "kb/docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "a/src/x.ts"), "x\n");
  fs.writeFileSync(path.join(root, "kb/docs/y.md"), "y\n");
  fs.writeFileSync(path.join(specs, "one.md"), spec("one", [["DEC-CAP-001", "kind: decision\nevidence:\n  - locator: omi:src/x.ts", "Also kb:docs/y.md:1."], ["GEN-CAP-001", "kind: general"]]));
  fs.writeFileSync(path.join(specs, "two.md"), spec("two", [["UNK-CAP-001", "kind: unknown\nstatus: decided\ndecision: accept", "Cites kb:docs/missing.md."]]));
  let r = runValidate(["--locators"], { SPECS_DIR: specs, LOCATOR_ROOTS: `omi=${root}/a,kb=${root}/kb` });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /ok {3}one\.md/);
  assert.match(r.stdout, /UNK-CAP-001: prose locator not in checkout: kb:docs\/missing\.md/);
  assert.match(r.stdout, /warn two: CAP code 'CAP' is also used by one\.md/);
  assert.match(r.stdout, /warn two: UNK-CAP-001: legacy decision 'accept'/);
  // The kb root can come from the set's config instead; then accept is a declared id.
  fs.writeFileSync(path.join(specs, "decision-mill.yaml"), `decisions: [accept, change, defer]\nlocator_roots:\n  kb: ../kb\n`);
  fs.writeFileSync(path.join(specs, "two.md"), spec("two", [["UNK-TWO-001", "kind: unknown\nstatus: decided\ndecision: accept", "Cites kb:docs/y.md."]]));
  r = runValidate(["--locators", "--strict"], { SPECS_DIR: specs, LOCATOR_ROOTS: `omi=${root}/a` });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /decisions accept\/change\/defer/);
  // A broken config fails the run.
  fs.writeFileSync(path.join(specs, "decision-mill.yaml"), "decisions: [{id: Bad}]\n");
  r = runValidate([], { SPECS_DIR: specs, LOCATOR_ROOTS: `omi=${root}/a,kb=${root}/kb` });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL decision-mill\.yaml/);
  // A missing root is reported once, by name.
  r = runValidate(["--locators"], { SPECS_DIR: specs, LOCATOR_ROOTS: `omi=${root}/nope` });
  assert.match(r.stdout, /checkout for omi: not found/);
  assert.equal(runValidate(["--bogus"]).status, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("validate.js: the bundled examples (both spec sets) pass, with locators", () => {
  const r = runValidate(["--locators", "--strict"]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /ok {3}todo-lists\.md/);
  assert.match(r.stdout, /ok {3}flags\.md/);
});

test("HTTP: a set's decisions, requires_detail, roots and config errors", async () => {
  const root = copyExamples();
  fs.cpSync(path.join(REPO, "examples/decision-register"), path.join(root, "register"), { recursive: true });
  fs.cpSync(path.join(REPO, "examples/code"), path.join(root, "code"), { recursive: true });
  const srv = await startServer({ SPECS_DIR: `${path.join(root, "specs")},${path.join(root, "register")}`, LABELS_ROOT: path.join(root, "labels"), REPO_ROOT: REPO });
  try {
    const sets = (await srv.get("/api/specsets")).body.sets;
    const reg = sets.find((s) => s.dir.endsWith("register")).id;
    const plain = sets.find((s) => s.dir.endsWith("specs")).id;
    let r = await srv.get(`/api/specs?set=${reg}`);
    assert.equal(r.body.config.customDecisions, true);
    assert.deepEqual(r.body.config.decisions.map((d) => d.id), ["graduate", "extend", "kill", "change", "defer"]);
    assert.match(r.body.config.instructions, /feature flag/);
    assert.deepEqual(r.body.config.locatorSchemes.sort(), ["code", "repo"], "explicit REPO_ROOT stays alongside the set's code: root");
    r = await srv.get(`/api/specs?set=${plain}`);
    assert.equal(r.body.config.customDecisions, false, "no file: default buttons");
    assert.deepEqual(r.body.config.decisions.map((d) => d.id), ["keep", "change", "defer", "unify"]);

    const post = (id, body) => srv.post(`/api/spec/flags/item/${id}?set=${reg}`, { action: "decision", ...body });
    r = await post("DEC-FLAGS-003", { decision: "extend" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /'Extend' needs a decision_detail/);
    r = await post("DEC-FLAGS-003", { decision: "extend", decision_detail: "until the mobile layout ships" });
    assert.equal(r.status, 200);
    assert.equal(r.body.item.meta.decision, "extend");
    assert.equal(r.body.item.meta.status, "decided");
    r = await post("DEC-FLAGS-001", { decision: "nope" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /want graduate\|extend\|kill\|change\|defer\|keep\|file\|unify-on-<slug>/);
    r = await post("DEC-FLAGS-002", { decision: "defer" });
    assert.equal(r.body.item.meta.status, "open", "defer keeps the item open, as before");
    // Code panel: the set's own scheme resolves with ?set=, not without.
    r = await srv.get(`/api/code?set=${reg}&locator=code:server/api/todos.py&lines=31-37`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.ranges, [[31, 37]]);
    r = await srv.get(`/api/code?locator=code:server/api/todos.py`);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /unknown locator scheme 'code:'/);
    r = await srv.get(`/api/code?set=${reg}&locator=code:server/api`);
    assert.ok(r.body.entries.every((e) => e.locator.startsWith("code:server/api/")), "directory entries keep their scheme");
    // append-item accepts DEC ids and validates against the set's vocabulary.
    r = await srv.post(`/api/spec/flags/item/DEC-FLAGS-004?set=${reg}`, { action: "append-item", title: "new flag", meta: { kind: "decision", status: "open", decision: null, evidence: [{ locator: "code:web/src/TodoList.tsx" }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // A broken config shows up, and the defaults still serve.
    fs.writeFileSync(path.join(root, "register/decision-mill.yaml"), "decisions: [{id: Nope}]\n");
    r = await srv.get(`/api/specs?set=${reg}`);
    assert.ok(r.body.config.errors.some((e) => /'Nope' must be lowercase/.test(e)));
    assert.equal(r.body.config.customDecisions, false);
    r = await srv.get(`/api/validate?set=${reg}`);
    assert.equal(r.body.ok, false);
    const home = await srv.get("/api/home");
    assert.equal(home.body.specSets.find((s) => s.id === reg).configErrors, 1);
    assert.match(srv.output(), /decision-mill\.yaml: decisions graduate\[1\] extend\[2\] kill\[3\] change\[4\] defer\[5\] · instructions/, "startup banner lists the set's vocabulary");
  } finally { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("HTTP: duplicate CAP codes appear in the spec header warnings", async () => {
  const root = copyExamples();
  const other = fs.readFileSync(path.join(root, "specs/todo-lists.md"), "utf8").replace("spec: todo-lists", "spec: copy");
  fs.writeFileSync(path.join(root, "specs/copy.md"), other);
  const srv = await startServer({ SPECS_DIR: path.join(root, "specs"), LABELS_ROOT: path.join(root, "labels"), REPO_ROOT: REPO });
  try {
    // Files are read in name order: copy.md claims TODO first.
    const r = await srv.get("/api/spec/todo-lists");
    assert.ok(r.body.warnings.some((w) => /CAP code 'TODO' is also used by copy\.md/.test(w)));
    const v = await srv.get("/api/validate");
    assert.ok(v.body.results.find((x) => x.slug === "todo-lists").warnings.some((w) => /CAP code/.test(w)));
    assert.ok(!v.body.results.find((x) => x.slug === "copy").warnings.some((w) => /CAP code/.test(w)));
  } finally { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
