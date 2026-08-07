// One place where every environment knob is read and normalized, so the server,
// the validator and the parser can never disagree about (for example) what the
// evidence-locator prefix is.
//
// All knobs are optional; the defaults make `node server.js` work against the
// repository the tool is vendored into.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
// tools/spec-review/lib -> repository root
const PROJECT_ROOT = path.resolve(HERE, "../../..");

// `repo:` by default. Configure per program (`acme:`, `core:`, …) and record the
// choice in an ADR so specs stay portable across checkouts.
const rawPrefix = String(process.env.LOCATOR_PREFIX || "repo").trim();
// Accept "repo" or "repo:" and normalize to the bare scheme name.
export const LOCATOR_SCHEME = rawPrefix.replace(/:+$/, "");
if (!/^[a-z][a-z0-9+.-]*$/.test(LOCATOR_SCHEME)) {
  throw new Error(`LOCATOR_PREFIX must be a scheme like "repo" or "acme" (got "${rawPrefix}")`);
}
// The literal string that opens every locator, e.g. "repo:".
export const LOCATOR_PREFIX = `${LOCATOR_SCHEME}:`;

// `<repo>/specs` normally. In a fresh clone of decision-mill itself there is no
// specs/ directory, so fall back to the bundled example — that is what makes
// `node server.js` show a working UI with zero configuration.
function defaultSpecsDir() {
  const own = path.resolve(PROJECT_ROOT, "specs");
  if (fs.existsSync(own)) return own;
  const example = path.resolve(PROJECT_ROOT, "examples/specs");
  if (fs.existsSync(example)) return example;
  return own;
}
export const SPECS_DIR = process.env.SPECS_DIR || defaultSpecsDir();

// Checkout that `<prefix>:<path>` resolves against for the code panel and
// `validate.js --locators`. Defaults to this repository, which is what makes the
// bundled example spec open real files with no configuration at all.
export const REPO_ROOT = process.env.REPO_ROOT || PROJECT_ROOT;

export const PORT = Number(process.env.PORT || 4599);

// Shown in the UI sidebar under the product name.
export const PROJECT_NAME = process.env.PROJECT_NAME || "";

// Attribution written into `notes[].by`. Single-reviewer tool by design.
export const REVIEWER = process.env.REVIEWER || "reviewer";

// Spec-directory files that are documentation, not specs.
export const EXCLUDED = new Set(
  (process.env.SPECS_EXCLUDE || "README.md,FORMAT.md").split(",").map((s) => s.trim()).filter(Boolean),
);

// Optional lint rule: path prefixes (relative to REPO_ROOT) that denote code owned
// by another team/program. An item whose evidence lives entirely under one of these
// cannot be honestly kept/tossed/unified here — it has to be handed to its owner,
// which the spec vocabulary spells `file`. Empty by default; set e.g.
// DELEGATED_PATHS=backend/,infra/ to turn it on.
export const DELEGATED_PATHS = (process.env.DELEGATED_PATHS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
