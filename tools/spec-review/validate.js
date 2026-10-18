#!/usr/bin/env node
// CLI: validate all spec files against FORMAT.md v1, and every label task against
// LABELS.md v1 (including frozen waves). Exit 1 on any error.
// Warnings (vocabulary/consistency drift) are printed but do not fail the run.
// With --locators, also checks every locator — structured evidence and inline
// prose — against its root's checkout (LOCATOR_ROOTS / REPO_ROOT, plus a spec
// set's decision-mill.yaml locator_roots); those count as errors.
import fs from "node:fs";
import path from "node:path";
import { validateSpecText, checkLocators, crossFileWarnings } from "./lib/parser.js";
import { SPECS_DIRS, LABELS_ROOTS, EXCLUDED } from "./lib/config.js";
import { loadSpecSetConfig, rootsForSet } from "./lib/specset.js";
import { discoverTasks, loadTask } from "./lib/task.js";
import { readTaskLabels } from "./lib/labelstore.js";
import { validateWaves } from "./lib/waves.js";

const KNOWN = new Set(["--locators", "--strict", "--help", "-h", "--specs", "--labels"]);
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`usage: node validate.js [--strict] [--locators] [--specs DIR[,DIR]] [--labels ROOT[,ROOT]]

  Lints every spec set (FORMAT.md) and label task (LABELS.md) that is configured
  (SPECS_DIR / LABELS_ROOT, or the flags). Exit 1 on any error.
  --strict     warnings fail the run too (the gate before deleting a spec)
  --locators   check every evidence and inline prose locator against its checkout`);
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  const a = args[i].split("=")[0];
  if (a === "--specs" || a === "--labels") { if (!args[i].includes("=")) i++; continue; }
  if (!KNOWN.has(a)) { console.error(`validate.js: unknown argument '${args[i]}' (see --help)`); process.exit(2); }
}
const CHECK_LOCATORS = args.includes("--locators");
// --strict: treat vocabulary/consistency warnings as failures (CI / pre-review gate,
// and the gate before any spec file is deleted).
const STRICT = args.includes("--strict");

let failed = false;
let warnCount = 0;
const missingRoots = new Set();
for (const dir of SPECS_DIRS) {
  if (!fs.existsSync(dir)) { console.log(`FAIL specs dir not found: ${dir}`); failed = true; continue; }
  const cfg = loadSpecSetConfig(dir);
  const roots = rootsForSet(cfg);
  const opts = { schemes: Object.keys(roots), decisions: cfg.customDecisions ? cfg.decisions : null, setDecisions: cfg.decisions, options: cfg.options };
  if (SPECS_DIRS.length > 1 || cfg.present) console.log(`specs ${dir}${cfg.present ? `  (${path.basename(cfg.file)}: ${cfg.customDecisions ? `decisions ${cfg.decisions.map((d) => d.id).join("/")}` : "default decisions"}${cfg.options.length ? `, options ${cfg.options.map((o) => o.id).join("/")}` : ""}${cfg.instructions ? ", instructions" : ""})` : ""}`);
  if (cfg.errors.length) { failed = true; console.log(`FAIL ${path.basename(cfg.file)}`); for (const e of cfg.errors) console.log(`  - ${e}`); }
  for (const w of cfg.warnings) { warnCount++; console.log(`  warn ${w}`); }
  if (CHECK_LOCATORS) {
    for (const [k, r] of Object.entries(roots)) {
      if (!fs.existsSync(r) && !missingRoots.has(r)) {
        missingRoots.add(r);
        console.log(`FAIL --locators: checkout for ${k}: not found at ${r} (set LOCATOR_ROOTS="${k}=/path" or REPO_ROOT)`);
        failed = true;
      }
    }
  }
  const existsIn = (scheme, rel) => {
    const root = roots[scheme];
    if (!root || !fs.existsSync(root) || !rel || rel.startsWith("/") || rel.split("/").includes("..")) return false;
    return fs.existsSync(path.resolve(root, rel));
  };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !EXCLUDED.has(f)).sort();
  const parsed = files.map((f) => {
    const slug = f.replace(/\.md$/, "");
    return { f, slug, ...validateSpecText(fs.readFileSync(path.join(dir, f), "utf8"), slug, opts) };
  });
  const cross = crossFileWarnings(parsed);
  for (const { f, slug, items, errors, warnings } of parsed) {
    const errs = [...errors];
    if (CHECK_LOCATORS) errs.push(...checkLocators(items, (s, rel) => !fs.existsSync(roots[s] || "") || existsIn(s, rel), opts));
    const warns = [...warnings, ...cross.get(slug)];
    if (errs.length) {
      failed = true;
      console.log(`FAIL ${f}`);
      for (const e of errs) console.log(`  - ${e}`);
    } else {
      const decided = items.filter((i) => (i.meta.status || "open") === "decided").length;
      console.log(`ok   ${f}  (${items.length} items, ${decided} decided)`);
    }
    for (const w of warns) { warnCount++; console.log(`  warn ${slug}: ${w}`); }
  }
}
// Label tasks: structure only (task.yaml, items.jsonl, label rows that parse).
for (const t of discoverTasks(LABELS_ROOTS)) {
  const { task, items, errors, warnings } = loadTask(t.dir, t.id);
  const wv = validateWaves(t.dir, task, items);
  errors.push(...wv.errors); warnings.push(...wv.warnings);
  const labels = readTaskLabels(t.dir);
  const bad = Object.entries(labels.reviewers).filter(([, r]) => r.bad).map(([n, r]) => `labels/${n}.jsonl: ${r.bad} unparseable row(s) (skipped)`);
  if (errors.length) {
    failed = true;
    console.log(`FAIL task ${t.id}`);
    for (const e of errors) console.log(`  - ${e}`);
  } else {
    const labeled = Object.values(labels.reviewers).reduce((a, r) => a + [...r.states.values()].filter((s) => s.label != null).length, 0);
    console.log(items.length ? `ok   task ${t.id}  (${items.length} items, ${labeled} reviewer labels)`
      : `ok   task ${t.id}  (waiting for items${task.pending ? "" : "; add task.yaml pending: to say how they get made"})`);
  }
  for (const w of [...warnings, ...bad]) { warnCount++; console.log(`  warn task ${t.id}: ${w}`); }
}
if (!SPECS_DIRS.length && !LABELS_ROOTS.length) { console.log("nothing to validate: set SPECS_DIR / LABELS_ROOT or pass --specs / --labels"); failed = true; }

if (warnCount) {
  console.log(`\n${warnCount} warning(s)${STRICT ? " — failing under --strict." : " — format drift, not blocking (pass --strict to fail)."}`);
  if (STRICT) failed = true;
}
process.exit(failed ? 1 : 0);
