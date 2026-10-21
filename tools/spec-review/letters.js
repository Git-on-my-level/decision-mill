#!/usr/bin/env node
// letters.js — assign blind variant letters with a seeded Latin-square rotation, so
// every variant sits under every letter equally often (lib/letters.js).
//
//   node letters.js --variants prod,v2_deep,v4 --items items.jsonl [--seed TASK-ID]
//   node letters.js --variants prod,v2_deep,v4 --ids id1,id2,id3 [--seed S]
//   node letters.js --variants a,b,c --count 6
//
// Prints one JSON line per item: {"item_id", "letters": {"A": "v4", "B": "prod", …}}.
// Put `letters` in the item's `hidden.letters` and render the variants in letter
// order. Never shuffle each card independently: that is how one variant ended up
// as letter A on 3 of 4 cards.

import fs from "node:fs";
import { assignLetters, letterBalance } from "./lib/letters.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1] ?? null; };
if (argv.includes("--help") || argv.includes("-h") || !flag("--variants")) {
  console.error("usage: node letters.js --variants v1,v2,v3 (--items items.jsonl | --ids a,b,c | --count N) [--seed S] [--summary]");
  process.exit(argv.includes("--help") || argv.includes("-h") ? 0 : 2);
}
const variants = flag("--variants").split(",").map((s) => s.trim()).filter(Boolean);
let ids;
if (flag("--items")) {
  ids = fs.readFileSync(flag("--items"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l).id);
} else if (flag("--ids")) {
  ids = flag("--ids").split(",").map((s) => s.trim()).filter(Boolean);
} else {
  const n = Number(flag("--count"));
  if (!Number.isInteger(n) || n <= 0) { console.error("letters.js: give --items, --ids or --count N"); process.exit(2); }
  ids = Array.from({ length: n }, (_, i) => `item-${i + 1}`);
}
const rows = assignLetters(ids, variants, { seed: flag("--seed") || "" });
for (const r of rows) console.log(JSON.stringify(r));
if (argv.includes("--summary")) {
  const b = letterBalance(rows, (r) => new Map(Object.entries(r.letters)));
  for (const v of b.variants) console.error(`${v.variant}: ${Object.entries(v.per).map(([l, n]) => `${l} ${n}`).join(", ")}`);
}
