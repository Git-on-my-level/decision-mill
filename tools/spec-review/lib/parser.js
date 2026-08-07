// Parse and surgically update machine-parsable spec files (specs/FORMAT.md v1).
// Invariant: updates rewrite ONLY the targeted adjudication fence body; all other
// bytes of the file are preserved verbatim.

import * as yaml from "js-yaml";
import { LOCATOR_PREFIX } from "./config.js";

const ID_RE = /^(DIV|INV|FC|UNK|FEAT|GEN)-[A-Z0-9]+-\d+$/;
const HEADING_RE = /^###\s+((?:DIV|INV|FC|UNK|FEAT|GEN)-[A-Z0-9]+-\d+)\s+—\s+(.+?)\s*$/;
// A heading that *looks* like an adjudicable item but fails HEADING_RE must be
// reported, never silently skipped (a plain "-" instead of "—" used to make an
// item invisible to both the UI and the linter).
const NEAR_HEADING_RE = /^###\s+(?:(?:DIV|INV|FC|UNK|FEAT|GEN)\b|[A-Z]{2,5}-[A-Z0-9]+-\d+)/;

// Vocabularies from specs/FORMAT.md v1.
export const KINDS = new Set(["divergence", "invariant", "failure-case", "unknown", "feature", "general"]);
export const STATUSES = new Set(["open", "decided", "needs-metrics", "team"]);
export const SIMPLE_DECISIONS = new Set(["keep", "toss", "accept", "reject", "defer", "file"]);
export const CONFIDENCES = new Set(["high", "med", "low"]);
export const UNIFY_RE = /^unify-on-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LINES_RE = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;
// An absolute, home-relative or dot-relative locator is machine-specific and
// defeats the point of the prefix.
const NON_PORTABLE_RE = new RegExp(`^${LOCATOR_PREFIX}(/|~|\\.\\.?/)`);

export function isValidDecision(d) {
  return SIMPLE_DECISIONS.has(d) || UNIFY_RE.test(String(d || ""));
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

// errors = structural problems that make the file unusable or unsafe to edit.
// warnings = vocabulary/consistency drift worth fixing but not blocking.
export function validateSpecText(text, slug) {
  const { frontmatter, items, errors } = parseSpec(text);
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
    else if (!KINDS.has(meta.kind)) warns.push(`${it.id}: unknown kind '${meta.kind}'`);
    if (meta.status != null && !STATUSES.has(meta.status)) warns.push(`${it.id}: unknown status '${meta.status}'`);
    if (meta.decision != null && !isValidDecision(meta.decision)) warns.push(`${it.id}: unknown decision '${meta.decision}'`);
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
      if (!ev.locator || !String(ev.locator).startsWith(LOCATOR_PREFIX)) errs.push(`${it.id}: bad evidence locator (want ${LOCATOR_PREFIX}<path>): ${ev.locator}`);
      else if (NON_PORTABLE_RE.test(String(ev.locator))) errs.push(`${it.id}: non-portable evidence locator: ${ev.locator}`);
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
  }
  if (!items.length) errs.push("no adjudicable items found");
  return { frontmatter, items, errors: errs, warnings: warns };
}

// Optional deeper check: does each locator exist in the configured checkout?
// Kept separate from validateSpecText so the format lint stays checkout-independent.
export function checkLocators(items, exists) {
  const bad = [];
  for (const it of items) {
    for (const ev of Array.isArray(it.meta?.evidence) ? it.meta.evidence : []) {
      const loc = String(ev?.locator || "");
      if (!loc.startsWith(LOCATOR_PREFIX)) continue;
      const rel = loc.slice(LOCATOR_PREFIX.length);
      if (!exists(rel)) bad.push(`${it.id}: evidence locator not in checkout: ${loc}`);
    }
  }
  return bad;
}
