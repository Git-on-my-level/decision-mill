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
import * as yaml from "js-yaml";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
// tools/spec-review/lib -> repository root
export const PROJECT_ROOT = path.resolve(HERE, "../../..");

// Minimal argv reader: only the flags below take a value; everything else (for
// example validate.js's --strict) is left alone.
const VALUE_FLAGS = new Set(["--specs", "--labels", "--port", "--host", "--reviewer", "--hub"]);
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

// A locator scheme: "repo" or "repo:" normalized to the bare name.
export const SCHEME_RE = /^[a-z][a-z0-9+.-]*$/;
export const normScheme = (s) => String(s || "").trim().replace(/:+$/, "");

// Locator roots: scheme -> checkout. `LOCATOR_ROOTS="omi=/path/a,kb=/path/b"`
// declares several; `LOCATOR_PREFIX` + `REPO_ROOT` is the single-root case (and is
// still added when either is set explicitly alongside LOCATOR_ROOTS). The first
// root is the primary one: LOCATOR_PREFIX/REPO_ROOT below name it, for callers
// that only know about one.
export function parseLocatorRoots(spec, baseDir = process.cwd()) {
  const roots = {};
  const errors = [];
  for (const part of String(spec || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    const scheme = normScheme(eq > 0 ? part.slice(0, eq) : "");
    const dir = eq > 0 ? part.slice(eq + 1).trim() : "";
    if (!SCHEME_RE.test(scheme) || !dir) { errors.push(`bad locator root '${part}' (want scheme=/path, e.g. repo=/src/app)`); continue; }
    roots[scheme] = path.resolve(baseDir, expandHome(dir));
  }
  return { roots, errors };
}

// ---------- hub: one server, several roots ----------
// A small YAML file lists every labels root and spec set one server should offer,
// so one URL serves everything (FORMAT.md "Hub config"). `--hub FILE` or
// DECISION_MILL_HUB=FILE names it; with no --specs/--labels/SPECS_DIR/LABELS_ROOT
// at all, ~/.config/decision-mill/hub.yaml is used when it exists.
// DECISION_MILL_HUB= (empty) turns the default off. Flags and env add to it.
export const DEFAULT_HUB_FILE = path.join(os.homedir(), ".config/decision-mill/hub.yaml");
const anyRootFlag = Boolean(FLAGS["--specs"] || process.env.SPECS_DIR || FLAGS["--labels"] || process.env.LABELS_ROOT);
const hubPath = (FLAGS["--hub"] || []).at(-1)
  || (process.env.DECISION_MILL_HUB != null ? process.env.DECISION_MILL_HUB || null
    : !anyRootFlag && fs.existsSync(DEFAULT_HUB_FILE) ? DEFAULT_HUB_FILE : null);

const slug = (s) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
export function loadHub(file) {
  const hub = { file: path.resolve(expandHome(file)), labels: [], specs: [], workspaces: {}, locatorRoots: {}, errors: [], warnings: [], title: null };
  let raw;
  try { raw = yaml.load(fs.readFileSync(hub.file, "utf8")); }
  catch (e) { hub.errors.push(e.code === "ENOENT" ? `hub file not found: ${hub.file}` : `hub file: ${e.message}`); return hub; }
  if (raw == null) return hub;
  if (typeof raw !== "object" || Array.isArray(raw)) { hub.errors.push("hub file must be a mapping"); return hub; }
  const base = path.dirname(hub.file);
  const known = new Set(["title", "labels", "specs", "workspaces", "port", "host", "reviewer", "project_name", "locator_roots"]);
  for (const k of Object.keys(raw)) if (!known.has(k)) hub.warnings.push(`hub: unknown key '${k}' (want ${[...known].join(", ")})`);
  const entries = (key) => {
    const v = raw[key];
    if (v == null) return [];
    const list = Array.isArray(v) ? v : [v];
    const out = [];
    for (const e of list) {
      const dir = typeof e === "string" ? e : e && typeof e === "object" ? e.dir || e.path : null;
      if (!dir || typeof dir !== "string") { hub.errors.push(`hub ${key}: each entry is a path or {dir, workspace}`); continue; }
      out.push({ dir: path.resolve(base, expandHome(dir.trim())), workspace: e && typeof e === "object" && e.workspace != null ? slug(e.workspace) || null : null });
    }
    return out;
  };
  hub.labels = entries("labels");
  hub.specs = entries("specs");
  if (raw.workspaces != null) {
    if (typeof raw.workspaces !== "object" || Array.isArray(raw.workspaces)) hub.errors.push("hub workspaces must be a mapping of id: {title, project, owner}");
    else for (const [k, v] of Object.entries(raw.workspaces)) {
      const id = slug(k);
      if (!id) { hub.warnings.push(`hub workspaces: bad id '${k}'`); continue; }
      const o = v && typeof v === "object" ? v : {};
      hub.workspaces[id] = { id, title: o.title != null ? String(o.title) : null, project: o.project != null ? String(o.project) : null, owner: o.owner != null ? String(o.owner) : null };
    }
  }
  for (const k of ["port", "host", "reviewer", "project_name", "title"]) if (raw[k] != null) hub[k] = String(raw[k]);
  if (raw.locator_roots != null) {
    if (typeof raw.locator_roots !== "object" || Array.isArray(raw.locator_roots)) hub.errors.push("hub locator_roots must be a mapping of scheme: path");
    else for (const [k, v] of Object.entries(raw.locator_roots)) hub.locatorRoots[String(k).replace(/:+$/, "")] = path.resolve(base, expandHome(String(v)));
  }
  return hub;
}
export const HUB = hubPath ? loadHub(hubPath) : null;
if (HUB && HUB.errors.length) throw new Error(`decision-mill hub (${HUB.file}): ${HUB.errors.join("; ")}`);

const rawPrefix = String(process.env.LOCATOR_PREFIX || "repo").trim();
const primaryScheme = normScheme(rawPrefix);
if (!SCHEME_RE.test(primaryScheme)) {
  throw new Error(`LOCATOR_PREFIX must be a scheme like "repo" or "acme" (got "${rawPrefix}")`);
}
const envRoots = parseLocatorRoots(process.env.LOCATOR_ROOTS);
if (envRoots.errors.length) throw new Error(`LOCATOR_ROOTS: ${envRoots.errors.join("; ")}`);
// A hub's locator_roots count as configured on purpose, below the environment.
if (HUB) for (const [k, v] of Object.entries(HUB.locatorRoots)) if (!(k in envRoots.roots)) envRoots.roots[k] = v;
const singleExplicit = Boolean(process.env.LOCATOR_PREFIX || process.env.REPO_ROOT);
// Global roots, in declaration order. Without LOCATOR_ROOTS this is exactly the old
// single root: `repo:` (or LOCATOR_PREFIX) -> REPO_ROOT (default: this repository).
export const LOCATOR_ROOTS = (() => {
  const out = {};
  if (!Object.keys(envRoots.roots).length || singleExplicit) out[primaryScheme] = process.env.REPO_ROOT || PROJECT_ROOT;
  for (const [k, v] of Object.entries(envRoots.roots)) if (!(k in out)) out[k] = v;
  return out;
})();
// Schemes the operator configured on purpose; they override a spec set's own roots.
export const EXPLICIT_ROOT_SCHEMES = new Set([...(singleExplicit ? [primaryScheme] : []), ...Object.keys(envRoots.roots)]);
// `repo:` by default. Configure per program (`acme:`, `core:`, …) and record the
// choice in an ADR so specs stay portable across checkouts.
export const LOCATOR_SCHEME = Object.keys(LOCATOR_ROOTS)[0];
// The literal string that opens every primary-root locator, e.g. "repo:".
export const LOCATOR_PREFIX = `${LOCATOR_SCHEME}:`;

const specsFlagged = Boolean(FLAGS["--specs"] || process.env.SPECS_DIR);
const labelsFlagged = Boolean(FLAGS["--labels"] || process.env.LABELS_ROOT);
const specsConfigured = specsFlagged || Boolean(HUB && HUB.specs.length);
const labelsConfigured = labelsFlagged || Boolean(HUB && HUB.labels.length);
// With nothing configured at all, a fresh clone serves both bundled examples. As
// soon as either mode is configured explicitly (or a hub is in use), the other
// mode's example is not mixed in — a labeling launch should not show a fictional
// todo spec.
const nothingConfigured = !specsConfigured && !labelsConfigured && !HUB;
const uniq = (list) => [...new Set(list)];

// `<repo>/specs` normally. In a fresh clone of decision-mill itself there is no
// specs/ directory, so fall back to the bundled examples (a capability spec and a
// decision register with its own decision-mill.yaml) — that is what makes
// `node server.js` show a working UI with zero configuration.
function defaultSpecsDirs() {
  const own = path.resolve(PROJECT_ROOT, "specs");
  if (fs.existsSync(own)) return [own];
  const examples = ["examples/specs", "examples/decision-register", "examples/flag-review"].map((d) => path.resolve(PROJECT_ROOT, d)).filter((d) => fs.existsSync(d));
  return examples.length ? examples : [own];
}

// Every spec set the server offers on its home screen. SPECS_DIR may name several
// (comma-separated); the first is the default set for set-less API calls, which is
// what keeps the original single-set API and its curl examples working.
export const SPECS_DIRS = specsConfigured
  ? uniq([...(HUB ? HUB.specs.map((e) => e.dir) : []), ...(specsFlagged ? splitList([...(FLAGS["--specs"] || []), ...(FLAGS["--specs"] ? [] : [process.env.SPECS_DIR])]) : [])])
  : HUB ? [] : nothingConfigured || !labelsConfigured ? defaultSpecsDirs() : [];
export const SPECS_DIR = SPECS_DIRS[0] || null;

// Roots that contain label-task directories (`<root>/<task-id>/task.yaml`). A root
// may also itself be a task directory. Label data belongs OUTSIDE git, so the
// conventional root is ~/.local/share/labels; only the fictional demo ships here.
export const LABELS_ROOTS = labelsConfigured
  ? uniq([...(HUB ? HUB.labels.map((e) => e.dir) : []), ...(labelsFlagged ? splitList([...(FLAGS["--labels"] || []), ...(FLAGS["--labels"] ? [] : [process.env.LABELS_ROOT])]) : [])])
  : nothingConfigured && fs.existsSync(path.resolve(PROJECT_ROOT, "examples/labels"))
    ? [path.resolve(PROJECT_ROOT, "examples/labels")] : [];

// Workspace a hub entry assigns to a root (a task.yaml or decision-mill.yaml
// `workspace:` still wins). path -> workspace id.
export const ROOT_WORKSPACES = new Map(HUB ? [...HUB.labels, ...HUB.specs].filter((e) => e.workspace).map((e) => [e.dir, e.workspace]) : []);
export const HUB_WORKSPACES = HUB ? HUB.workspaces : {};

// Checkout that `<prefix>:<path>` resolves against for the code panel and
// `validate.js --locators`. Defaults to this repository, which is what makes the
// bundled example spec open real files with no configuration at all.
// With LOCATOR_ROOTS, this is the primary (first) root.
export const REPO_ROOT = LOCATOR_ROOTS[LOCATOR_SCHEME];

export const PORT = Number((FLAGS["--port"] || []).at(-1) || process.env.PORT || (HUB && HUB.port) || 4599);
// Loopback by default. Serving to another machine is better done with a reverse
// proxy that terminates on this host (e.g. `tailscale serve`) than by widening
// the bind; HOST exists for the cases where that is not possible.
export const HOST = (FLAGS["--host"] || []).at(-1) || process.env.HOST || (HUB && HUB.host) || "127.0.0.1";

// Shown in the UI sidebar under the product name.
export const PROJECT_NAME = process.env.PROJECT_NAME || (HUB && (HUB.project_name || HUB.title)) || "";

// Attribution written into spec `notes[].by` and the label file name. An explicit
// REVIEWER wins; otherwise a `Tailscale-User-Login` header (set by `tailscale
// serve`) names the person; otherwise "reviewer".
const explicitReviewer = (FLAGS["--reviewer"] || []).at(-1) || process.env.REVIEWER || (HUB && HUB.reviewer) || "";
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
