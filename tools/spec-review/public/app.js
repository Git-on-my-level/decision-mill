/* Spec Review Bench — thin human editor over the machine-readable specs. */
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const state = {
  specs: [],
  slug: null,
  items: [],
  parseErrors: [],
  warnings: [],
  // Status and kind are two independent axes now — one used to be eight chips that
  // could not be combined ("open divergences" was unaskable).
  status: "all", // all | open | deferred | decided | needs-metrics
  kind: "all",   // all | divergence | invariant | failure-case | unknown
  focusId: null,
  drafts: Object.create(null), // itemId -> unsent note text, survives re-render
  // Filled from /api/config at boot. The locator scheme is a per-project knob
  // (see FORMAT.md), so nothing in this file may hardcode it.
  config: { locatorScheme: "repo", locatorPrefix: "repo:", projectName: "", reviewer: "reviewer" },
};

const KIND_LABEL = { divergence: "DIV", invariant: "INV", "failure-case": "FC", unknown: "UNK", feature: "FEAT", general: "GEN" };
const DECIDABLE = (it) => it.kind !== "general";

// Single-reviewer tool: the identity picker was noise. Notes written by agents
// (e.g. metrics-agent) still carry their own `by` in the spec files.
function who() { return state.config.reviewer || "reviewer"; }

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function md(text) {
  if (!text) return "";
  // Never let a missing/broken markdown vendor blank the whole review page.
  if (typeof marked === "undefined") return `<pre class="prose-raw">${esc(text)}</pre>`;
  try {
    return marked.parse(text);
  } catch (e) {
    return `<pre class="prose-raw">${esc(text)}</pre>`;
  }
}

/* ---------- sidebar ---------- */
async function loadSpecs(keepSelection) {
  const data = await api("/api/specs");
  state.specs = data.specs;
  const nav = $("#spec-list");
  nav.innerHTML = "";
  for (const s of state.specs) {
    // GEN items have no decide affordance — exclude them from the denominator,
    // otherwise no spec can ever read 100%.
    const denom = s.counts.decidable || s.counts.total || 1;
    const btn = document.createElement("button");
    btn.className = "spec-row" + (s.slug === state.slug ? " active" : "");
    const done = Math.round((s.counts.decided / denom) * 100);
    // Segmented meter: every non-open state gets a colored slice, so the unfilled
    // remainder means exactly "still open". Bar fully colored = Open filter empty.
    const c = s.counts;
    const seg = (n, cls) => n ? `<i class="${cls}" style="width:${(n / denom) * 100}%"></i>` : "";
    const openN = c.open ?? Math.max(0, denom - c.decided - (c.needsMetrics || 0) - (c.team || 0) - (c.deferred || 0));
    btn.innerHTML = `
      <div class="name">${esc(s.title)}</div>
      <div class="meter" role="img" aria-label="${c.decided} of ${denom} decided, ${openN} open">
        ${seg(c.decided, "m-decided")}${seg(c.needsMetrics, "m-metrics")}${seg(c.team, "m-team")}${seg(c.deferred, "m-deferred")}
      </div>
      <div class="stats">${c.decided}/${denom} decided · ${done}%${openN ? ` · <b class="open-count">${openN} open</b>` : " · clear"}${c.needsMetrics ? ` · ${c.needsMetrics} metrics` : ""}${s.parseErrors.length ? " · PARSE ERR" : ""}</div>`;
    btn.onclick = () => selectSpec(s.slug);
    nav.appendChild(btn);
  }
  renderBucketTotals();
  if (!keepSelection && !state.slug && state.specs.length) selectSpec(state.specs[0].slug);
}

// Program-wide bucket tally pinned under the spec list — same colors as the meters.
function renderBucketTotals() {
  const el = $("#bucket-totals");
  if (!el) return;
  const sum = (k) => state.specs.reduce((a, s) => a + (s.counts[k] || 0), 0);
  const total = sum("decidable");
  const rows = [
    ["decided", sum("decided"), "t-decided"],
    ["open", sum("open"), "t-open"],
    ["needs metrics", sum("needsMetrics"), "t-metrics"],
    ["team", sum("team"), "t-team"],
    ["deferred", sum("deferred"), "t-deferred"],
  ];
  el.innerHTML = `<div class="bt-head">all specs · ${sum("decided")}/${total}</div>` + rows
    .map(([label, n, cls]) => `<div class="bt-row"><i class="dot ${cls}"></i><span class="bt-label">${label}</span><b class="bt-n${label === "open" && n ? " hot" : ""}">${n}</b></div>`)
    .join("");
}

let selectToken = 0;
async function selectSpec(slug) {
  const tok = ++selectToken;
  state.slug = slug;
  state.focusId = null;
  const data = await api(`/api/spec/${slug}`);
  if (tok !== selectToken) return; // a later click won; don't paint stale data
  state.items = data.items;
  state.parseErrors = data.parseErrors || [];
  state.warnings = data.warnings || [];
  const fm = data.frontmatter || {};
  const list = (cls, label, arr) => arr.length
    ? `<div class="${cls}">${esc(label)}${arr.map((e) => `<div>· ${esc(e)}</div>`).join("")}</div>` : "";
  $("#spec-header").innerHTML = `
    <h2>${esc(fm.title || slug)}</h2>
    <div class="meta">${esc(slug)}.md · baseline ${esc(String(fm.baseline || "").slice(0, 10))} · status ${esc(fm.status || "?")}</div>
    ${list("parse-errors", "parse errors:", state.parseErrors)}
    ${list("spec-warnings", "format warnings:", state.warnings)}`;
  renderFilters();
  renderItems();
  loadSpecs(true);
  $("#main").scrollTop = 0;
}

/* ---------- filters + progress ---------- */
// Three status chips + one kind <select>. Needs-metrics is not a review verdict, so
// it is not a chip: it is reachable from the count in the summary line.
// "Deferred" is its own bucket: a defer keeps status open in the spec file, but the
// reviewer wants Open to be only the items still awaiting a first pass.
// "Team" parks an item for the live team walkthrough (screen share); it is a real
// status in the spec file, excluded from Open like deferred is.
const STATUS_FILTERS = [["all", "All"], ["open", "Open"], ["deferred", "Deferred"], ["team", "Team"], ["decided", "Decided"]];
const KIND_FILTERS = [
  ["all", "All kinds"], ["divergence", "Divergences"], ["invariant", "Invariants"],
  ["failure-case", "Failure cases"], ["unknown", "Unknowns"], ["feature", "Features"],
];

function renderFilters() {
  const el = $("#filters");
  el.innerHTML = "";
  for (const [key, label] of STATUS_FILTERS) {
    const b = document.createElement("button");
    b.className = "filter" + (state.status === key ? " on" : "");
    b.textContent = label;
    b.setAttribute("aria-pressed", String(state.status === key));
    b.onclick = () => { state.status = key; renderFilters(); renderItems(); };
    el.appendChild(b);
  }
  const sel = document.createElement("select");
  sel.className = "kind-select";
  sel.setAttribute("aria-label", "Filter by kind");
  for (const [key, label] of KIND_FILTERS) {
    const o = document.createElement("option");
    o.value = key;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = state.kind;
  sel.onchange = () => { state.kind = sel.value; renderFilters(); renderItems(); };
  el.appendChild(sel);
  renderProgress();
}

function renderProgress() {
  const decidable = state.items.filter(DECIDABLE);
  const decided = decidable.filter((i) => (i.meta.status || "open") === "decided").length;
  const metrics = decidable.filter((i) => (i.meta.status || "open") === "needs-metrics").length;
  const el = $("#progress");
  el.innerHTML = `${decided}/${decidable.length} decided`
    + (metrics ? ` · <a href="#" class="metrics-link${state.status === "needs-metrics" ? " on" : ""}">${metrics} needs metrics</a>` : "");
  const link = el.querySelector(".metrics-link");
  if (link) link.onclick = (e) => {
    e.preventDefault();
    // Second click on an active link goes back to everything, so the filter is not
    // a one-way trip with no visible chip to undo it.
    state.status = state.status === "needs-metrics" ? "all" : "needs-metrics";
    renderFilters();
    renderItems();
  };
}

function visibleItems() {
  return state.items.filter((it) => {
    const st = it.meta.status || "open";
    const deferred = it.meta.decision === "defer";
    // GEN items are notes containers, not pending work — visible under All only.
    if (it.kind === "general" && state.status !== "all") return false;
    if (state.status === "open") { if (st !== "open" || deferred) return false; }
    else if (state.status === "deferred") { if (!deferred || st === "team") return false; } // team-parked wins; defer verdict resurfaces on un-park
    else if (state.status !== "all" && st !== state.status) return false;
    if (state.kind !== "all" && it.kind !== state.kind) return false;
    return true;
  });
}

/* ---------- items ---------- */
function renderItems() {
  const wrap = $("#items");
  wrap.innerHTML = "";
  const items = visibleItems();
  if (!items.length) { wrap.innerHTML = `<div class="empty">Nothing under this filter.</div>`; return; }
  for (const it of items) wrap.appendChild(renderItem(it));
  applyFocus();
}

// The spec vocabulary is unchanged; only its presentation is plain English.
// `accept` is a legacy value the UI no longer writes — it reads as a Keep.
const VERDICT_LABEL = { toss: "CHANGE", accept: "KEEP" };
const VERDICT_CLASS = { accept: "keep" };

function verdictCls(decision) {
  const base = String(decision).split("-")[0];
  const known = ["keep", "toss", "unify", "accept", "reject", "defer", "file"].includes(base) ? base : "defer";
  return VERDICT_CLASS[known] || known;
}

// Compact badge: verdict + date only. The rationale is NOT shown here — all
// reviewer-written text renders in one place, the notes timeline above the
// textarea, so it never appears in two different positions depending on state.
function stampHtml(meta) {
  if (!meta.decision) return "";
  const decision = String(meta.decision);
  const label = VERDICT_LABEL[decision] || decision.toUpperCase();
  return `<div class="stamp v-${verdictCls(decision)}">${esc(label)}
    <small>${esc(meta.decided_at || "")}</small></div>`;
}

// unify-on-<slug>: keep the machine value in the documented vocabulary and put the
// reviewer's raw wording in decision_detail.
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// There used to be a second text field here — a per-decision "detail" input with its
// own Confirm/Cancel step. Two boxes for one thought. Now the item has exactly one
// textarea: whatever is in it when a verdict is clicked becomes decision_detail.
// Shown while the unify target is being typed: reviewers read "unify on X" as
// "make X the shared design" and needed to be told what it actually commits to.
const UNIFY_NOTE = "the rewrite adopts this target's behavior on all platforms (e.g. macos, server, windows)";

/* ---------- locators in prose ----------
   The extractor writes `<prefix>:path:lines` inline in the prose AND repeats it in
   the structured evidence list, so the reviewer read every citation twice. Fix in
   the UI: make the prose citations clickable, then drop the evidence rows the prose
   already covers. Spec bytes are untouched. */

// Built from the configured locator scheme at boot — see buildLocatorPatterns().
// A locator may be broken across a source line by wrapping, but only right after a
// "/" or "-" — allow whitespace there and nowhere else, so the match cannot run on
// into the next sentence.
let LOC_RE = null;
let LOC_TOKEN_RE = null;

function buildLocatorPatterns(scheme) {
  const q = scheme.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  LOC_RE = new RegExp(`${q}:(?:[A-Za-z0-9._~@+]|[-/][ \\t]*\\n?[ \\t]*)+(?::\\d+(?:-\\d+)?(?:,\\d+(?:-\\d+)?)*)?`, "g");
  LOC_TOKEN_RE = new RegExp(`^(${q}:[^\\s]*?)(?::(\\d+(?:-\\d+)?(?:,\\d+(?:-\\d+)?)*))?$`);
}
buildLocatorPatterns("repo");

// Split a raw prose token into {locator, lines}. Returns null for anything the code
// panel could not open anyway (elided `<prefix>:.../x.ts` paths, bare `<prefix>:`).
function parseLocatorToken(raw) {
  const flat = raw.replace(/\s+/g, "").replace(/[.,;:!?)\]}'"]+$/, "");
  const m = flat.match(LOC_TOKEN_RE);
  if (!m) return null;
  const locator = m[1];
  const rel = locator.slice(state.config.locatorPrefix.length);
  if (!rel || rel.startsWith("/") || rel.split("/").includes("..") || rel.split("/").includes("...")) return null;
  return { locator, lines: m[2] || null };
}

const evKey = (locator, lines) => `${locator}|${lines == null || lines === "" ? "" : String(lines)}`;

// Walk the rendered prose, turn every locator into a code-panel link, and report the
// set of locator|lines pairs the prose already cites.
function linkifyLocators(root) {
  const cited = new Set();
  if (!root) return cited;
  const texts = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    // Never linkify inside an existing anchor — that would nest <a> in <a>.
    if (n.parentElement && n.parentElement.closest("a")) continue;
    if (n.nodeValue.includes(state.config.locatorPrefix)) texts.push(n);
  }
  for (const node of texts) {
    const text = node.nodeValue;
    LOC_RE.lastIndex = 0;
    let last = 0;
    const frag = document.createDocumentFragment();
    let m;
    while ((m = LOC_RE.exec(text))) {
      const parsed = parseLocatorToken(m[0]);
      if (!parsed) continue;
      // Trailing punctuation was trimmed for parsing; leave those characters in the
      // prose rather than swallowing them into the link text.
      const trimmed = m[0].length - m[0].replace(/[.,;:!?)\]}'"]+$/, "").length;
      const end = m.index + m[0].length - trimmed;
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement("a");
      a.className = "loc-link";
      a.href = "#";
      a.dataset.locator = parsed.locator;
      if (parsed.lines) a.dataset.lines = parsed.lines;
      a.textContent = text.slice(m.index, end);
      a.title = `open ${parsed.locator}${parsed.lines ? `:${parsed.lines}` : ""}`;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openCode({ locator: parsed.locator, lines: parsed.lines });
      });
      frag.appendChild(a);
      cited.add(evKey(parsed.locator, parsed.lines));
      last = end;
    }
    if (!frag.childNodes.length) continue;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
  return cited;
}

/* ---------- metrics strip ---------- */
// Grounding numbers for needs-metrics/UNK items, written by a metrics agent. Absent
// on nearly every item; when present it must scan in one glance, so: no table.
function metricsHtml(metrics) {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return "";
  const points = Array.isArray(metrics.points) ? metrics.points.filter((p) => p && typeof p === "object") : [];
  if (!points.length) return "";
  const stats = points.slice(0, 4).map((p) => `
    <div class="mstat">
      <div class="mlabel">${esc(p.label == null ? "—" : p.label)}</div>
      <div class="mvalue">${esc(p.value == null ? "—" : p.value)}</div>
      ${p.note ? `<div class="mnote">${esc(p.note)}</div>` : ""}
    </div>`).join("");
  const src = [metrics.source, metrics.as_of].filter(Boolean).map(String).join(" · ");
  return `<div class="metrics">${stats}${src ? `<div class="msrc">${esc(src)}</div>` : ""}</div>`;
}

function renderItem(it) {
  const meta = it.meta;
  const el = document.createElement("article");
  el.className = "item";
  el.dataset.status = meta.status || "open";
  el.dataset.id = it.id;
  // One timeline for everything the reviewer wrote, in order, next to the input.
  // Audit notes ("decision: toss — why") render with a colored verdict tag instead
  // of the raw prefix; status flips and clears render muted.
  const notes = (meta.notes || []).map((n) => {
    const t = String(n.text || "");
    const m = t.match(/^decision: (\S+)(?: — ([\s\S]+))?$/);
    // Agent recommendations ("rec: toss — why") get the same translated verdict
    // chip as decisions, prefixed REC, so the label matches the buttons above.
    const r = t.match(/^rec: (\S+)(?: — ([\s\S]+))?$/);
    let cls = "note-row", body;
    if (m) {
      body = `<span class="vtag v-${verdictCls(m[1])}">${esc(VERDICT_LABEL[m[1]] || m[1].toUpperCase())}</span>${m[2] ? esc(m[2]) : ""}`;
    } else if (r) {
      body = `<span class="vtag v-rec">REC · ${esc(VERDICT_LABEL[r[1]] || r[1].toUpperCase())}</span>${r[2] ? esc(r[2]) : ""}`;
    } else if (/^status: /.test(t) || t === "decision cleared") {
      cls += " sys";
      body = esc(t);
    } else {
      body = esc(t);
    }
    // Text gets the full row; timestamp (and author, only when it isn't the
    // reviewer) sits in a small line underneath.
    const metaBits = [n.at, n.by && n.by !== who() ? n.by : null].filter(Boolean).map(esc).join(" · ");
    return `<div class="${cls}"><div class="ntext">${body}</div>${metaBits ? `<div class="nmeta">${metaBits}</div>` : ""}</div>`;
  }).join("");
  const isGeneral = !DECIDABLE(it);
  const isMetrics = (meta.status || "open") === "needs-metrics";
  // Only divergences can be unified — there is nothing to converge on for an
  // invariant, a failure case or an unknown.
  const isDivergence = it.kind === "divergence" || /^DIV-/.test(it.id);
  el.innerHTML = `
    <div class="body">
      <div class="item-head">
        <span class="item-id">${esc(it.id)}</span>
        <span class="item-title">${esc(it.title)}</span>
        <span class="chips">
          <span class="chip">${esc(KIND_LABEL[it.kind] || it.kind || "?")}</span>
          ${meta.proposed && meta.proposed !== "n/a" ? `<span class="chip ${meta.proposed === "toss" ? "proposed-toss" : ""}">→ ${esc(meta.proposed)}</span>` : ""}
          ${meta.confidence ? `<span class="chip conf-${esc(slugify(meta.confidence))}">${esc(meta.confidence)}</span>` : ""}
          ${isMetrics ? "" : `<span class="chip">${esc(meta.status || "open")}</span>`}
          ${isGeneral ? "" : `<button class="chip mchip${isMetrics ? " on" : ""}" data-status="${isMetrics ? "open" : "needs-metrics"}"
            type="button" aria-pressed="${isMetrics}" title="flag for the metrics agent — not a verdict">needs metrics</button>`}
        </span>
      </div>
      ${typeof meta.explanation === "string" && meta.explanation.trim()
        ? ((meta.status === "team")
          ? `<div class="explanation agenda"><div class="agenda-eyebrow">on the table</div>${esc(meta.explanation.trim())}</div>`
          : `<p class="explanation">${esc(meta.explanation.trim())}</p>`) : ""}
      ${stampHtml(meta)}
      ${metricsHtml(meta.metrics)}
      ${meta.status === "team"
        ? `<details class="deep-dive"><summary>deep dive — full analysis &amp; evidence</summary><div class="prose">${md(it.prose)}</div></details>`
        : `<div class="prose">${md(it.prose)}</div>`}
      <div class="evidence" hidden></div>
      ${isGeneral ? "" : `
      <div class="actions">
        <span class="lbl">decide</span>
        <button class="btn b-keep" data-d="keep" type="button">Keep</button>
        <button class="btn b-toss" data-d="toss" type="button">Change</button>
        <button class="btn ghost" data-d="defer" type="button">Defer</button>
        <button class="btn ghost b-team" data-team type="button" aria-pressed="${(meta.status || "open") === "team"}"
          title="park for the live team walkthrough — not a verdict">${(meta.status || "open") === "team" ? "✓ Team" : "Team"}</button>
        ${isDivergence ? `<button class="btn b-unify" data-d="unify" type="button">Unify on…</button>` : ""}
        ${meta.decision ? `<button class="btn undo" data-undecide type="button">↩ Undo decision</button>` : ""}
      </div>
      <div class="unify-row" hidden>
        <span class="pending mono">unify-on-</span>
        <input placeholder="target — e.g. macos, server, windows" spellcheck="false">
        <button class="btn b-unify" data-unify-go type="button">Unify</button>
        <button class="btn ghost" data-unify-cancel type="button">Cancel</button>
      </div>
      <div class="detail-hint" hidden></div>`}
      <div class="notes">
        ${notes}
        <div class="note-add">
          <textarea placeholder="note / decision rationale — saved with your next decision, or Add note to save it alone (⌘/Ctrl+Enter)" spellcheck="false"></textarea>
          <button class="btn" data-note type="button">Add note</button>
        </div>
      </div>
    </div>`;

  el.addEventListener("mousedown", () => setFocus(it.id));

  // Prose first: linkifying it tells us which citations the evidence list would only
  // be repeating. Anything the prose does not mention still gets its own row.
  const cited = linkifyLocators(el.querySelector(".prose"));
  const evWrap = el.querySelector(".evidence");
  const evidence = (meta.evidence || [])
    .map((ev, i) => ({ ev, i }))
    .filter(({ ev }) => ev && ev.locator && !cited.has(evKey(String(ev.locator), ev.lines)));
  if (evidence.length) {
    evWrap.hidden = false;
    evWrap.innerHTML = evidence.map(({ ev, i }) => `
      <button class="ev" data-ev="${i}" type="button">
        <span class="loc">${esc(ev.locator)}${ev.lines != null ? `:${esc(ev.lines)}` : ""}</span>
        ${ev.note ? `<span class="note">${esc(ev.note)}</span>` : ""}
      </button>`).join("");
    for (const evBtn of evWrap.querySelectorAll(".ev")) {
      evBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openCode((meta.evidence || [])[Number(evBtn.dataset.ev)]);
      });
    }
  }

  /* ---- notes / rationale: the item's one and only text field ---- */
  const ta = el.querySelector(".note-add textarea");
  const noteBtn = el.querySelector("[data-note]");
  if (state.drafts[it.id]) ta.value = state.drafts[it.id];
  ta.addEventListener("input", () => { state.drafts[it.id] = ta.value; });
  // Whatever is typed here rides along with the next verdict as decision_detail.
  // Dropping the draft *before* the write's re-render is what stops the text from
  // reappearing in the box and inviting a second save; it is restored if the write
  // failed, so nothing the reviewer typed is ever lost silently.
  const takeText = () => {
    const text = ta.value.trim();
    if (text) delete state.drafts[it.id];
    return text;
  };
  const restoreText = (text) => { if (text) state.drafts[it.id] = text; };

  /* ---- decision flow: one click, no confirm stage ---- */
  const hint = el.querySelector(".detail-hint");
  // kind "note" = neutral guidance, "warn" = you must fix something.
  const showHint = (msg, kind = "warn") => {
    if (!hint) return;
    hint.textContent = msg || "";
    hint.className = `detail-hint${msg && kind === "note" ? " note" : ""}`;
    hint.hidden = !msg;
  };
  const unifyRow = el.querySelector(".unify-row");
  const unifyInput = unifyRow && unifyRow.querySelector("input");
  const closeUnify = () => {
    if (!unifyRow) return;
    unifyRow.hidden = true;
    unifyInput.value = "";
    showHint("");
  };
  el.__closeUnify = closeUnify;

  let writing = false; // one-click deciding must not double-write on a double-click
  const decide = async (decision, detail) => {
    // "Change" (stored: toss) never means delete. Auto-prefix the reviewer's detail
    // with the FORMAT.md disambiguator so agents can't misread it: features cut via
    // this button are removals; everything else is a redesign instruction.
    if (decision === "toss" && detail && !/^(remove|change|resolved|moot):/.test(detail)) {
      detail = (it.kind === "feature" ? "remove: " : "change: ") + detail;
    }
    if (writing) return;
    writing = true;
    for (const b of el.querySelectorAll("[data-d], [data-unify-go]")) b.disabled = true;
    try {
      const ok = await act(it.id, { action: "decision", decision, decision_detail: detail || null, by: who() });
      if (!ok) restoreText(detail);
    } finally {
      writing = false;
      for (const b of el.querySelectorAll("[data-d], [data-unify-go]")) b.disabled = false;
    }
  };

  for (const btn of el.querySelectorAll("[data-d]")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      // Unify is the one verdict that needs a target, so it gets a small inline
      // input — the target only, not a second rationale box.
      if (btn.dataset.d === "unify") {
        unifyRow.hidden = false;
        showHint(UNIFY_NOTE, "note");
        unifyInput.focus();
        return;
      }
      closeUnify();
      decide(btn.dataset.d, takeText());
    });
  }

  if (unifyRow) {
    const commitUnify = () => {
      const target = unifyInput.value.trim();
      if (!target) {
        showHint("Unify needs a target — say what the surfaces should unify on.");
        unifyInput.focus();
        return;
      }
      const slug = slugify(target);
      if (!slug) {
        showHint("Unify target must contain letters or digits.");
        unifyInput.focus();
        return;
      }
      closeUnify();
      decide(`unify-on-${slug}`, takeText());
    };
    unifyRow.querySelector("[data-unify-go]").addEventListener("click", (e) => { e.stopPropagation(); commitUnify(); });
    unifyRow.querySelector("[data-unify-cancel]").addEventListener("click", (e) => { e.stopPropagation(); closeUnify(); });
    unifyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commitUnify(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeUnify(); }
    });
  }

  // Team is a parking lot, not a verdict: it toggles status team <-> open and
  // saves any typed note first so the discussion context isn't lost.
  const teamBtn = el.querySelector("[data-team]");
  if (teamBtn) teamBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    teamBtn.disabled = true;
    try {
      const text = takeText();
      if (text) await act(it.id, { action: "note", text, by: who() });
      const next = (it.meta.status || "open") === "team" ? "open" : "team";
      await act(it.id, { action: "status", status: next, by: who() });
    } finally { teamBtn.disabled = false; }
  });

  const statusBtn = el.querySelector("[data-status]");
  if (statusBtn) statusBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    statusBtn.disabled = true;
    try { await act(it.id, { action: "status", status: statusBtn.dataset.status, by: who() }); }
    finally { statusBtn.disabled = false; }
  });

  const und = el.querySelector("[data-undecide]");
  if (und) und.addEventListener("click", async (e) => {
    e.stopPropagation();
    und.disabled = true;
    try { await act(it.id, { action: "undecide", by: who() }); } finally { und.disabled = false; }
  });

  /* ---- note without a decision ---- */
  const addNote = async () => {
    if (noteBtn.disabled) return;
    const text = takeText();
    if (!text) return;
    noteBtn.disabled = true;
    try {
      const ok = await act(it.id, { action: "note", text, by: who() });
      if (!ok) restoreText(text);
    } finally {
      noteBtn.disabled = false;
    }
  };
  noteBtn.addEventListener("click", (e) => { e.stopPropagation(); addNote(); });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addNote(); }
  });
  return el;
}

// Patch one item in place: a full re-render used to throw away every other item's
// unsent note, the reviewer's scroll position, and the focus ring.
function patchItem(id) {
  const item = state.items.find((it) => it.id === id);
  const el = $(`#items .item[data-id="${CSS.escape(id)}"]`);
  if (!item || !el) { renderItems(); return; }
  el.replaceWith(renderItem(item));
  applyFocus();
}

async function act(id, body) {
  try {
    const res = await api(`/api/spec/${state.slug}/item/${id}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const i = state.items.findIndex((it) => it.id === id);
    if (i !== -1) state.items[i] = res.item;
    patchItem(id);
    renderProgress();
    loadSpecs(true);
    return true;
  } catch (e) {
    alert(`Write failed: ${e.message}`);
    return false;
  }
}

/* ---------- code panel ---------- */
function openPanel(title) {
  $("#code-panel").hidden = false;
  $("#app").classList.add("with-code");
  $("#code-title").textContent = title;
}

function wireCodeLinks() {
  for (const a of $("#code-body").querySelectorAll("[data-locator]")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openCode({ locator: a.dataset.locator });
    });
  }
}

let codeToken = 0;
async function openCode(ev, all) {
  if (!ev || !ev.locator) return;
  const tok = ++codeToken;
  const label = `${ev.locator}${ev.lines != null ? `:${ev.lines}` : ""}`;
  openPanel(label);
  $("#code-body").innerHTML = `<div class="code-msg">loading…</div>`;
  let data;
  try {
    const params = new URLSearchParams({ locator: ev.locator });
    if (ev.lines != null) params.set("lines", String(ev.lines));
    if (all) params.set("all", "1");
    data = await api(`/api/code?${params}`);
    if (tok !== codeToken) return; // superseded by a newer evidence click
  } catch (e) {
    if (tok !== codeToken) return;
    // Errors belong in the panel next to the locator, not in a modal alert that
    // loses the path you were chasing.
    const sugg = (e.body && e.body.suggestions) || [];
    $("#code-body").innerHTML = `
      <div class="code-msg err">${esc(e.message)}</div>
      ${sugg.length ? `<div class="code-msg">did you mean:${sugg.map((s) => `<div><a href="#" data-locator="${esc(s)}">${esc(s)}</a></div>`).join("")}</div>`
        : `<div class="code-msg">no similar path found in the checkout — the spec locator is probably stale.</div>`}`;
    wireCodeLinks();
    return;
  }

  if (data.directory) {
    openPanel(`${data.rel}/ (directory)`);
    $("#code-body").innerHTML = data.entries.map((e) => `
      <div class="cl"><span class="ln"></span><a href="#" data-locator="${esc(e.locator)}">${esc(e.name)}${e.dir ? "/" : ""}</a></div>`).join("")
      + (data.truncated ? `<div class="code-msg">… listing truncated</div>` : "");
    wireCodeLinks();
    return;
  }

  const ranges = data.ranges && data.ranges.length ? data.ranges : (data.highlight ? [data.highlight] : []);
  const rangeNote = ranges.length > 1 ? ` · ${ranges.length} ranges` : "";
  openPanel(`${data.rel} · L${data.start}–${data.end} of ${data.totalLines}${rangeNote}`);
  const inRange = (n) => ranges.some(([a, b]) => n >= a && n <= b);
  const body = data.content.split("\n").map((line, i) => {
    const n = data.start + i;
    return `<div class="cl${inRange(n) ? " hl" : ""}"><span class="ln">${n}</span>${esc(line) || " "}</div>`;
  }).join("");
  $("#code-body").innerHTML =
    (data.warning ? `<div class="code-msg warn">${esc(data.warning)}</div>` : "")
    + body
    + (data.truncated
      ? `<div class="code-msg">… ${data.totalLines - data.end} more lines not shown — <a href="#" data-showall="1">show whole file</a></div>`
      : "");
  const showAll = $("#code-body [data-showall]");
  if (showAll) showAll.addEventListener("click", (e) => { e.preventDefault(); openCode(ev, true); });
  const firstHl = $("#code-body .cl.hl");
  if (firstHl) firstHl.scrollIntoView({ block: "center" });
  else $("#code-body").scrollTop = 0;
}

function closeCode() {
  $("#code-panel").hidden = true;
  $("#app").classList.remove("with-code");
}

/* ---------- keyboard ---------- */
function setFocus(id) {
  state.focusId = id;
  applyFocus();
}

function applyFocus() {
  for (const el of document.querySelectorAll("#items .item")) {
    el.classList.toggle("focused", el.dataset.id === state.focusId);
  }
}

function moveFocus(delta) {
  const els = Array.from(document.querySelectorAll("#items .item"));
  if (!els.length) return;
  const cur = els.findIndex((el) => el.dataset.id === state.focusId);
  const next = cur === -1 ? (delta > 0 ? 0 : els.length - 1)
    : Math.min(els.length - 1, Math.max(0, cur + delta));
  setFocus(els[next].dataset.id);
  els[next].scrollIntoView({ block: "center" });
}

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Escape") {
    const open = document.querySelector("#items .item .unify-row:not([hidden])");
    if (open) { open.closest(".item").__closeUnify?.(); return; }
    closeCode();
    return;
  }
  if (e.key === "j") { e.preventDefault(); moveFocus(1); }
  else if (e.key === "k") { e.preventDefault(); moveFocus(-1); }
  else if (e.key === "e") {
    const el = document.querySelector("#items .item.focused") || document.querySelector("#items .item");
    // Evidence rows the prose already cites are suppressed, so "e" has to be willing
    // to open the first inline prose locator too.
    el?.querySelector(".prose .loc-link, .ev")?.click();
  }
});

/* ---------- boot ---------- */
$("#code-close").addEventListener("click", closeCode);
window.addEventListener("beforeunload", (e) => {
  if (Object.keys(state.drafts).some((k) => state.drafts[k].trim())) { e.preventDefault(); e.returnValue = ""; }
});

// Config first: the locator patterns and the sidebar subtitle both depend on it,
// and a spec painted with the wrong scheme would show unclickable citations.
(async () => {
  try {
    const cfg = await api("/api/config");
    state.config = { ...state.config, ...cfg };
  } catch { /* fall back to defaults */ }
  buildLocatorPatterns(state.config.locatorScheme || "repo");
  const sub = $("#project-name");
  if (sub) {
    sub.textContent = state.config.projectName || "";
    sub.hidden = !state.config.projectName;
  }
  await loadSpecs();
})().catch((e) => {
  $("#spec-header").innerHTML = `<div class="parse-errors">could not load specs: ${esc(e.message)}</div>`;
});


/* ---------- global search: command-palette modal (⌘K / "/") ---------- */
const searchModal = $("#search-modal");
const searchInput = $("#search-input");
const searchResults = $("#search-results");
let searchTimer = null, searchSeq = 0;

function openSearch() {
  searchModal.hidden = false;
  searchInput.focus();
  searchInput.select();
  if (searchInput.value.trim().length >= 2) runSearch();
}
function closeSearch() {
  searchModal.hidden = true;
  searchInput.blur();
}

async function jumpToItem(slug, id) {
  closeSearch();
  if (state.slug !== slug) await selectSpec(slug);
  // The target may be hidden by the current filters — widen to All so the jump
  // always lands, then flash the card so the eye finds it.
  state.status = "all"; state.kind = "all";
  renderFilters(); renderItems();
  const el = document.querySelector(`#items .item[data-id="${CSS.escape(id)}"]`);
  if (el) {
    el.scrollIntoView({ block: "start" });
    setFocus(id);
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1800);
  }
}

async function runSearch() {
  const q = searchInput.value.trim();
  if (q.length < 2) { searchResults.innerHTML = `<div class="sr-empty">type to search all specs</div>`; return; }
  const seq = ++searchSeq;
  const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
  if (seq !== searchSeq || !data) return;
  const rs = data.results || [];
  searchResults.innerHTML = rs.length ? rs.map((r) => `
    <button class="sr" data-slug="${r.slug}" data-id="${r.id}" type="button">
      <div class="sr-top"><span class="sr-id">${esc(r.id)}</span><span class="sr-title">${esc(r.title)}</span>
      <span class="sr-meta">${esc(r.slug)} · ${esc(r.decision ? (VERDICT_LABEL[r.decision] || r.decision) : r.status)}</span></div>
      <span class="sr-snip">${esc(r.snippet)}</span>
    </button>`).join("") : `<div class="sr-empty">no matches</div>`;
  for (const b of searchResults.querySelectorAll(".sr"))
    b.addEventListener("click", () => jumpToItem(b.dataset.slug, b.dataset.id));
}

if (searchModal) {
  $("#search-trigger").addEventListener("click", openSearch);
  searchModal.querySelector(".sm-backdrop").addEventListener("click", closeSearch);
  searchInput.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 180); });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
    else if (e.key === "Enter") { const first = searchResults.querySelector(".sr"); if (first) first.click(); }
  });
  document.addEventListener("keydown", (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "");
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openSearch(); }
    else if (e.key === "/" && !typing && searchModal.hidden) { e.preventDefault(); openSearch(); }
  });
}
