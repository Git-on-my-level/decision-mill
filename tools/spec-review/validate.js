#!/usr/bin/env node
// CLI: validate all spec files against FORMAT.md v1. Exit 1 on any error.
// Warnings (vocabulary/consistency drift) are printed but do not fail the run.
// With --locators, also checks every evidence locator against the configured code
// checkout (REPO_ROOT); those count as errors.
import fs from "node:fs";
import path from "node:path";
import { validateSpecText, checkLocators } from "./lib/parser.js";
import { SPECS_DIR, REPO_ROOT, EXCLUDED, LOCATOR_PREFIX, DELEGATED_PATHS } from "./lib/config.js";

const CHECK_LOCATORS = process.argv.includes("--locators");
// --strict: treat vocabulary/consistency warnings as failures (CI / pre-review gate,
// and the gate before any spec file is deleted).
const STRICT = process.argv.includes("--strict");

if (CHECK_LOCATORS && !fs.existsSync(REPO_ROOT)) {
  console.error(`--locators: code checkout not found at ${REPO_ROOT} (set REPO_ROOT)`);
  process.exit(2);
}
const existsInRepo = (rel) => {
  if (!rel || rel.startsWith("/") || rel.includes("..")) return false;
  return fs.existsSync(path.resolve(REPO_ROOT, rel));
};

let failed = false;
let warnCount = 0;
for (const f of fs.readdirSync(SPECS_DIR).filter((f) => f.endsWith(".md") && !EXCLUDED.has(f)).sort()) {
  const slug = f.replace(/\.md$/, "");
  const { items, errors, warnings } = validateSpecText(fs.readFileSync(path.join(SPECS_DIR, f), "utf8"), slug);
  const errs = [...errors];
  if (CHECK_LOCATORS) errs.push(...checkLocators(items, existsInRepo));
  // A bare `toss` is unreadable once the spec is disposed of and only the decision
  // survives. Every toss needs a decision_detail with a disambiguating prefix
  // (see FORMAT.md).
  const TOSS_PREFIX = /^(remove|change|resolved|moot):/;
  for (const it of items) {
    if (it.meta.decision === "toss") {
      const detail = (it.meta.decision_detail || "").trim();
      if (!detail) warnings.push(`${it.id}: toss with null decision_detail (required before spec deletion)`);
      else if (!TOSS_PREFIX.test(detail)) warnings.push(`${it.id}: toss detail lacks remove:/change:/resolved:/moot: prefix`);
    }
    // Delegated-ownership rule (opt-in, DELEGATED_PATHS): an item whose evidence lives
    // entirely under code owned by another team describes a mechanism this review
    // cannot decide. `file` is the only verdict that gives it an owner; keep/toss/unify
    // on such an item is the batch-error class that silently orphans guarantees.
    if (DELEGATED_PATHS.length) {
      const evidence = Array.isArray(it.meta.evidence) ? it.meta.evidence : [];
      const decision = it.meta.decision;
      const delegated = (loc) => DELEGATED_PATHS.some((d) => String(loc).startsWith(LOCATOR_PREFIX + d));
      if (decision && decision !== "file" && decision !== "defer" && evidence.length > 0 &&
          evidence.every((ev) => delegated(ev?.locator || ""))) {
        warnings.push(`${it.id}: all evidence is under a delegated path but decision is '${decision}' (expected file — another team owns this mechanism)`);
      }
    }
  }
  if (errs.length) {
    failed = true;
    console.log(`FAIL ${f}`);
    for (const e of errs) console.log(`  - ${e}`);
  } else {
    const decided = items.filter((i) => (i.meta.status || "open") === "decided").length;
    console.log(`ok   ${f}  (${items.length} items, ${decided} decided)`);
  }
  for (const w of warnings) { warnCount++; console.log(`  warn ${slug}: ${w}`); }
}
if (warnCount) {
  console.log(`\n${warnCount} warning(s)${STRICT ? " — failing under --strict." : " — format drift, not blocking (pass --strict to fail)."}`);
  if (STRICT) failed = true;
}
process.exit(failed ? 1 : 0);
