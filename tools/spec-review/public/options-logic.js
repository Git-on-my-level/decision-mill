/* decision-mill — per-card answer options (FORMAT.md "Card options"): one pure
   reading of an item's buttons, shared by the server (write validation), the
   linter and the browser. No DOM and no YAML here, so the same file is a plain
   browser script (global `OptionsLogic`) and importable by node (lib/options.js).

   An item's effective options are:
     - its own `options:` (in the card's order; a bare id pulls an entry from the
       set's `options:` library or its `decisions:`, a mapping adds or overrides),
     - then the set's verdicts that apply to the item, except two that the card's
       own options make redundant: the accept verdict (accept/keep) folds into the
       recommended option, and the typed-answer verdict stays reachable through the
       Answer box. Both stay valid stored values (`hidden`), so nothing written
       before a card gained options stops validating.
   A card without `options:` gets exactly the set's verdicts, as before. */
"use strict";
(() => {

const ID_RE = /^[a-z][a-z0-9_-]*$/;
const OPTION_KEYS = ["id", "label", "hint", "key", "tone", "requires_detail"];
const TONES = new Set(["positive", "negative", "neutral", "unify"]);
// Keys spec mode's keyboard model owns (mirrors lib/specset.js RESERVED_SPEC_KEYS).
const RESERVED = new Set(["j", "k", "u", "e", "i", "?", "/", " ", "escape", "enter"]);
// Never auto-assigned: `a` accepts the recommendation, and `s`/`n` are label
// mode's skip and note, kept free so one keyboard model holds across modes.
const AVOID = new Set(["a", "s", "n"]);
// The set verdict that means "do what the card recommends".
const ACCEPT_IDS = new Set(["accept", "keep"]);
const DIGIT = /^[1-9]$/;

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/[-_]/g, " ");

// One option entry: a bare id or {id, label?, hint?, key?, tone?, requires_detail?}.
// `base` is what a bare id (or an overriding mapping) resolves against.
// Returns { option } or { error }; unknown keys come back as warnings.
function readOption(raw, where, lookup) {
  const warnings = [];
  const entry = typeof raw === "string" ? { id: raw } : raw;
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.id == null || entry.id === "") return { error: `${where} needs an id`, warnings };
  const id = String(entry.id);
  if (!ID_RE.test(id)) return { error: `${where}: option id '${id}' must be lowercase letters, digits, - or _ (it is the stored value)`, warnings };
  if (id === "unify" || id.startsWith("unify-on-")) return { error: `${where}: '${id}' is the unify flow, not an option`, warnings };
  for (const k of Object.keys(entry)) if (!OPTION_KEYS.includes(k)) warnings.push(`option '${id}': unknown key '${k}' (want ${OPTION_KEYS.join(", ")})`);
  const base = lookup ? lookup(id) : null;
  if (typeof raw === "string" && lookup && !base) return { error: `${where}: '${id}' is not in the set's options or decisions (write {id: ${id}, label: …} to define it here)`, warnings };
  const tone = entry.tone != null ? String(entry.tone) : base ? base.tone : "neutral";
  if (!TONES.has(tone) || tone === "unify") warnings.push(`option '${id}': unknown tone '${tone}' (want positive|negative|neutral)`);
  if (entry.requires_detail != null && typeof entry.requires_detail !== "boolean") warnings.push(`option '${id}': requires_detail must be true or false`);
  const key = entry.key != null && String(entry.key) !== "" ? String(entry.key).toLowerCase() : null;
  return {
    warnings,
    option: {
      id,
      label: entry.label != null ? String(entry.label) : base ? base.label : titleCase(id),
      hint: entry.hint != null ? String(entry.hint) : base ? base.hint || "" : "",
      key,
      tone: TONES.has(tone) && tone !== "unify" ? tone : "neutral",
      requires_detail: entry.requires_detail != null ? entry.requires_detail === true : Boolean(base && base.requires_detail),
      custom: Boolean(base && base.custom),
    },
  };
}

// A key problem, or null. Explicit keys only: auto-assigned keys never collide.
function keyProblem(key) {
  if (key.length !== 1) return `key '${key}' must be a single character`;
  if (RESERVED.has(key)) return `key '${key}' is reserved (j k u e i ? / are spec mode's)`;
  return null;
}

// The set's `options:` library (decision-mill.yaml). Returns { options, errors, warnings }.
function normalizeOptionLibrary(raw) {
  const errors = [], warnings = [], options = [];
  if (raw == null) return { options, errors, warnings };
  if (!Array.isArray(raw)) return { options, errors: ["options must be a list of {id, label?, hint?, key?, tone?, requires_detail?}"], warnings };
  for (const [i, r] of raw.entries()) {
    const { option, error, warnings: w } = readOption(r, `options[${i}]`, null);
    warnings.push(...w);
    if (error) { errors.push(error); continue; }
    if (options.some((o) => o.id === option.id)) { errors.push(`duplicate option id '${option.id}'`); continue; }
    if (option.key) { const p = keyProblem(option.key); if (p) { errors.push(`option '${option.id}': ${p}`); option.key = null; } }
    options.push(option);
  }
  return { options, errors, warnings };
}

// Does set verdict `d` apply to item `it`? Unify only ever applies to divergences.
function appliesTo(d, it) {
  const isDiv = (it && it.kind) === "divergence" || /^DIV-/.test(String(it && it.id));
  if (d.id === "unify" && !isDiv) return false;
  if (!d.kinds) return true;
  return d.kinds.includes(it && it.kind) || (isDiv && d.kinds.includes("divergence"));
}

// The verdict a typed answer records (mirrors lib/specset.js answerDecision).
function answerOf(decisions) {
  const list = (decisions || []).filter((d) => d.id !== "unify");
  return (list.find((d) => d.custom) || list.find((d) => d.id === "change") || list.find((d) => d.requires_detail) || null);
}

// First letter of `text` (then of `id`) that is free; null when none is.
function letterKey(text, id, used) {
  for (const ch of `${text} ${id}`.toLowerCase()) {
    if (!/[a-z]/.test(ch) || RESERVED.has(ch) || AVOID.has(ch) || used.has(ch)) continue;
    return ch;
  }
  return null;
}

// The item's buttons. cfg = { decisions, options } as the server publishes them
// (decisions: the set's verdicts, defaults included; options: the library).
// Returns { options, own, recommended, errors, warnings } where each option is
// { id, label, hint, key, tone, requires_detail, custom, kinds, source: card|set,
//   recommended, hidden, accept }.
function effectiveOptions(item, cfg) {
  const it = item || {};
  const meta = it.meta || {};
  const decisions = ((cfg && cfg.decisions) || []).map((d) => ({ ...d }));
  const library = (cfg && cfg.options) || [];
  const errors = [], warnings = [];
  const verdicts = decisions.filter((d) => appliesTo(d, it));
  const answer = answerOf(decisions);
  const proposed = meta.proposed == null ? null : String(meta.proposed);
  const raw = meta.options;
  const hasOwn = Array.isArray(raw) && raw.length > 0;
  if (raw != null && !Array.isArray(raw)) errors.push("options must be a list of option ids or {id, label, hint?, key?, tone?, requires_detail?}");

  if (!hasOwn) {
    const options = verdicts.map((d) => ({ ...d, source: "set", hidden: false, accept: ACCEPT_IDS.has(d.id), recommended: d.id !== "unify" && d.id === proposed }));
    return { options, own: false, recommended: options.find((o) => o.recommended)?.id || null, errors, warnings };
  }

  const lookup = (id) => library.find((o) => o.id === id) || decisions.find((d) => d.id === id && d.id !== "unify") || null;
  const own = [];
  for (const [i, r] of raw.entries()) {
    const { option, error, warnings: w } = readOption(r, `options[${i}]`, lookup);
    warnings.push(...w);
    if (error) { errors.push(error); continue; }
    if (own.some((o) => o.id === option.id)) { errors.push(`duplicate option id '${option.id}'`); continue; }
    // A key written on this card is checked here; a library entry's was checked in the set file.
    const explicit = typeof r === "object" && r && r.key != null && String(r.key) !== "";
    if (option.key && explicit) { const p = keyProblem(option.key); if (p) { errors.push(`option '${option.id}': ${p}`); option.key = null; } }
    // A library entry's own key comes along; a verdict pulled in by id (defer)
    // drops its set-wide digit, since digits are re-dealt in card order.
    if (!explicit) option.key = library.find((o) => o.id === option.id)?.key || null;
    own.push({ ...option, kinds: null, source: "card", hidden: false, accept: false, recommended: false });
  }
  const rec = own.find((o) => o.id === proposed) || null;
  if (rec) rec.recommended = true;
  else if (proposed && proposed !== "n/a" && !verdicts.some((d) => d.id === proposed)) warnings.push(`proposed '${proposed}' is not one of this card's options (${own.map((o) => o.id).join(", ")})`);

  // Keys: explicit first (a collision is an error, the later one loses it), then
  // digits 1–9 to the rest in card order.
  const used = new Set();
  for (const o of own) {
    if (!o.key) continue;
    if (used.has(o.key)) { errors.push(`key '${o.key}' bound twice in this card's options`); o.key = null; continue; }
    used.add(o.key);
  }
  for (const o of own) {
    if (o.key) continue;
    for (let n = 1; n <= 9; n++) if (!used.has(String(n))) { o.key = String(n); used.add(o.key); break; }
  }

  // The set's verdicts follow, keyed by letters so a digit always means "this
  // card's option N": a declared letter key if it is free, else a letter from
  // the label (Defer -> d). The accept verdict folds into the recommended option;
  // the typed-answer verdict lives in the Answer box. Both stay valid, hidden.
  const out = [...own];
  for (const d of verdicts) {
    if (own.some((o) => o.id === d.id)) continue;
    const hidden = (d.id === (answer && answer.id)) || (ACCEPT_IDS.has(d.id) && Boolean(rec));
    let key = null;
    if (!hidden && d.id !== "unify") {
      key = d.key && /^[a-z]$/.test(d.key) && !used.has(d.key) ? d.key : letterKey(d.label, d.id, used);
      if (key) used.add(key);
    } else if (d.id === "unify" && d.key && !used.has(d.key) && !DIGIT.test(d.key)) { key = d.key; used.add(key); }
    out.push({ ...d, key, source: "set", hidden, accept: ACCEPT_IDS.has(d.id), recommended: false });
  }
  return { options: out, own: true, recommended: rec ? rec.id : null, errors, warnings };
}

// The option behind stored value `d` on this item (unify-on-x -> the unify entry).
function optionFor(eff, d) {
  const s = String(d == null ? "" : d);
  return eff.options.find((o) => o.id === s) || (s.startsWith("unify-on-") ? eff.options.find((o) => o.id === "unify") : null) || null;
}

// What a write of `requested` to this item stores, for a card with its own
// options: the id itself when it is one of the item's options, the recommended
// option for the accept verdict, else an error. Cards without options return
// { decision: requested, legacy: true } and keep the set-wide rules.
function resolveWrite(eff, requested) {
  const d = String(requested == null ? "" : requested);
  if (!eff.own) return { decision: d, legacy: true };
  const opt = optionFor(eff, d);
  if (opt && opt.accept && eff.recommended) return { decision: eff.recommended, via: d };
  if (opt && (opt.id !== "unify" || /^unify-on-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(d))) return { decision: d };
  const want = eff.options.filter((o) => o.id !== "unify").map((o) => o.id);
  if (eff.options.some((o) => o.id === "unify")) want.push("unify-on-<slug>");
  return { error: `'${d}' is not one of this card's options — want ${want.join("|")}` };
}

const api = { effectiveOptions, normalizeOptionLibrary, optionFor, resolveWrite, appliesTo, RESERVED, AVOID, ACCEPT_IDS };
globalThis.OptionsLogic = api;
})();
