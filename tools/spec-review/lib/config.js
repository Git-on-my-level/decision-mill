// One place where every environment knob is read and normalized, so the server,
// the validator, the parser and the labels CLI can never disagree about (for
// example) what the evidence-locator prefix is or where the label tasks live.
//
// All knobs are optional; the defaults make `node server.js` work against the
// repository the tool is vendored into. A few have CLI-flag twins
// (`--specs DIR`, `--labels DIR`, `--port N`, `--host H`, `--reviewer NAME`)
// because a launch command is easier to copy than an environment block.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
// tools/spec-review/lib -> repository root
export const PROJECT_ROOT = path.resolve(HERE, "../../..");

// Minimal argv reader: only the flags below take a value; everything else (for
// example validate.js's --strict) is left alone.
const VALUE_FLAGS = new Set(["--specs", "--labels", "--port", "--host", "--reviewer"]);
function readFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (!VALUE_FLAGS.has(name)) continue;
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (value == null) continue;
    (out[name] ||= []).push(value);
  }
  return out;
}
const FLAGS = readFlags(process.argv.slice(2));

const expandHome = (p) => (p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
// A list knob accepts commas (and the platform path delimiter) so one env var can
// name several spec sets or label roots.
const splitList = (vals) => vals
  .flatMap((v) => String(v).split(new RegExp(`[,${path.delimiter === ";" ? ";" : ":"}]`)))
  .map((s) => s.trim()).filter(Boolean)
  .map((s) => path.resolve(expandHome(s)));

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

const specsConfigured = Boolean(FLAGS["--specs"] || process.env.SPECS_DIR);
const labelsConfigured = Boolean(FLAGS["--labels"] || process.env.LABELS_ROOT);
// With nothing configured at all, a fresh clone serves both bundled examples. As
// soon as either mode is configured explicitly, the other mode's example is not
// mixed in — a labeling launch should not show a fictional todo spec.
const nothingConfigured = !specsConfigured && !labelsConfigured;

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

// Every spec set the server offers on its home screen. SPECS_DIR may name several
// (comma-separated); the first is the default set for set-less API calls, which is
// what keeps the original single-set API and its curl examples working.
export const SPECS_DIRS = specsConfigured
  ? splitList([...(FLAGS["--specs"] || []), ...(FLAGS["--specs"] ? [] : [process.env.SPECS_DIR])])
  : nothingConfigured || !labelsConfigured ? [defaultSpecsDir()] : [];
export const SPECS_DIR = SPECS_DIRS[0] || null;

// Roots that contain label-task directories (`<root>/<task-id>/task.yaml`). A root
// may also itself be a task directory. Label data belongs OUTSIDE git, so the
// conventional root is ~/.local/share/labels; only the fictional demo ships here.
export const LABELS_ROOTS = labelsConfigured
  ? splitList([...(FLAGS["--labels"] || []), ...(FLAGS["--labels"] ? [] : [process.env.LABELS_ROOT])])
  : nothingConfigured && fs.existsSync(path.resolve(PROJECT_ROOT, "examples/labels"))
    ? [path.resolve(PROJECT_ROOT, "examples/labels")] : [];

// Checkout that `<prefix>:<path>` resolves against for the code panel and
// `validate.js --locators`. Defaults to this repository, which is what makes the
// bundled example spec open real files with no configuration at all.
export const REPO_ROOT = process.env.REPO_ROOT || PROJECT_ROOT;

export const PORT = Number((FLAGS["--port"] || []).at(-1) || process.env.PORT || 4599);
// Loopback by default. Serving to another machine is better done with a reverse
// proxy that terminates on this host (e.g. `tailscale serve`) than by widening
// the bind; HOST exists for the cases where that is not possible.
export const HOST = (FLAGS["--host"] || []).at(-1) || process.env.HOST || "127.0.0.1";

// Shown in the UI sidebar under the product name.
export const PROJECT_NAME = process.env.PROJECT_NAME || "";

// Attribution written into spec `notes[].by` and the label file name. An explicit
// REVIEWER wins; otherwise a `Tailscale-User-Login` header (set by `tailscale
// serve`) names the person; otherwise "reviewer".
const explicitReviewer = (FLAGS["--reviewer"] || []).at(-1) || process.env.REVIEWER || "";
export const REVIEWER_EXPLICIT = Boolean(explicitReviewer);
export const REVIEWER = explicitReviewer || "reviewer";

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
