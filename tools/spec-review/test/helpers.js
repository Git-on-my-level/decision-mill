// Shared test helpers: temp copies of the bundled examples, and a real server
// process on a free port (so the HTTP tests exercise exactly what ships).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import url from "node:url";
import { spawn } from "node:child_process";

export const TOOL = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
export const REPO = path.resolve(TOOL, "../..");

export function tmpdir(prefix = "dm-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function copyExamples() {
  const root = tmpdir();
  fs.cpSync(path.join(REPO, "examples/specs"), path.join(root, "specs"), { recursive: true });
  fs.cpSync(path.join(REPO, "examples/labels"), path.join(root, "labels"), { recursive: true });
  // Start from a clean label slate except the committed stand-in file.
  return root;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on("error", reject);
  });
}

export async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], { cwd: TOOL, env: { ...process.env, REVIEWER: "", PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/api/config`); if (r.ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
    if (child.exitCode != null) throw new Error(`server exited: ${out}`);
  }
  return {
    base,
    output: () => out,
    stop: () => new Promise((r) => { child.once("exit", r); child.kill(); }),
    get: (p, headers = {}) => fetch(base + p, { headers }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) })),
    post: (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) })),
  };
}
