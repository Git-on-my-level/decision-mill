// decision-mill server — one local UI over two kinds of file-backed work:
//  * spec mode: the machine-parsable specs. The spec markdown files remain the
//    single source of truth; every write here mutates only adjudication YAML
//    blocks via lib/parser.js.
//  * label mode: label tasks (LABELS.md). Every write appends one row to
//    labels/<reviewer>.jsonl via lib/labelstore.js; nothing is ever rewritten.
// Binds to loopback by default. All client URLs are relative, so it works behind
// a reverse proxy mounted at "/" (e.g. `tailscale serve`).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { execFileSync } from "node:child_process";
import { parseSpec, updateItem, validateSpecText, isValidDecision, canonicalDecision, LINES_RE, dumpMeta, NEW_ID_RE, crossFileWarnings } from "./lib/parser.js";
import { SPECS_DIRS, LABELS_ROOTS, REPO_ROOT, PORT, HOST, EXCLUDED, LOCATOR_PREFIX, LOCATOR_SCHEME, LOCATOR_ROOTS, PROJECT_NAME, REVIEWER, REVIEWER_EXPLICIT } from "./lib/config.js";
import { handleLabelApi, searchTasks, taskSummaries } from "./lib/label-api.js";
import { discoverTasks } from "./lib/task.js";
import { loadSpecSetConfig, rootsForSet, publicSetConfig, declaredIds, splitLocator, SET_CONFIG_FILE } from "./lib/specset.js";
import { parseUntil, requestTimeout, longPoll, etagOf } from "./lib/wait.js";
import { effectiveOptions, resolveWrite, optionFor } from "./lib/options.js";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

const LANG_BY_EXT = {
  ".dart": "dart", ".swift": "swift", ".ts": "typescript", ".tsx": "typescript",
  ".js": "javascript", ".py": "python", ".rs": "rust", ".md": "markdown",
  ".yaml": "yaml", ".yml": "yaml", ".json": "json", ".kt": "kotlin",
};

// HTTP error with an explicit status, so bad input reads as 400/404 not 500.
class HttpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const pad2 = (n) => String(n).padStart(2, "0");
// Local wall-clock, not UTC: an evening review session was stamping tomorrow's date.
const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const localStamp = (d) => `${localDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

// Spec sets: every configured specs directory, each with a stable URL id. The
// first is the default for set-less calls, so the original single-set API (and
// PLAYBOOK's curl examples) keep working unchanged.
const slugifyId = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "specs";
const SPEC_SETS = (() => {
  const out = [];
  for (const dir of SPECS_DIRS) {
    const name = `${path.basename(path.dirname(dir))}/${path.basename(dir)}`;
    let id = slugifyId(name);
    for (let n = 2; out.some((s) => s.id === id); n++) id = `${slugifyId(name)}-${n}`;
    out.push({ id, dir, name });
  }
  return out;
})();
const availableSets = () => SPEC_SETS.filter((s) => fs.existsSync(s.dir) && fs.statSync(s.dir).isDirectory());

function setFor(u) {
  const want = u.searchParams.get("set");
  const sets = availableSets();
  const set = want ? sets.find((s) => s.id === want) : sets[0];
  if (!set) throw new HttpError(404, want ? `unknown spec set '${want}'` : "no spec set configured");
  return set;
}

// A set's decision-mill.yaml, re-read whenever the file changes (no restart).
const cfgCache = new Map();
function setConfig(set) {
  const file = path.join(set.dir, SET_CONFIG_FILE);
  let key = "-";
  try { const st = fs.statSync(file); key = `${st.mtimeMs}:${st.size}`; } catch { /* absent */ }
  const hit = cfgCache.get(set.dir);
  if (hit && hit.key === key) return hit.value;
  const cfg = loadSpecSetConfig(set.dir);
  const roots = rootsForSet(cfg);
  const value = { cfg, roots, opts: { schemes: Object.keys(roots), decisions: cfg.customDecisions ? cfg.decisions : null, setDecisions: cfg.decisions, options: cfg.options }, declared: declaredIds(cfg) };
  cfgCache.set(set.dir, { key, value });
  return value;
}

// Warnings that need the whole set: a <CAP> code or id reused across files.
function setWarnings(set) {
  return crossFileWarnings(specFiles(set).map((f) => ({ slug: f.replace(/\.md$/, ""), items: parseSpec(fs.readFileSync(path.join(set.dir, f), "utf8")).items })));
}

function specFiles(set) {
  return fs.readdirSync(set.dir)
    .filter((f) => f.endsWith(".md") && !EXCLUDED.has(f))
    .sort();
}

function specSummary(set, file) {
  const slug = file.replace(/\.md$/, "");
  const text = fs.readFileSync(path.join(set.dir, file), "utf8");
  const { frontmatter, items, errors } = parseSpec(text);
  // `decidable` excludes kind: general — GEN items have no decide affordance, so
  // counting them in the denominator made 100% unreachable on every spec. The
  // status tallies are decidable-scoped too: counting a GEN item's status in the
  // numerator against a denominator that excluded it could read 4/3 decided.
  const counts = { total: 0, decidable: 0, open: 0, decided: 0, needsMetrics: 0, team: 0, deferred: 0 };
  const byKind = {};
  for (const it of items) {
    counts.total++;
    byKind[it.kind || "?"] = (byKind[it.kind || "?"] || 0) + 1;
    if (it.kind === "general") continue;
    counts.decidable++;
    const st = it.meta.status || "open";
    if (st === "decided") counts.decided++;
    else if (st === "needs-metrics") counts.needsMetrics++;
    else if (st === "team") counts.team++;
    else if (it.meta.decision === "defer") counts.deferred++;
    else counts.open++;
  }
  return { slug, file, title: frontmatter?.title || slug, status: frontmatter?.status, baseline: frontmatter?.baseline, counts, byKind, parseErrors: errors };
}

// `<scheme>:<path>` -> a file under that scheme's root (several roots may be
// declared: LOCATOR_ROOTS, and a set's decision-mill.yaml locator_roots).
function resolveLocator(locator, roots) {
  if (!locator) throw new HttpError(400, "locator query param required");
  const sp = splitLocator(locator, roots);
  if (sp.error) throw new HttpError(400, sp.error);
  const { scheme, rel, root } = sp;
  if (!fs.existsSync(root)) throw new HttpError(404, `checkout for ${scheme}: not found at ${root} (set LOCATOR_ROOTS or REPO_ROOT)`);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new HttpError(400, "locator escapes its root");
  return { scheme, rel, abs, root };
}

// Lazily-built, cached list of tracked paths per root, used only to suggest
// alternatives for a locator that no longer resolves (specs drift; files move).
const trackedPaths = new Map();
function repoPaths(root) {
  if (trackedPaths.has(root)) return trackedPaths.get(root);
  let paths = [];
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z"], { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
    paths = out.split("\0").filter(Boolean);
  } catch { /* not a git checkout */ }
  trackedPaths.set(root, paths);
  return paths;
}

function suggestLocators(scheme, root, rel) {
  const paths = repoPaths(root);
  if (!paths.length) return [];
  const tailMatch = paths.filter((p) => p.endsWith("/" + rel));
  if (tailMatch.length) return tailMatch.slice(0, 8).map((p) => `${scheme}:${p}`);
  const base = rel.split("/").filter(Boolean).pop();
  if (!base) return [];
  return paths.filter((p) => p.endsWith("/" + base)).slice(0, 8).map((p) => `${scheme}:${p}`);
}

// What /api/specs/wait watches: one spec, or every spec in the set. The etag is a
// content hash, recomputed only when a file's stat changes.
const scopeCache = new Map();
function scopeState(set, slug) {
  const files = slug ? specFiles(set).filter((f) => f === `${slug}.md`) : specFiles(set);
  if (slug && !files.length) throw new HttpError(404, `unknown spec '${slug}'`);
  const key = files.map((f) => { const st = fs.statSync(path.join(set.dir, f)); return `${f}:${st.mtimeMs}:${st.size}`; }).join("|");
  const ck = `${set.dir}|${slug || ""}`;
  const hit = scopeCache.get(ck);
  if (hit && hit.key === key) return hit.value;
  const specs = files.map((f) => specSummary(set, f));
  const counts = { decidable: 0, decided: 0, open: 0, deferred: 0, team: 0, needsMetrics: 0 };
  for (const sp of specs) for (const k of Object.keys(counts)) counts[k] += sp.counts[k] || 0;
  const etag = etagOf(files.map((f) => `${f}\0${fs.readFileSync(path.join(set.dir, f), "utf8")}`).join("\0"));
  const value = { etag, counts, specs: specs.map((sp) => ({ slug: sp.slug, title: sp.title, counts: sp.counts })) };
  scopeCache.set(ck, { key, value });
  return value;
}

// "12", "12-40", or "364,388-468" -> list of [from, to] clamped to the file.
function parseLineRanges(linesParam, totalLines) {
  if (!linesParam) return { ranges: [] };
  if (!LINES_RE.test(linesParam)) return { ranges: [], warning: `unparseable lines spec "${linesParam}" — showing from the top` };
  const ranges = [];
  for (const part of linesParam.split(",")) {
    const [a, b] = part.split("-").map(Number);
    const from = Math.max(1, Math.min(a, totalLines));
    const to = Math.min(totalLines, Math.max(b || a, from));
    ranges.push([from, to]);
  }
  ranges.sort((x, y) => x[0] - y[0]);
  const beyond = linesParam.split(",").some((part) => Number(part.split("-").pop()) > totalLines);
  return { ranges, warning: beyond ? `lines ${linesParam} extend past end of file (${totalLines} lines) — spec may be stale` : undefined };
}

// Who is writing. An explicit REVIEWER wins (single-person setup); otherwise the
// Tailscale-User-Login header that `tailscale serve` injects names the person;
// otherwise the default. tailscale serve strips client-supplied Tailscale-*
// headers, so the header cannot be forged through the proxy.
function reviewerFor(req) {
  if (REVIEWER_EXPLICIT) return REVIEWER;
  const h = req.headers["tailscale-user-login"];
  if (h) return String(h).trim().slice(0, 120);
  return REVIEWER;
}

// Writes must be same-origin JSON. A JSON content type cannot be sent
// cross-origin without a CORS preflight this server never answers, which is the
// real CSRF guard; the Origin comparison is belt-and-braces for browsers that
// send it. Behind a proxy the Host may be rewritten, so X-Forwarded-Host counts,
// and a request carrying the proxy's identity header is trusted as proxied.
function writeAllowed(req) {
  const ct = String(req.headers["content-type"] || "");
  if (!/^application\/json\b/i.test(ct)) return "writes must be application/json";
  const origin = req.headers.origin;
  if (!origin) return null; // curl, agents, same-origin GET-initiated fetches
  let oh;
  try { oh = new URL(origin).host; } catch { return "bad Origin header"; }
  const hosts = [req.headers.host, req.headers["x-forwarded-host"]].filter(Boolean)
    .flatMap((h) => String(h).split(",")).map((h) => h.trim());
  if (hosts.includes(oh) || req.headers["tailscale-user-login"]) return null;
  return `cross-origin write refused (Origin ${oh})`;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) reject(new Error("body too large")); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function serveStatic(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  try {
    if (req.method === "POST") {
      const refused = writeAllowed(req);
      if (refused) return json(res, 403, { error: refused });
    }

    if (p.startsWith("/api/task")) {
      const handled = await handleLabelApi(req, res, u, { roots: LABELS_ROOTS, reviewer: reviewerFor(req), readBody, json, HttpError });
      if (handled !== false) return;
    }

    if (p === "/api/home" && req.method === "GET") {
      // Everything the home screen shows: each spec set with its specs' tallies,
      // and each label task with this reviewer's progress.
      const sets = availableSets().map((set) => {
        const specs = specFiles(set).map((f) => specSummary(set, f));
        const sum = (k) => specs.reduce((a, s) => a + (s.counts[k] || 0), 0);
        const { cfg } = setConfig(set);
        return { id: set.id, name: set.name, dir: set.dir, specs: specs.map((s) => ({ slug: s.slug, title: s.title, counts: s.counts })),
          counts: { decidable: sum("decidable"), decided: sum("decided"), open: sum("open"), deferred: sum("deferred"), team: sum("team"), needsMetrics: sum("needsMetrics") },
          instructions: Boolean(cfg.instructions), configErrors: cfg.errors.length };
      });
      return json(res, 200, { specSets: sets, tasks: taskSummaries(LABELS_ROOTS, reviewerFor(req)), reviewer: reviewerFor(req) });
    }

    if (p === "/api/specsets" && req.method === "GET") {
      return json(res, 200, { sets: availableSets().map((s) => ({ id: s.id, name: s.name, dir: s.dir })) });
    }

    if (p === "/api/specs" && req.method === "GET") {
      const set = setFor(u);
      const { cfg, roots } = setConfig(set);
      return json(res, 200, { set: set.id, specsDir: set.dir, repoRoot: REPO_ROOT, config: publicSetConfig(cfg, roots), specs: specFiles(set).map((f) => specSummary(set, f)) });
    }

    if (p === "/api/specs/wait" && req.method === "GET") {
      // Long-poll for agents: answer when the condition holds, or with status
      // "timeout" after `timeout` seconds. Clients chain requests passing `since`.
      const set = setFor(u);
      const slug = u.searchParams.get("spec") || null;
      if (slug && !/^[a-z0-9-]+$/.test(slug)) throw new HttpError(400, "bad spec slug");
      const cond = parseUntil(u.searchParams.get("until") || "all-decided", "spec");
      if (cond.error) throw new HttpError(400, cond.error);
      const timeoutS = requestTimeout(u.searchParams.get("timeout"));
      if (timeoutS == null) throw new HttpError(400, "timeout must be seconds (or 90s, 5m)");
      let since = u.searchParams.get("since") || null;
      return longPoll(req, res, json, { timeoutS, check: () => {
        const st = scopeState(set, slug);
        if (cond.kind === "change" && !since) since = st.etag; // baseline: now
        const done = cond.kind === "all-decided" ? st.counts.decided === st.counts.decidable
          : cond.kind === "no-open" ? st.counts.open === 0
          : cond.kind === "decided>=" ? st.counts.decided >= cond.n
          : st.etag !== since;
        return { done, body: { until: u.searchParams.get("until") || "all-decided", set: set.id, spec: slug, etag: st.etag, since, counts: st.counts, specs: st.specs } };
      } });
    }

    if (p === "/api/search" && req.method === "GET") {
      // Global search across every spec: id, title, explanation, prose, decision
      // detail, and all notes. Multi-term queries AND together.
      const q = String(u.searchParams.get("q") || "").trim().toLowerCase();
      if (q.length < 2) return json(res, 200, { results: [] });
      const terms = q.split(/\s+/).filter(Boolean);
      const results = [];
      outer: for (const set of availableSets()) for (const file of specFiles(set)) {
        const slug = file.replace(/\.md$/, "");
        const { items } = parseSpec(fs.readFileSync(path.join(set.dir, file), "utf8"));
        for (const it of items) {
          const hay = [it.id, it.title, it.meta.explanation, it.meta.decision_detail, it.prose,
            ...((it.meta.notes || []).map((n) => n && n.text))].filter(Boolean).join("\n");
          const low = hay.toLowerCase();
          if (!terms.every((term) => low.includes(term))) continue;
          const idx = low.indexOf(terms[0]);
          const start = Math.max(0, idx - 40);
          results.push({ type: "spec", set: set.id, slug, id: it.id, title: it.title, kind: it.kind,
            status: it.meta.status || "open", decision: it.meta.decision,
            snippet: (start > 0 ? "…" : "") + hay.slice(start, idx + 130).replace(/\s+/g, " ") + "…" });
          if (results.length >= 30) break outer;
        }
      }
      // Label items too (title, summary, visible content — never hidden fields).
      for (const r of searchTasks(LABELS_ROOTS, terms, 30 - Math.min(30, results.length))) results.push(r);
      return json(res, 200, { results });
    }

    // The client needs the configured locator scheme before it can linkify prose.
    if (p === "/api/config" && req.method === "GET") {
      return json(res, 200, {
        locatorScheme: LOCATOR_SCHEME, locatorPrefix: LOCATOR_PREFIX,
        locatorSchemes: Object.keys(LOCATOR_ROOTS),
        projectName: PROJECT_NAME, reviewer: reviewerFor(req),
        repoRootPresent: fs.existsSync(REPO_ROOT),
        specSets: availableSets().map((s) => ({ id: s.id, name: s.name })),
      });
    }

    let m;
    if ((m = p.match(/^\/api\/spec\/([a-z0-9-]+)$/)) && req.method === "GET") {
      const set = setFor(u);
      const file = `${m[1]}.md`;
      if (!specFiles(set).includes(file)) return json(res, 404, { error: "unknown spec" });
      const text = fs.readFileSync(path.join(set.dir, file), "utf8");
      const { opts } = setConfig(set);
      const { frontmatter, items, errors, warnings } = validateSpecText(text, m[1], opts);
      warnings.push(...(setWarnings(set).get(m[1]) || []));
      return json(res, 200, { set: set.id, slug: m[1], frontmatter, raw: text, parseErrors: errors, warnings,
        items: items.map((it) => ({ id: it.id, title: it.title, kind: it.kind, meta: it.meta, prose: it.prose })) });
    }

    if ((m = p.match(/^\/api\/spec\/([a-z0-9-]+)\/item\/([A-Z0-9-]+)$/)) && req.method === "POST") {
      const [, slug, id] = m;
      const set = setFor(u);
      if (!specFiles(set).includes(`${slug}.md`)) return json(res, 404, { error: "unknown spec" });
      const file = path.join(set.dir, `${slug}.md`);
      const body = await readBody(req);
      const by = String(body.by || reviewerFor(req)).slice(0, 64);
      const now = new Date();
      const stamp = localStamp(now);
      const text = fs.readFileSync(file, "utf8");
      const sc = setConfig(set);
      let updated;
      if (body.action === "decision") {
        if (!body.decision) return json(res, 400, { error: "decision required" });
        // Legacy spellings (toss/accept) are accepted from old clients but the
        // stored value is always canonical — Keep = good as-is, Change = needs
        // adjustment per the recorded recommendation. An id the set declares in
        // decision-mill.yaml is stored exactly as declared (even `accept`).
        // A card with its own `options:` takes only those (plus the set verdicts
        // it keeps); the accept verdict records the recommended option.
        const target = parseSpec(text).items.find((x) => x.id === id);
        const eff = target && target.meta.options != null ? effectiveOptions(target, sc.cfg) : null;
        let decision, def;
        if (eff && eff.own) {
          const r = resolveWrite(eff, body.decision);
          if (r.error) return json(res, 400, { error: r.error });
          decision = r.decision;
          def = optionFor(eff, decision);
        } else {
          decision = canonicalDecision(String(body.decision), sc.declared);
          if (!isValidDecision(decision, sc.declared)) {
            const want = [...new Set([...sc.declared, "keep", "change", "defer", "file"])].join("|");
            return json(res, 400, { error: `invalid decision '${decision}' — want ${want}|unify-on-<slug>` });
          }
          def = sc.cfg.customDecisions ? sc.cfg.decisions.find((d) => d.id === decision) : null;
        }
        const detail = body.decision_detail ? String(body.decision_detail).trim() : "";
        if (def && def.requires_detail && !detail) {
          return json(res, 400, { error: `'${def.label}' needs a decision_detail — say what should happen (requires_detail in ${def.source === "card" ? "the card's options" : SET_CONFIG_FILE})` });
        }
        updated = updateItem(text, id, (meta) => {
          meta.decision = decision;
          meta.decision_detail = detail || null;
          meta.decided_at = localDate(now);
          meta.status = decision === "defer" ? "open" : "decided";
          meta.notes = meta.notes || [];
          meta.notes.push({ at: stamp, by, text: `decision: ${decision}${detail ? ` — ${detail}` : ""}` });
        });
      } else if (body.action === "undecide") {
        updated = updateItem(text, id, (meta) => {
          meta.decision = null; meta.decision_detail = null; meta.decided_at = null; meta.status = "open";
          meta.notes = meta.notes || [];
          meta.notes.push({ at: stamp, by, text: "decision cleared" });
        });
      } else if (body.action === "note") {
        if (!body.text) return json(res, 400, { error: "text required" });
        updated = updateItem(text, id, (meta) => {
          meta.notes = meta.notes || [];
          meta.notes.push({ at: stamp, by, text: String(body.text) });
        });
      } else if (body.action === "status") {
        const allowed = new Set(["open", "decided", "needs-metrics", "team"]);
        if (!allowed.has(body.status)) return json(res, 400, { error: "bad status" });
        updated = updateItem(text, id, (meta) => {
          if ((meta.status || "open") === body.status) return false;
          const from = meta.status || "open";
          meta.status = body.status;
          // Status flips are review decisions too; keep them in the audit trail.
          meta.notes = meta.notes || [];
          meta.notes.push({ at: stamp, by, text: `status: ${from} → ${body.status}` });
        });
      } else if (body.action === "explanation") {
        const expl = body.explanation == null ? null : String(body.explanation).trim().slice(0, 1600);
        updated = updateItem(text, id, (meta) => {
          meta.explanation = expl || null;
          meta.notes = meta.notes || [];
          meta.notes.push({ at: stamp, by, text: "explanation updated" });
        });
      } else if (body.action === "metrics") {
        // Agent-facing: set/replace the whole metrics block (FORMAT.md shape).
        // Exists so concurrent agents write through this server's serialized queue
        // instead of racing each other on the raw files.
        const mtr = body.metrics;
        if (mtr !== null && (typeof mtr !== "object" || Array.isArray(mtr))) {
          return json(res, 400, { error: "metrics must be a mapping (or null to clear)" });
        }
        if (mtr && (!Array.isArray(mtr.points) || !mtr.points.length || mtr.points.length > 4)) {
          return json(res, 400, { error: "metrics.points must be a list of 1-4 points" });
        }
        if (mtr && mtr.points.some((pt) => !pt || typeof pt !== "object" || !pt.label || !pt.value)) {
          return json(res, 400, { error: "every metrics point needs label and value" });
        }
        updated = updateItem(text, id, (meta) => {
          if (mtr === null) { if (meta.metrics == null) return false; delete meta.metrics; }
          else meta.metrics = mtr;
        });
      } else if (body.action === "append-item") {
        // Agent-facing: create a new adjudicable item, inserted before the spec's
        // GEN item so it stays last. Exists so concurrent proposer agents go
        // through this serialized write path instead of racing on raw files.
        const { items: existing } = parseSpec(text);
        if (id !== String(body.id || id)) return json(res, 400, { error: "url id and body id disagree" });
        if (existing.some((it) => it.id === id)) return json(res, 409, { error: `item ${id} already exists` });
        if (!NEW_ID_RE.test(id)) return json(res, 400, { error: "malformed id (want DIV|INV|FC|UNK|FEAT|DEC|GEN-<CAP>-<NNN>)" });
        if (!body.title || !body.meta || typeof body.meta !== "object") {
          return json(res, 400, { error: "title and meta required" });
        }
        const gen = existing.find((it) => (it.meta || {}).kind === "general");
        if (!gen) return json(res, 500, { error: "spec has no GEN item to anchor insertion" });
        const meta = { id, ...body.meta };
        meta.notes = meta.notes || [];
        meta.notes.push({ at: stamp, by, text: "item proposed" });
        const yamlText = dumpMeta(meta);
        const lines = text.split("\n");
        let offset = 0;
        for (let i = 0; i < gen.headingLine; i++) offset += lines[i].length + 1;
        const block = `### ${id} — ${String(body.title)}\n\n\`\`\`adjudication\n${yamlText}\`\`\`\n\n${String(body.prose || "").trim()}\n\n`;
        const candidate = text.slice(0, offset) + block + text.slice(offset);
        const check = validateSpecText(candidate, slug, sc.opts);
        if (check.errors.length) return json(res, 400, { error: `refused — result would not validate: ${check.errors.join("; ")}` });
        updated = candidate;
      } else {
        return json(res, 400, { error: "unknown action" });
      }
      if (updated !== text) {
        // Atomic-ish write: same-directory temp + rename, so a crash mid-write can
        // never leave a spec file truncated.
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, updated);
        fs.renameSync(tmp, file);
      }
      const { items } = parseSpec(updated);
      const item = items.find((it) => it.id === id);
      return json(res, 200, { ok: true, item: { id: item.id, title: item.title, kind: item.kind, meta: item.meta, prose: item.prose } });
    }

    if (p === "/api/code" && req.method === "GET") {
      const locator = u.searchParams.get("locator");
      const linesParam = u.searchParams.get("lines");
      // Roots are per set (decision-mill.yaml may add some); without ?set= the
      // global roots apply.
      const roots = u.searchParams.get("set") ? setConfig(setFor(u)).roots : LOCATOR_ROOTS;
      const { scheme, rel, abs, root } = resolveLocator(locator, roots);
      if (!fs.existsSync(abs)) {
        return json(res, 404, { error: `not found in ${scheme}: checkout (${root}): ${rel}`, rel, suggestions: suggestLocators(scheme, root, rel) });
      }
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        const names = fs.readdirSync(abs).sort();
        const entries = names.slice(0, 200).map((name) => {
          let dir = false;
          try { dir = fs.statSync(path.join(abs, name)).isDirectory(); } catch { /* broken symlink */ }
          return { name, dir, locator: `${scheme}:${rel}/${name}` };
        });
        return json(res, 200, { locator, rel, directory: true, entries, truncated: names.length > entries.length });
      }
      if (stat.size > 5e6) return json(res, 413, { error: "file too large" });
      const raw = fs.readFileSync(abs, "utf8");
      const all = raw.split("\n");
      // A trailing newline yields a phantom final empty element; don't count it.
      if (all.length > 1 && all[all.length - 1] === "") all.pop();
      const totalLines = all.length;
      const { ranges, warning } = parseLineRanges(linesParam, totalLines);
      // 60% of spec locators carry no line range; without this the reviewer was
      // stuck at the first 500 lines of a 2000-line file with no way forward.
      const wantAll = u.searchParams.get("all") === "1";
      let start = 1, end = Math.min(totalLines, wantAll ? 20000 : 500);
      if (ranges.length && !wantAll) {
        start = Math.max(1, ranges[0][0] - 25);
        end = Math.min(totalLines, ranges[ranges.length - 1][1] + 25);
        // Multi-range evidence can span a lot of file; keep the payload bounded but
        // always include the first range with context.
        if (end - start > 1500) end = Math.min(totalLines, Math.max(ranges[0][1] + 25, start + 1500));
      }
      return json(res, 200, {
        locator, rel, language: LANG_BY_EXT[path.extname(abs)] || "text",
        totalLines, start, end,
        highlight: ranges.length ? ranges[0] : null, // back-compat
        ranges, lines: linesParam || null, warning,
        truncated: end < totalLines,
        content: all.slice(start - 1, end).join("\n"),
      });
    }

    if (p === "/api/validate" && req.method === "GET") {
      const set = setFor(u);
      const { cfg, opts } = setConfig(set);
      const cross = setWarnings(set);
      const results = specFiles(set).map((f) => {
        const slug = f.replace(/\.md$/, "");
        const { errors, warnings } = validateSpecText(fs.readFileSync(path.join(set.dir, f), "utf8"), slug, opts);
        return { set: set.id, slug, errors, warnings: [...warnings, ...(cross.get(slug) || [])] };
      });
      return json(res, 200, { results, config: { errors: cfg.errors, warnings: cfg.warnings }, ok: !cfg.errors.length && results.every((r) => r.errors.length === 0) });
    }

    if (p === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (p === "/vendor/marked.js") {
      return serveStatic(res, path.join(HERE, "node_modules/marked/lib/marked.umd.js"));
    }
    if (p === "/" || p === "/index.html") return serveStatic(res, path.join(HERE, "public/index.html"));
    if (/^\/[a-z0-9_-]+\.(html|js|css|svg)$/.test(p)) return serveStatic(res, path.join(HERE, "public", path.basename(p)));
    res.writeHead(404); res.end("not found");
  } catch (e) {
    const code = e instanceof HttpError ? e.code
      : /^item not found:/.test(e.message) ? 404
      : /not editable:/.test(e.message) ? 409
      : e instanceof SyntaxError ? 400
      : 500;
    if (code === 500) console.error(`[500] ${req.method} ${req.url}`, e);
    json(res, code, { error: e.message });
  }
});

for (const s of SPEC_SETS) if (!availableSets().includes(s)) console.error(`decision-mill: specs dir not found, skipping: ${s.dir}`);
// A missing labels root is a warning, not a stop: tasks are discovered per request,
// so a dataset being built in parallel shows up on the home screen when it lands.
for (const r of LABELS_ROOTS) if (!fs.existsSync(r)) console.error(`decision-mill: labels root not found yet (tasks appear once it exists): ${r}`);
if (!availableSets().length && !LABELS_ROOTS.length) {
  console.error("decision-mill: nothing to serve.");
  console.error("  spec mode:  SPECS_DIR=/path/to/specs node server.js   (or --specs DIR)");
  console.error("  label mode: LABELS_ROOT=~/.local/share/labels node server.js   (or --labels DIR)");
  process.exit(2);
}

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`decision-mill: port ${PORT} already in use — set PORT=<other>`);
  else console.error("decision-mill:", e.message);
  process.exit(2);
});

server.listen(PORT, HOST, () => {
  const shown = HOST.includes(":") ? `[${HOST}]` : HOST;
  const base = `http://${shown}:${PORT}`;
  const missing = (r) => (fs.existsSync(r) ? "" : "  (MISSING)");
  console.log(`decision-mill: ${base}/`);
  for (const s of availableSets()) {
    const { cfg, roots } = setConfig(s);
    const n = specFiles(s).length;
    console.log(`  specs [${s.id}]: ${s.dir}  (${n} spec${n === 1 ? "" : "s"})  ${base}/#/spec/${s.id}`);
    if (cfg.present) {
      console.log(`    ${SET_CONFIG_FILE}: ${cfg.customDecisions ? `decisions ${cfg.decisions.map((d) => `${d.id}${d.key ? `[${d.key}]` : ""}`).join(" ")}` : "default decisions"}${cfg.options.length ? ` · options ${cfg.options.map((o) => o.id).join(" ")}` : ""}${cfg.instructions ? " · instructions" : ""}`);
      for (const e of cfg.errors) console.error(`    ERROR ${e}`);
    }
    for (const [k, r] of Object.entries(roots)) if (!(k in LOCATOR_ROOTS) || LOCATOR_ROOTS[k] !== r) console.log(`    locator root ${k}: -> ${r}${missing(r)}`);
  }
  if (availableSets().length) {
    for (const [k, r] of Object.entries(LOCATOR_ROOTS)) console.log(`  locator root ${k}: -> ${r}${missing(r)}`);
    console.log(`  agents: wait for decisions with  node wait.js --url ${base} --until all-decided`);
  }
  for (const r of LABELS_ROOTS) {
    const tasks = discoverTasks([r]);
    console.log(`  labels root: ${r}  (${tasks.length} task(s))`);
    for (const t of tasks.slice(0, 12)) console.log(`    ${t.id}: ${base}/#/task/${encodeURIComponent(t.id)}`);
    if (tasks.length > 12) console.log(`    … ${tasks.length - 12} more on the home screen`);
  }
  console.log(`  reviewer: ${REVIEWER_EXPLICIT ? REVIEWER : `Tailscale-User-Login header, else "${REVIEWER}"`}`);
});
