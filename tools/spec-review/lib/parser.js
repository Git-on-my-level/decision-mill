// Parse and surgically update machine-parsable spec files (specs/FORMAT.md v1).
// Invariant: updates rewrite ONLY the targeted adjudication fence body; all other
// bytes of the file are preserved verbatim.

import * as yaml from "js-yaml";
import { LOCATOR_ROOTS, LOCATOR_PREFIX, DELEGATED_PATHS } from "./config.js";
import { DEFAULT_DECISIONS } from "./specset.js";
import { effectiveOptions, optionFor } from "./options.js";

export const ID_KINDS = ["DIV", "INV", "FC", "UNK", "FEAT", "DEC", "GEN"];
const KIND_ALT = ID_KINDS.join("|");
export const ID_RE = new RegExp(`^(${KIND_ALT})-[A-Z0-9]+-\\d+$`);
const HEADING_RE = new RegExp(`^###\\s+((?:${KIND_ALT})-[A-Z0-9]+-\\d+)\\s+—\\s+(.+?)\\s*$`);
// A heading that *looks* like an adjudicable item but fails HEADING_RE must be
// reported, never silently skipped (a plain "-" instead of "—" used to make an
// item invisible to both the UI and the linter).
const NEAR_HEADING_RE = new RegExp(`^###\\s+(?:(?:${KIND_ALT})\\b|[A-Z]{2,5}-[A-Z0-9]+-\\d+)`);
// What a new item's id must look like (append-item): zero-padded to three digits.
export const NEW_ID_RE = new RegExp(`^(${KIND_ALT})-[A-Z0-9]+-\\d{3}$`);

// Vocabularies from specs/FORMAT.md v1.
export const KINDS = new Set(["divergence", "invariant", "failure-case", "unknown", "feature", "decision", "general"]);
export const STATUSES = new Set(["open", "decided", "needs-metrics", "team"]);
export const SIMPLE_DECISIONS = new Set(["keep", "change", "toss", "accept", "reject", "defer", "file"]);
// Canonical vocabulary is keep|change|defer|file|unify-on-<x>. `toss` and `accept`
// are legacy spellings (the UI always said "Change"/"Keep" but stored these ids) —
// parsers must still accept and render them; writers normalize through this map.
// A spec set that declares one of them (decision-mill.yaml) stores it as declared.
export const LEGACY_DECISIONS = { toss: "change", accept: "keep" };
export const canonicalDecision = (d, declared) => (declared && declared.has(d) ? d : LEGACY_DECISIONS[d] || d);
export const CONFIDENCES = new Set(["high", "med", "low"]);
export const UNIFY_RE = /^unify-on-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LINES_RE = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;
// `change` needs one of these prefixes on its decision_detail (FORMAT.md).
export const CHANGE_PREFIX_RE = /^(remove|change|resolved|moot):/;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const schemesOf = (opts) => (opts && opts.schemes && opts.schemes.length ? opts.schemes : Object.keys(LOCATOR_ROOTS));

// `declared` = the ids a spec set's decision-mill.yaml adds to the vocabulary.
export function isValidDecision(d, declared) {
  return SIMPLE_DECISIONS.has(d) || UNIFY_RE.test(String(d || "")) || Boolean(declared && declared.has(d));
}

// Strip one trailing CR so a CRLF-saved spec file still parses. Byte offsets are
// computed from the raw text, so writes stay surgical either way.
const noCR = (s) => (s.endsWith("\r") ? s.slice(0, -1) : s);

export function parseFrontmatter(text) {
  if (!/^---\r?\n/.test(text)) return { frontmatter: null, error: "missing frontmatter" };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: null, error: "unterminated frontmatter" };
  try {
    return { frontmatter: yaml.load(text.slice(4, end + 1)) };
  } catch (e) {
    return { frontmatter: null, error: `frontmatter yaml: ${e.message}` };
  }
}

// Returns { frontmatter, items, errors }. Each item:
// { id, title, kind, meta, prose, headingStart, fenceBodyStart, fenceBodyEnd }
// fenceBodyStart/End are char offsets of the YAML text inside the fence.
export function parseSpec(text) {
  const errors = [];
  const { frontmatter, error } = parseFrontmatter(text);
  if (error) errors.push(error);

  const items = [];
  const lines = text.split("\n");
  const offsets = new Array(lines.length);
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = off;
    off += lines[i].length + 1;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = noCR(lines[i]);
    const m = line.match(HEADING_RE);
    if (!m) {
      if (NEAR_HEADING_RE.test(line)) {
        errors.push(`line ${i + 1}: heading looks like an item but does not match "### <ID> — <title>" (em dash required): ${line.trim()}`);
      }
      continue;
    }
    const [, id, title] = m;
    // Find the adjudication fence: first non-empty line after heading must open it.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j >= lines.length || lines[j].trim() !== "```adjudication") {
      errors.push(`${id}: no adjudication fence directly after heading`);
      continue;
    }
    const fenceOpen = j;
    let fenceClose = -1;
    for (let k = fenceOpen + 1; k < lines.length; k++) {
      if (lines[k].trim() === "```") { fenceClose = k; break; }
    }
    if (fenceClose === -1) {
      errors.push(`${id}: unterminated adjudication fence`);
      continue;
    }
    const fenceBodyStart = offsets[fenceOpen] + lines[fenceOpen].length + 1;
    const fenceBodyEnd = offsets[fenceClose]; // start of closing ``` line
    let meta = null;
    try {
      meta = yaml.load(text.slice(fenceBodyStart, fenceBodyEnd)) || {};
    } catch (e) {
      errors.push(`${id}: yaml parse error: ${e.message}`);
      continue;
    }
    if (meta.id && meta.id !== id) errors.push(`${id}: yaml id mismatch (${meta.id})`);

    // Prose: from after fence close to next ### / ## heading (or EOF).
    let proseEnd = lines.length;
    for (let k = fenceClose + 1; k < lines.length; k++) {
      if (/^#{1,3}\s/.test(lines[k])) { proseEnd = k; break; }
    }
    const prose = lines.slice(fenceClose + 1, proseEnd).join("\n").trim();

    if (items.some((it) => it.id === id)) errors.push(`${id}: duplicate id`);
    items.push({
      id,
      title,
      kind: meta.kind || null,
      meta,
      prose,
      headingLine: i,
      fenceBodyStart,
      fenceBodyEnd,
    });
  }
  return { frontmatter, items, errors };
}

// Apply `mutate(meta)` to one item's YAML and return the new full file text.
export function updateItem(text, id, mutate) {
  const { items, errors } = parseSpec(text);
  const item = items.find((it) => it.id === id);
  if (!item) throw new Error(`item not found: ${id}`);
  const blocking = errors.filter((e) => e.startsWith(`${id}:`));
  if (blocking.length) throw new Error(`item ${id} not editable: ${blocking.join("; ")}`);
  const meta = item.meta;
  // A mutate() that returns false means "nothing to change" — return the original
  // bytes so a no-op action never even re-emits the block.
  if (mutate(meta) === false) return text;
  // lineWidth: -1 — never fold. Folding reflowed every long evidence locator and
  // note into a block scalar on each write, which (a) buried the one real change
  // in a 30-line diff and (b) split evidence locators across lines, breaking
  // grep- and lint-based locator scanning.
  const dumped = dumpMeta(meta);
  return text.slice(0, item.fenceBodyStart) + dumped + text.slice(item.fenceBodyEnd);
}

// One dump config everywhere, so an appended item's fence is byte-identical to
// what a later updateItem would re-emit.
export function dumpMeta(meta) {
  return yaml.dump(meta, { lineWidth: -1, noRefs: true, quotingType: '"' });
}

// Is `loc` a locator under one of `schemes`, and is its path portable? Returns
// null when fine, else the problem.
function locatorProblem(loc, schemes) {
  const s = String(loc || "");
  const scheme = schemes.find((k) => s.startsWith(`${k}:`));
  const want = schemes.map((k) => `${k}:<path>`).join(" or ");
  if (!scheme) return `bad evidence locator (want ${want}): ${loc}`;
  // An absolute, home-relative or dot-relative locator is machine-specific and
  // defeats the point of the prefix.
  if (/^(\/|~|\.\.?\/)/.test(s.slice(scheme.length + 1))) return `non-portable evidence locator: ${loc}`;
  return null;
}

// errors = structural problems that make the file unusable or unsafe to edit.
// warnings = vocabulary/consistency drift worth fixing but not blocking.
// opts (all optional): { schemes: locator schemes this set accepts (default: the
// global roots), decisions: the set's declared decision list (decision-mill.yaml),
// setDecisions: the set's verdicts defaults included, options: its option library }.
// The last two resolve a card's own `options:` (FORMAT.md "Card options").
export function validateSpecText(text, slug, opts = {}) {
  const { frontmatter, items, errors } = parseSpec(text);
  const schemes = schemesOf(opts);
  const declared = new Set((opts.decisions || []).filter((d) => d.id !== "unify").map((d) => d.id));
  const errs = [...errors];
  const warns = [];
  if (!frontmatter) errs.push("no frontmatter");
  else {
    if (slug && frontmatter.spec !== slug) errs.push(`frontmatter spec '${frontmatter.spec}' != filename '${slug}'`);
    for (const key of ["spec", "title", "status", "baseline"]) {
      if (!frontmatter[key]) errs.push(`frontmatter missing '${key}'`);
    }
  }
  for (const it of items) {
    const meta = it.meta || {};
    if (!ID_RE.test(it.id)) errs.push(`${it.id}: malformed id`);
    else if (!/-\d{3}$/.test(it.id)) warns.push(`${it.id}: id number is not zero-padded to 3 digits`);
    if (!meta.kind) errs.push(`${it.id}: missing kind`);
    else if (!KINDS.has(meta.kind)) warns.push(`${it.id}: unknown kind '${meta.kind}' (want ${[...KINDS].join("|")})`);
    if (meta.status != null && !STATUSES.has(meta.status)) warns.push(`${it.id}: unknown status '${meta.status}' (want ${[...STATUSES].join("|")})`);
    // A card with its own options: the block must resolve, and a stored decision
    // must be one of the card's effective options (its own, or a set verdict).
    const eff = meta.options != null ? effectiveOptions(it, { decisions: opts.setDecisions || opts.decisions || DEFAULT_DECISIONS, options: opts.options || [] }) : null;
    if (eff) {
      errs.push(...eff.errors.map((e) => `${it.id}: ${e}`));
      warns.push(...eff.warnings.map((w) => `${it.id}: ${w}`));
    }
    if (eff && eff.own) {
      if (meta.decision != null && !optionFor(eff, meta.decision)) {
        warns.push(`${it.id}: decision '${meta.decision}' is not one of this card's options (want ${eff.options.filter((o) => o.id !== "unify").map((o) => o.id).join("|")})`);
      }
    } else if (meta.decision != null && !isValidDecision(meta.decision, declared)) {
      warns.push(`${it.id}: unknown decision '${meta.decision}' (want ${[...new Set([...declared, "keep", "change", "defer", "file"])].join("|")}|unify-on-<x>)`);
    }
    if (meta.confidence != null && !CONFIDENCES.has(meta.confidence)) warns.push(`${it.id}: unknown confidence '${meta.confidence}' (want high|med|low)`);
    if (meta.decision != null && meta.status === "open" && meta.decision !== "defer") {
      warns.push(`${it.id}: has decision '${meta.decision}' but status is still open`);
    }
    // `explanation` is optional plain-English framing for the human deciding.
    // Never required — a missing explanation is not drift, only a wrong type is.
    if (meta.explanation != null && typeof meta.explanation !== "string") {
      warns.push(`${it.id}: explanation must be a string (1–3 plain-English sentences)`);
    }
    if (meta.evidence != null && !Array.isArray(meta.evidence)) errs.push(`${it.id}: evidence must be a list`);
    for (const ev of Array.isArray(meta.evidence) ? meta.evidence : []) {
      if (!ev || typeof ev !== "object") { errs.push(`${it.id}: evidence entry must be a mapping`); continue; }
      const problem = locatorProblem(ev.locator, schemes);
      if (problem) errs.push(`${it.id}: ${problem}`);
      if (ev.lines != null && !LINES_RE.test(String(ev.lines))) {
        warns.push(`${it.id}: unparseable evidence lines '${ev.lines}' (want N, N-M, or comma-separated ranges)`);
      }
    }
    // `metrics` is optional grounding data written by a metrics agent. It is never
    // required, and a malformed block must not block editing the item — warn only.
    if (meta.metrics != null) {
      const mx = meta.metrics;
      if (typeof mx !== "object" || Array.isArray(mx)) {
        warns.push(`${it.id}: metrics must be a mapping with as_of/source/points`);
      } else if (mx.points != null && !Array.isArray(mx.points)) {
        warns.push(`${it.id}: metrics.points must be a list`);
      } else {
        const pts = Array.isArray(mx.points) ? mx.points : [];
        if (pts.length > 4) warns.push(`${it.id}: metrics has ${pts.length} points (keep to at most 4)`);
        for (const p of pts) {
          if (!p || typeof p !== "object" || Array.isArray(p)) { warns.push(`${it.id}: metrics point must be a mapping`); continue; }
          if (!p.label) warns.push(`${it.id}: metrics point missing label`);
          if (p.value == null || p.value === "") warns.push(`${it.id}: metrics point '${p.label || "?"}' missing value`);
        }
        if (!mx.as_of) warns.push(`${it.id}: metrics missing as_of`);
        if (!mx.source) warns.push(`${it.id}: metrics missing source`);
      }
    }
    if (meta.notes != null && !Array.isArray(meta.notes)) errs.push(`${it.id}: notes must be a list`);
    for (const n of Array.isArray(meta.notes) ? meta.notes : []) {
      if (!n || typeof n !== "object" || typeof n.text !== "string") errs.push(`${it.id}: malformed note entry`);
    }
    warns.push(...decisionWarnings(it, { declared, decisions: eff && eff.own ? eff.options : opts.decisions || null }));
  }
  if (!items.length) errs.push("no adjudicable items found");
  return { frontmatter, items, errors: errs, warnings: warns };
}

// The rules that keep a decision readable once the spec is disposed of. Shared by
// the validator and the spec header (they used to live only in validate.js, so the
// UI header showed fewer warnings than the README promised).
export function decisionWarnings(it, { declared = new Set(), decisions = null } = {}) {
  const out = [];
  const d = it.meta.decision;
  if (d == null) return out;
  const detail = String(it.meta.decision_detail || "").trim();
  // A bare `change` is unreadable once only the decision survives: every change
  // needs a decision_detail with a disambiguating prefix. `toss` is the legacy
  // spelling — unless the set declares `toss` as its own id.
  if (d === "change" || (d === "toss" && !declared.has("toss"))) {
    if (!detail) out.push(`${it.id}: ${d} with null decision_detail (required before spec deletion)`);
    else if (!CHANGE_PREFIX_RE.test(detail)) out.push(`${it.id}: ${d} detail lacks remove:/change:/resolved:/moot: prefix`);
  } else {
    const def = (decisions || []).find((x) => x.id === d);
    if (def && def.requires_detail && !detail) out.push(`${it.id}: '${d}' requires a decision_detail (requires_detail in ${def.source === "card" ? "the card's options" : "decision-mill.yaml"})`);
  }
  // Legacy stored spellings — the UI always displayed Change/Keep for these.
  if (d === "toss" && !declared.has("toss")) out.push(`${it.id}: legacy decision 'toss' — repair to 'change'`);
  if (d === "accept" && !declared.has("accept")) out.push(`${it.id}: legacy decision 'accept' — repair to 'keep'`);
  // Delegated-ownership rule (opt-in, DELEGATED_PATHS): an item whose evidence lives
  // entirely under code owned by another team describes a mechanism this review
  // cannot decide. `file` is the only verdict that gives it an owner. An entry with
  // a scheme (`kb:vendor/`) matches that root; a bare path matches the primary root.
  if (DELEGATED_PATHS.length && d !== "file" && d !== "defer") {
    const evidence = Array.isArray(it.meta.evidence) ? it.meta.evidence : [];
    const delegated = (loc) => DELEGATED_PATHS.some((p) => String(loc).startsWith(/^[a-z][a-z0-9+.-]*:/.test(p) ? p : LOCATOR_PREFIX + p));
    if (evidence.length > 0 && evidence.every((ev) => delegated(ev?.locator || ""))) {
      out.push(`${it.id}: all evidence is under a delegated path but decision is '${d}' (expected file — another team owns this mechanism)`);
    }
  }
  return out;
}

// Locators written inline in prose (`repo:web/src/a.ts:18-30`), as the UI
// linkifies them. A locator may wrap across a source line, but only right after a
// "/" or "-". Elided paths (`repo:.../x.ts`) and bare schemes are skipped.
export function proseLocators(prose, schemes) {
  const out = [];
  if (!prose || !schemes || !schemes.length) return out;
  const alt = schemes.map(reEsc).join("|");
  const re = new RegExp(`(?<![A-Za-z0-9_.+-])(?:${alt}):(?:[A-Za-z0-9._~@+]|[-/][ \\t]*\\n?[ \\t]*)+(?::\\d+(?:-\\d+)?(?:,\\d+(?:-\\d+)?)*)?`, "g");
  const tok = new RegExp(`^((?:${alt}):[^\\s]*?)(?::(\\d+(?:-\\d+)?(?:,\\d+(?:-\\d+)?)*))?$`);
  for (const m of String(prose).matchAll(re)) {
    const flat = m[0].replace(/\s+/g, "").replace(/[.,;:!?)\]}'"]+$/, "");
    const t = flat.match(tok);
    if (!t) continue;
    const rel = t[1].slice(t[1].indexOf(":") + 1);
    if (!rel || rel.startsWith("/") || rel.split("/").includes("..") || rel.split("/").includes("...")) continue;
    out.push({ locator: t[1], lines: t[2] || null });
  }
  return out;
}

// Optional deeper check: does each locator — structured evidence and inline prose —
// exist in its root's checkout? `exists(scheme, rel)` answers for one path. Kept
// separate from validateSpecText so the format lint stays checkout-independent.
export function checkLocators(items, exists, opts = {}) {
  const schemes = schemesOf(opts);
  const bad = [];
  for (const it of items) {
    const seen = new Set();
    const check = (loc, where) => {
      const scheme = schemes.find((k) => loc.startsWith(`${k}:`));
      if (!scheme || seen.has(loc)) return;
      seen.add(loc);
      const rel = loc.slice(scheme.length + 1).replace(/\/+$/, "");
      if (!exists(scheme, rel)) bad.push(`${it.id}: ${where} locator not in checkout: ${loc}`);
    };
    for (const ev of Array.isArray(it.meta?.evidence) ? it.meta.evidence : []) check(String(ev?.locator || ""), "evidence");
    for (const p of proseLocators(it.prose, schemes)) check(p.locator, "prose");
  }
  return bad;
}

// The <CAP> code of an id (`DEC-FLAGS-001` -> `FLAGS`).
export const capCode = (id) => String(id).split("-")[1] || "";

// Ids are permanent references, so one <CAP> code belongs to one spec file. Given
// [{slug, items}] for a whole set, returns slug -> warnings for every file that
// reuses a code (or an id) an earlier file already uses.
export function crossFileWarnings(files) {
  const out = new Map(files.map((f) => [f.slug, []]));
  const capOwner = new Map();
  const idOwner = new Map();
  for (const f of files) {
    const caps = new Set(f.items.map((it) => capCode(it.id)).filter(Boolean));
    for (const cap of caps) {
      if (capOwner.has(cap)) out.get(f.slug).push(`CAP code '${cap}' is also used by ${capOwner.get(cap)}.md — give each spec file its own code so ids stay unique references`);
      else capOwner.set(cap, f.slug);
    }
    for (const it of f.items) {
      if (idOwner.has(it.id) && idOwner.get(it.id) !== f.slug) out.get(f.slug).push(`${it.id}: id also defined in ${idOwner.get(it.id)}.md`);
      else if (!idOwner.has(it.id)) idOwner.set(it.id, f.slug);
    }
  }
  return out;
}
