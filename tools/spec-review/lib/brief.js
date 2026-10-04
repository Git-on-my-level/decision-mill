// The stand-in brief: everything an agent needs to infer a human's labels for the
// unlabeled items of a task, as one compact markdown document.
//
// The brief never contains model answers (`hidden`) or strata: the stand-in must
// judge from what the human saw, or "stand-in agrees with model X" means nothing.

import { isAbstain } from "./task.js";

const pad2 = (n) => String(n).padStart(2, "0");
const clock = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
};
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function speaker(seg, task) {
  if (seg.is_user) return task.user_label || "You";
  if (seg.name) return String(seg.name);
  const m = /^SPEAKER_?(\d+)$/i.exec(String(seg.speaker || ""));
  return m ? `Speaker ${Number(m[1])}` : String(seg.speaker || "Speaker");
}

function contentText(c, task, maxChars) {
  if (!c) return "(no content)";
  let text;
  if (c.type === "transcript") {
    text = (c.segments || []).filter((s) => s && String(s.text || "").trim())
      .map((s) => `${s.start != null ? `[${clock(s.start)}] ` : ""}${speaker(s, task)}: ${oneLine(s.text)}`).join("\n");
  } else text = String(c.body ?? "");
  if (!text) text = "(empty)";
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (cut at ${maxChars} chars)` : text;
}

function metaLine(it) {
  const m = it.meta || {};
  const parts = [];
  if (m.started_at) parts.push(String(m.started_at).replace(/\.\d+/, "").replace("+00:00", "Z"));
  if (m.duration_s != null) parts.push(`${Math.round(Number(m.duration_s))}s`);
  if (m.word_count != null) parts.push(`${m.word_count} words`);
  return parts.join(" · ");
}

export function itemBlock(it, task, { maxChars = 3000, context = true } = {}) {
  const lines = [];
  const meta = metaLine(it);
  lines.push(`id: ${it.id}${it.title ? ` · ${oneLine(it.title)}` : ""}${meta ? ` · ${meta}` : ""}${it.truncated ? " · EXCERPT" : ""}`);
  lines.push(contentText(it.content, task, maxChars));
  if (it.summary) lines.push(`(app summary, model-written: ${oneLine(it.summary).slice(0, 400)})`);
  if (context && Array.isArray(it.context) && it.context.length) {
    for (const c of it.context) {
      const gap = c.gap_min != null ? `${Math.round(Number(c.gap_min))} min ` : "";
      lines.push(`  context ${c.relation === "overlapping" ? "overlapping" : `${gap}${c.relation || "nearby"}`}: ${oneLine(c.title || "(untitled)")}${c.summary ? ` — ${oneLine(c.summary).slice(0, 300)}` : ""}`);
    }
  }
  return lines.join("\n");
}

// opts: { reviewer, human (Map id->state), standin (Map), misses, waveInfo, maxChars, offset, limit, standinName }
export function buildBrief({ task, items, human, standinName, misses = [], waveInfo = null, maxChars = 3000, offset = 0, limit = Infinity, reviewer = "the reviewer" }) {
  const labelIds = task.labels.map((l) => l.id);
  const dist = {};
  for (const s of human.values()) dist[s.label] = (dist[s.label] || 0) + 1;
  const labeled = items.filter((it) => human.has(it.id));
  const todoAll = items.filter((it) => !human.has(it.id));
  const todo = todoAll.slice(offset, offset + limit);
  const out = [];
  out.push(`# Stand-in brief — ${task.title}`);
  out.push("");
  out.push(`You are standing in for **${reviewer}**. From their ${labeled.length} labeled examples below, infer the label they would give each of the ${todo.length} unlabeled item(s) under "Items to label"${todo.length < todoAll.length ? ` (part: items ${offset + 1}–${offset + todo.length} of ${todoAll.length})` : ""}.`);
  if (waveInfo) out.push(waveInfo);
  out.push("");
  if (task.question) out.push(`**Question asked:** ${task.question}`, "");
  if (task.instructions) out.push("## Instructions the reviewer saw", "", task.instructions.trim(), "");
  out.push("## Labels", "");
  for (const l of task.labels) out.push(`- \`${l.id}\` — ${l.label}${isAbstain(l) ? " (abstain: the reviewer could not tell)" : ""}`);
  for (const f of task.fields) out.push(`- field \`${f.id}\` (${f.type}${f.options ? `: ${f.options.map((o) => o.id).join("|")}` : ""}) — ${f.label}`);
  out.push("");
  out.push(`The reviewer's label use so far: ${Object.entries(dist).map(([k, v]) => `${k} ${v}`).join(", ") || "none yet"}. If they never use a label, predicting it is almost always wrong.`);
  out.push("");
  out.push("## How to answer", "");
  out.push("1. Read every example first. Write yourself a short rubric (each rule citing the example ids it rests on); use the reviewer's notes as the strongest evidence.");
  out.push("2. For **every** item under \"Items to label\", write one JSON object per line to a file:");
  out.push("");
  out.push("```json");
  out.push(`{"item_id": "<id>", "label": "${labelIds.join("|")}", "confidence": 0.0, "rationale": "<one sentence: the rule or example ids>"${task.fields.length ? `, "fields": {${task.fields.map((f) => `"${f.id}": ${f.type === "checkbox" ? "false" : "null"}`).join(", ")}}` : ""}}`);
  out.push("```");
  out.push("");
  out.push(`3. \`confidence\` is your probability that ${reviewer} picks exactly this label. Be calibrated: the next wave asks the human about your least-confident items, and the final wave checks you on a random sample, so a confident miss costs more than an honest 0.55.`);
  out.push(`4. Import it: \`node tools/spec-review/labels.js import-standin ${task.id} <file>\` (writes \`source: model-standin\` rows as \`${standinName}\`; never touches the human's file).`);
  out.push("");
  if (misses.length) {
    out.push("## Your earlier predictions the reviewer overruled", "");
    out.push("Predicted before they labeled the item. Learn from these; do not just flip similar items.");
    for (const m of misses) out.push(`- ${m.item_id}: you said ${m.predicted}${m.confidence != null ? ` (${m.confidence})` : ""}, they said ${m.human}`);
    out.push("");
  }
  out.push(`## ${reviewer}'s labels (${labeled.length})`, "");
  for (const it of labeled) {
    const s = human.get(it.id);
    const f = Object.entries(s.fields || {}).filter(([, v]) => v != null && v !== false && v !== "").map(([k, v]) => (v === true ? k : `${k}=${v}`));
    out.push(`### → ${s.label}${f.length ? ` [${f.join(", ")}]` : ""}${s.note ? ` — note: "${oneLine(s.note)}"` : ""}`);
    out.push(itemBlock(it, task, { maxChars }));
    out.push("");
  }
  out.push(`## Items to label (${todo.length})`, "");
  for (const it of todo) {
    out.push("### ?");
    out.push(itemBlock(it, task, { maxChars }));
    out.push("");
  }
  return out.join("\n");
}

// Parse a stand-in file: JSONL, a JSON array, or {"labels": [...]}.
export function parseStandinFile(text) {
  const t = String(text || "").trim();
  if (!t) return { rows: [], errors: ["empty file"] };
  if (t.startsWith("[") || (t.startsWith("{") && /^\{\s*"labels"\s*:/.test(t))) {
    try {
      const v = JSON.parse(t);
      const rows = Array.isArray(v) ? v : v.labels;
      if (Array.isArray(rows)) return { rows, errors: [] };
    } catch { /* fall through to JSONL */ }
  }
  const rows = [], errors = [];
  for (const [i, line] of t.split("\n").entries()) {
    const l = line.trim();
    if (!l || l.startsWith("//") || l.startsWith("```")) continue;
    try { rows.push(JSON.parse(l)); } catch (e) { errors.push(`line ${i + 1}: ${e.message}`); }
  }
  return { rows, errors };
}
