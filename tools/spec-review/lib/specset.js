// Spec-set configuration: an optional `decision-mill.yaml` next to the spec files.
//
//   instructions: |        # markdown for the reviewer, shown in an Instructions panel
//   decisions:             # replaces the default Keep / Change / Defer / Unify buttons
//     - {id: accept, label: Accept, hint: "…", key: "1"}
//     - {id: change, label: Change, requires_detail: true}
//     - {id: defer}
//   locator_roots:         # extra evidence-locator schemes for this set
//     kb: ../knowledge-base  # relative to this file's directory; ~ allowed
//
// Absent file = the default vocabulary and the global locator roots, i.e. exactly
// the behavior before this file existed. Everything here is pure over the file so
// the server, the validator and the tests share one reading of it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { LOCATOR_ROOTS, EXPLICIT_ROOT_SCHEMES, SCHEME_RE, normScheme } from "./config.js";

export const SET_CONFIG_FILE = "decision-mill.yaml";
export const KNOWN_KEYS = new Set(["instructions", "decisions", "locator_roots"]);
export const TONES = new Set(["positive", "negative", "neutral", "unify"]);
// Keys spec mode's keyboard model owns; a decision may not bind them.
export const RESERVED_SPEC_KEYS = new Set(["j", "k", "u", "e", "i", "?", "/", " ", "escape", "enter"]);
const DECISION_ID_RE = /^[a-z][a-z0-9_-]*$/;
const ITEM_KINDS = new Set(["divergence", "invariant", "failure-case", "unknown", "feature", "decision", "general"]);

// The buttons spec mode has always shown. `unify` is not a stored value: it opens
// the target input and stores `unify-on-<target>`, on divergences only.
export const DEFAULT_DECISIONS = Object.freeze([
  { id: "keep", label: "Keep", key: "1", tone: "positive", hint: "good as-is; the recommendation stays on record", requires_detail: false, kinds: null },
  { id: "change", label: "Change", key: "2", tone: "negative", hint: "needs adjustment per the recorded recommendation (never delete by itself)", requires_detail: false, kinds: null },
  { id: "defer", label: "Defer", key: "3", tone: "neutral", hint: "not now; the item stays open", requires_detail: false, kinds: null },
  { id: "unify", label: "Unify on…", key: null, tone: "unify", hint: "the rewrite adopts one target's behavior on every surface", requires_detail: false, kinds: ["divergence"] },
]);

const DEFAULT_TONE = { keep: "positive", accept: "positive", change: "negative", toss: "negative", unify: "unify" };
const expandHome = (p) => (p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/[-_]/g, " ");

// Normalize a `decisions:` list. Returns { decisions, errors, warnings }; entries
// with errors are dropped so the rest still render.
export function normalizeDecisions(raw) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(raw) || !raw.length) {
    errors.push("decisions must be a non-empty list of {id, label?, hint?, key?, requires_detail?, tone?, kinds?}");
    return { decisions: null, errors, warnings };
  }
  const out = [];
  for (const [i, d] of raw.entries()) {
    const entry = typeof d === "string" ? { id: d } : d;
    if (!entry || typeof entry !== "object" || !entry.id) { errors.push(`decisions[${i}] needs an id`); continue; }
    const id = String(entry.id);
    if (!DECISION_ID_RE.test(id)) { errors.push(`decision id '${id}' must be lowercase letters, digits, - or _ (it is the stored value)`); continue; }
    if (id.startsWith("unify-on-")) { errors.push(`decision id '${id}': declare {id: unify} for the unify-on-<target> flow`); continue; }
    if (out.some((x) => x.id === id)) { errors.push(`duplicate decision id '${id}'`); continue; }
    for (const k of Object.keys(entry)) {
      if (!["id", "label", "hint", "key", "requires_detail", "tone", "kinds"].includes(k)) warnings.push(`decision '${id}': unknown key '${k}'`);
    }
    const tone = entry.tone == null ? DEFAULT_TONE[id] || "neutral" : String(entry.tone);
    if (!TONES.has(tone)) warnings.push(`decision '${id}': unknown tone '${tone}' (want positive|negative|neutral)`);
    let kinds = null;
    if (entry.kinds != null) {
      kinds = (Array.isArray(entry.kinds) ? entry.kinds : [entry.kinds]).map(String);
      for (const k of kinds) if (!ITEM_KINDS.has(k)) warnings.push(`decision '${id}': unknown kind '${k}' in kinds`);
    } else if (id === "unify") kinds = ["divergence"];
    out.push({
      id,
      label: entry.label != null ? String(entry.label) : id === "unify" ? "Unify on…" : titleCase(id),
      hint: entry.hint != null ? String(entry.hint) : "",
      key: entry.key != null && String(entry.key) !== "" ? String(entry.key).toLowerCase() : null,
      tone: TONES.has(tone) ? tone : "neutral",
      requires_detail: entry.requires_detail === true,
      kinds,
    });
    if (entry.requires_detail != null && typeof entry.requires_detail !== "boolean") warnings.push(`decision '${id}': requires_detail must be true or false`);
  }
  // Keys follow the declared order: a missing key gets the next free digit. The
  // unify flow only gets a key when one is declared, as in the default set.
  const used = new Set();
  for (const d of out) {
    if (!d.key) continue;
    if (d.key.length !== 1 && d.key !== "escape" && d.key !== "enter") errors.push(`decision '${d.id}': key '${d.key}' must be a single character`);
    else if (RESERVED_SPEC_KEYS.has(d.key)) errors.push(`decision '${d.id}' uses reserved key '${d.key}' (j k u e i ? / are spec mode's)`);
    else if (used.has(d.key)) errors.push(`key '${d.key}' bound twice in decisions`);
    used.add(d.key);
  }
  for (const d of out) {
    if (d.key || d.id === "unify") continue;
    for (let n = 1; n <= 9; n++) if (!used.has(String(n))) { d.key = String(n); used.add(d.key); break; }
  }
  return { decisions: out.length ? out : null, errors, warnings };
}

// Read `<dir>/decision-mill.yaml`. Never throws: problems come back as errors so
// the UI can show them next to the set and the validator can fail on them.
export function loadSpecSetConfig(dir) {
  const file = path.join(dir, SET_CONFIG_FILE);
  const out = { file, present: false, instructions: "", decisions: DEFAULT_DECISIONS.map((d) => ({ ...d })), customDecisions: false, locatorRoots: {}, errors: [], warnings: [] };
  if (!fs.existsSync(file)) return out;
  out.present = true;
  let raw;
  try { raw = yaml.load(fs.readFileSync(file, "utf8")); } catch (e) { out.errors.push(`${SET_CONFIG_FILE}: ${e.message}`); return out; }
  if (raw == null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) { out.errors.push(`${SET_CONFIG_FILE} must be a mapping`); return out; }
  for (const k of Object.keys(raw)) if (!KNOWN_KEYS.has(k)) out.warnings.push(`${SET_CONFIG_FILE}: unknown key '${k}' (want instructions, decisions, locator_roots)`);
  if (raw.instructions != null) {
    if (typeof raw.instructions !== "string") out.warnings.push(`${SET_CONFIG_FILE}: instructions must be a markdown string`);
    else out.instructions = raw.instructions;
  }
  if (raw.decisions != null) {
    const n = normalizeDecisions(raw.decisions);
    out.errors.push(...n.errors.map((e) => `${SET_CONFIG_FILE}: ${e}`));
    out.warnings.push(...n.warnings.map((e) => `${SET_CONFIG_FILE}: ${e}`));
    if (n.decisions) { out.decisions = n.decisions; out.customDecisions = true; }
  }
  if (raw.locator_roots != null) {
    if (typeof raw.locator_roots !== "object" || Array.isArray(raw.locator_roots)) {
      out.errors.push(`${SET_CONFIG_FILE}: locator_roots must be a mapping of scheme: path`);
    } else {
      for (const [k, v] of Object.entries(raw.locator_roots)) {
        const scheme = normScheme(k);
        if (!SCHEME_RE.test(scheme) || typeof v !== "string" || !v.trim()) { out.errors.push(`${SET_CONFIG_FILE}: bad locator root '${k}: ${v}' (want scheme: path)`); continue; }
        out.locatorRoots[scheme] = path.resolve(dir, expandHome(v.trim()));
      }
    }
  }
  return out;
}

// The roots a set's locators resolve against. Roots configured explicitly in the
// environment (LOCATOR_ROOTS, or LOCATOR_PREFIX/REPO_ROOT) win — they are the
// machine-specific override — then the set's own. The implicit default root
// (`repo:` -> this repository) applies only when nothing declares any root.
export function rootsForSet(cfg, globalRoots = LOCATOR_ROOTS, explicit = EXPLICIT_ROOT_SCHEMES) {
  const own = (cfg && cfg.locatorRoots) || {};
  if (!Object.keys(own).length) return { ...globalRoots };
  const out = {};
  for (const [k, v] of Object.entries(globalRoots)) if (explicit.has(k)) out[k] = v;
  for (const [k, v] of Object.entries(own)) if (!(k in out)) out[k] = v;
  return out;
}

// The ids a set may store besides the built-in vocabulary (unify is a flow, not a value).
export const declaredIds = (cfg) => new Set(cfg && cfg.customDecisions ? cfg.decisions.filter((d) => d.id !== "unify").map((d) => d.id) : []);

// What the browser needs: no absolute paths beyond the scheme names.
export function publicSetConfig(cfg, roots) {
  return {
    present: cfg.present, instructions: cfg.instructions, decisions: cfg.decisions, customDecisions: cfg.customDecisions,
    locatorSchemes: Object.keys(roots), errors: cfg.errors, warnings: cfg.warnings,
  };
}

// Split a locator into {scheme, rel, root}, or {error}. Portable relative paths
// only: no absolute, home- or dot-relative paths, no `..` segments.
export function splitLocator(locator, roots) {
  const s = String(locator || "");
  const colon = s.indexOf(":");
  const schemes = Object.keys(roots);
  const want = schemes.map((k) => `${k}:`).join(" or ");
  if (colon <= 0) return { error: `locator must start with ${want}` };
  const scheme = s.slice(0, colon);
  if (!(scheme in roots)) return { error: `unknown locator scheme '${scheme}:' (declared: ${want})` };
  const rel = s.slice(colon + 1).replace(/\/+$/, "");
  if (!rel) return { error: "empty locator path" };
  if (rel.startsWith("/") || rel.startsWith("~") || rel.split("/").includes("..") || rel.split("/")[0] === ".") return { error: "invalid locator path (use a path relative to the root)" };
  return { scheme, rel, root: roots[scheme] };
}
