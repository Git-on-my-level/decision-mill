#!/usr/bin/env node
// Copy an agent's tool results out of Claude Code session transcripts, mechanically.
//
// Some label tasks need content only an agent can fetch: an MCP connector that holds
// the user's own data, for example. Retyping that content, or piping it through the
// agent's reply, corrupts it and fills the agent's context. Instead the agent (or a
// headless `claude -p` run) makes the tool calls, and this script copies every
// matching tool result verbatim out of the session files, including results that
// Claude Code spilled to `tool-results/*.txt` because they were large.
//
//   node harvest.js --tool <regex> <session.jsonl | session-dir | projects-dir>... > raw.jsonl
//
// One output line per tool call: {"tool", "tool_use_id", "input", "result", "session"}.
// `result` is parsed JSON when the payload is JSON, otherwise the text. Calls whose
// result never arrived are skipped. Rerun over every session that fetched data: the
// output is a pure function of the inputs, so a builder can rebuild items.jsonl from it.
import fs from "node:fs";
import path from "node:path";

export function sessionFiles(inputs) {
  const out = [];
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isFile()) { if (p.endsWith(".jsonl")) out.push(p); return; }
    for (const name of fs.readdirSync(p).sort()) if (name !== "tool-results") walk(path.join(p, name));
  };
  for (const p of inputs) walk(p);
  return [...new Set(out)];
}

const SPILL = /(?:Output has been saved to|Full output saved to:?)\s+(\S+?\.(?:txt|json))/;

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && c.type === "text" ? c.text : "")).join("");
  return "";
}

export function harvest(files, toolRe) {
  const rows = [];
  for (const file of files) {
    const calls = new Map();
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.includes("tool_")) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const parts = rec?.message?.content;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (part?.type === "tool_use" && toolRe.test(part.name || "")) calls.set(part.id, { tool: part.name, input: part.input });
        if (part?.type !== "tool_result" || !calls.has(part.tool_use_id)) continue;
        let text = resultText(part.content);
        const spill = text.match(SPILL);
        if (spill && fs.existsSync(spill[1])) text = fs.readFileSync(spill[1], "utf8");
        let result = text;
        try { result = JSON.parse(text); } catch { /* keep text */ }
        const call = calls.get(part.tool_use_id);
        rows.push({ tool: call.tool, tool_use_id: part.tool_use_id, input: call.input, result, session: path.basename(file, ".jsonl") });
      }
    }
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--tool");
  if (i < 0 || !args[i + 1] || args.length < 3) {
    console.error("usage: node harvest.js --tool <regex> <session.jsonl|dir>... > raw.jsonl");
    process.exit(2);
  }
  const re = new RegExp(args[i + 1]);
  const inputs = args.filter((_, j) => j !== i && j !== i + 1);
  const rows = harvest(sessionFiles(inputs), re);
  for (const r of rows) process.stdout.write(JSON.stringify(r) + "\n");
  console.error(`harvested ${rows.length} tool result(s) from ${sessionFiles(inputs).length} session file(s)`);
}
