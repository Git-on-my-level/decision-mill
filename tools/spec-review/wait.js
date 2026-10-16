#!/usr/bin/env node
// wait.js — block until a spec-mode condition holds, without polling: chains
// long-poll requests to a running server's GET /api/specs/wait.
//
//   node wait.js --url http://127.0.0.1:4601 --until all-decided [--spec SLUG] [--set ID] [--timeout 3h]
//
// --until   all-decided (default)  every decidable item has status decided
//           no-open                nothing left under the Open filter (deferred,
//                                  team-parked and needs-metrics items count as handled)
//           decided>=N | decided:N at least N items decided
//           change                 any spec file in scope changed (pass --since ETAG
//                                  to compare with an earlier response)
// --timeout total wait: 3h, 90m, 45s or seconds (default 1h)
// --json    print the final server response instead of one summary line
//
// Exit: 0 condition holds · 2 timed out · 1 server error, unreachable, or bad input.
// Made for a background waiter: it exits on every terminal state.

import { parseDuration, parseUntil, waitLoop } from "./lib/wait.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`)); if (i === -1) return null; return argv[i].includes("=") ? argv[i].slice(argv[i].indexOf("=") + 1) : argv[i + 1] ?? null; };
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("usage: node wait.js --url http://127.0.0.1:PORT [--until all-decided|no-open|decided>=N|change] [--spec SLUG] [--set ID] [--timeout 3h] [--since ETAG] [--json]");
  process.exit(0);
}
const base = (flag("--url") || `http://127.0.0.1:${process.env.PORT || 4599}`).replace(/\/+$/, "");
const until = flag("--until") || "all-decided";
const cond = parseUntil(until, "spec");
if (cond.error) { console.error(`wait.js: ${cond.error}`); process.exit(1); }
const totalS = parseDuration(flag("--timeout") || "1h");
if (totalS == null) { console.error(`wait.js: bad --timeout '${flag("--timeout")}' (want 3h, 90m, 45s or seconds)`); process.exit(1); }

const summary = (b) => {
  if (!b) return "";
  const c = b.counts || {};
  const parts = [`${c.decided}/${c.decidable} decided`, `${c.open} open`];
  if (c.deferred) parts.push(`${c.deferred} deferred`);
  if (c.team) parts.push(`${c.team} team`);
  if (c.needsMetrics) parts.push(`${c.needsMetrics} needs-metrics`);
  return `${parts.join(", ")} in ${b.spec ? `${b.set}/${b.spec}` : `set ${b.set}`} (etag ${b.etag})`;
};

const r = await waitLoop({
  totalS,
  buildUrl: ({ since, timeout }) => {
    const q = new URLSearchParams({ until, timeout: String(timeout) });
    if (flag("--spec")) q.set("spec", flag("--spec"));
    if (flag("--set")) q.set("set", flag("--set"));
    const s = since || flag("--since");
    if (s) q.set("since", s);
    return `${base}/api/specs/wait?${q}`;
  },
});
if (argv.includes("--json") && r.body) console.log(JSON.stringify(r.body, null, 2));
else if (r.code === 0) console.log(`satisfied: ${until} — ${summary(r.body)}`);
else if (r.code === 2) console.log(`timeout: ${until} not reached after ${flag("--timeout") || "1h"} — ${summary(r.body)}`);
if (r.code === 1) console.error(`wait.js: ${r.message}`);
process.exit(r.code);
