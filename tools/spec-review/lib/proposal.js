// The `proposal` item content type (LABELS.md): a proposed change shown as an
// inline diff, the evidence for it, and the rules it is judged by. The browser
// renders it (public/label.js + public/proposal-diff.js); this file validates it
// and flattens it to text for search and stand-in briefs.

import { httpUrl, shown } from "./url.js";

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const isStrList = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const str = (v) => (v == null || v === "" ? "" : typeof v === "string" ? v : JSON.stringify(v));

// Problems with one item's proposal content, as warning strings (empty = fine).
export function proposalProblems(c) {
  const w = [];
  const ch = c.change;
  if (!isObj(ch)) return ["proposal content needs a change mapping"];
  const hasValue = "before" in ch || "after" in ch;
  const hasFields = Array.isArray(ch.fields) && ch.fields.length > 0;
  if (!hasValue && !hasFields && typeof ch.summary !== "string") w.push("proposal change needs before/after, fields, or a summary");
  if (ch.kind != null && typeof ch.kind !== "string") w.push("proposal change.kind must be a string");
  if (ch.fields != null) {
    if (!Array.isArray(ch.fields)) w.push("proposal change.fields must be a list");
    else ch.fields.forEach((f, i) => { if (!isObj(f) || typeof f.name !== "string" || !f.name) w.push(`proposal change.fields[${i}] needs a name`); });
  }
  if (c.evidence != null) {
    if (!Array.isArray(c.evidence)) w.push("proposal evidence must be a list");
    else c.evidence.forEach((e, i) => {
      if (!isObj(e)) { w.push(`proposal evidence[${i}] must be a mapping`); return; }
      if (typeof e.title !== "string" || !e.title) w.push(`proposal evidence[${i}] needs a title`);
      if (e.segments != null && !Array.isArray(e.segments)) w.push(`proposal evidence[${i}].segments must be a list`);
      if (e.cited != null && !isStrList(e.cited)) w.push(`proposal evidence[${i}].cited must be a list of segment ids`);
      if (e.url != null && !httpUrl(e.url)) w.push(`proposal evidence[${i}].url must be an http(s) URL (got '${shown(e.url)}'); the title stays plain text`);
      if (e.text != null && typeof e.text !== "string") w.push(`proposal evidence[${i}].text must be a string`);
      if (e.facts != null && !isObj(e.facts) && !(Array.isArray(e.facts) && e.facts.every((f) => isObj(f) && typeof f.name === "string"))) {
        w.push(`proposal evidence[${i}].facts must be a mapping or a list of {name, value}`);
      }
    });
  }
  if (c.policy != null && typeof c.policy !== "string" && !isStrList(c.policy)) w.push("proposal policy must be a string or a list of strings");
  if (c.policy_focus != null && !isStrList(c.policy_focus)) w.push("proposal policy_focus must be a list of strings");
  if (c.highlight != null && !(Array.isArray(c.highlight) && c.highlight.every((h) => typeof h === "string" || (isObj(h) && typeof h.text === "string")))) {
    w.push("proposal highlight must be a list of strings or {text, side}");
  }
  if (c.question != null && typeof c.question !== "string") w.push("proposal question must be a string");
  return w;
}

// Plain text of a proposal, for search and the stand-in brief. Evidence `url`s are
// left out on purpose: a bare URL adds nothing to matching or to a stand-in.
export function proposalText(c) {
  const ch = isObj(c.change) ? c.change : {};
  const lines = [];
  const kind = ch.kind ? `${ch.kind}: ` : "";
  if (ch.summary) lines.push(`${kind}${ch.summary}`);
  if ("before" in ch || "after" in ch) lines.push(`${ch.summary ? "" : kind}${str(ch.before) || "(new)"} → ${str(ch.after) || "(removed)"}`);
  if (ch.target) lines.push(`Target: ${ch.target}`);
  for (const f of Array.isArray(ch.fields) ? ch.fields : []) lines.push(`${f?.name}: ${str(f?.before) || "—"} → ${str(f?.after) || "—"}`);
  for (const e of Array.isArray(c.evidence) ? c.evidence : []) {
    if (!isObj(e)) continue;
    lines.push(`Evidence: ${e.title || ""}${e.tag ? ` [${e.tag}]` : ""}`);
    const facts = Array.isArray(e.facts) ? e.facts : isObj(e.facts) ? Object.entries(e.facts).map(([name, value]) => ({ name, value })) : [];
    for (const f of facts) lines.push(`  ${f.name}: ${str(f.value) || "—"}`);
    if (e.text) lines.push(`  ${e.text}`);
    for (const s of Array.isArray(e.segments) ? e.segments : []) if (s?.text) lines.push(`  ${s.is_user ? "You" : s.speaker || "Speaker"}: ${s.text}`);
  }
  const policy = Array.isArray(c.policy) ? c.policy.join(" ") : c.policy;
  if (policy) lines.push(`Policy: ${policy}`);
  return lines.join("\n");
}
