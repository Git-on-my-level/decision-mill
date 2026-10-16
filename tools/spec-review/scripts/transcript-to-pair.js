#!/usr/bin/env node
// Convert label items that show two overlapping captures as one transcript (the
// DIVIDER rows + "A · " / "B · " speaker-name convention) into `pair` items
// (LABELS.md, "Pair items"). Every other key is preserved; items that do not
// follow the convention pass through unchanged.
//
//   node scripts/transcript-to-pair.js items.jsonl > items.pair.jsonl
//   node scripts/transcript-to-pair.js items.jsonl --out items.pair.jsonl
//   cat items.jsonl | node scripts/transcript-to-pair.js -
//
// It never rewrites its input: write to a new file, check it in the UI, then
// swap the files yourself. Labels reference item ids, which are kept, so
// existing labels stay attached.
import fs from "node:fs";
import path from "node:path";
import { transcriptToPair } from "../lib/pair.js";

export function convertJsonl(text) {
  let converted = 0, kept = 0;
  const lines = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let item;
    try { item = JSON.parse(line); } catch { lines.push(line); kept++; continue; }
    const pair = transcriptToPair(item);
    if (pair) { lines.push(JSON.stringify(pair)); converted++; } else { lines.push(line); kept++; }
  }
  return { text: lines.length ? `${lines.join("\n")}\n` : "", converted, kept };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = process.argv.slice(2);
  const oi = args.indexOf("--out");
  const out = oi !== -1 ? args[oi + 1] : null;
  const input = args.find((a, i) => !a.startsWith("--") && (oi === -1 || i !== oi + 1));
  if (!input || args.includes("--help") || args.includes("-h") || (oi !== -1 && !out)) {
    console.error("usage: node scripts/transcript-to-pair.js <items.jsonl | -> [--out FILE]");
    process.exit(input ? 2 : 1);
  }
  if (out && input !== "-" && path.resolve(out) === path.resolve(input)) {
    console.error("refusing to overwrite the input; write to a new file and swap it yourself");
    process.exit(2);
  }
  const text = fs.readFileSync(input === "-" ? 0 : input, "utf8");
  const res = convertJsonl(text);
  if (out) fs.writeFileSync(out, res.text); else process.stdout.write(res.text);
  console.error(`transcript-to-pair: ${res.converted} converted, ${res.kept} unchanged`);
}
