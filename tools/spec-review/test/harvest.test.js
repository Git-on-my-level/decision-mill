import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { harvest, sessionFiles } from "../harvest.js";

test("harvest copies matching tool results verbatim, including spilled files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-"));
  const spill = path.join(dir, "s1", "tool-results", "big.txt");
  fs.mkdirSync(path.dirname(spill), { recursive: true });
  fs.writeFileSync(spill, JSON.stringify({ conversations: [{ id: "c2" }] }));
  const lines = [
    { message: { content: [{ type: "tool_use", id: "t1", name: "mcp__notes__get_by_ids", input: { ids: ["c1"] } }] } },
    { message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: '{"conversations":[{"id":"c1"}]}' }] }] } },
    { message: { content: [{ type: "tool_use", id: "t2", name: "mcp__notes__get_by_ids", input: { ids: ["c2"] } }] } },
    { message: { content: [{ type: "tool_result", tool_use_id: "t2", content: `Output too large. Full output saved to: ${spill}` }] } },
    { message: { content: [{ type: "tool_use", id: "t3", name: "Read", input: {} }] } },
    { message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "unrelated" }] } },
    { message: { content: [{ type: "tool_use", id: "t4", name: "mcp__notes__get_by_ids", input: {} }] } },
  ];
  fs.writeFileSync(path.join(dir, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n");
  const files = sessionFiles([dir]);
  assert.deepEqual(files.map((f) => path.basename(f)), ["s1.jsonl"]);
  const rows = harvest(files, /get_by_ids$/);
  assert.equal(rows.length, 2, "only matching calls with a result");
  assert.deepEqual(rows[0].result, { conversations: [{ id: "c1" }] });
  assert.deepEqual(rows[1].result, { conversations: [{ id: "c2" }] }, "spilled result is read from disk");
  assert.deepEqual(rows[1].input, { ids: ["c2"] });
});
