/* Spec mode — thin human editor over the machine-readable specs.
   Mounted by shell.js at #/spec/<set>/<slug>; shared helpers live in common.js. */
// Scoped: each mode file runs in its own function so top-level names (both
// modes have a renderItems) can never collide; only the mode object is global.
(() => {
"use strict";

const state = {
  set: null,   // spec-set id (several specs directories can be served at once)
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
  // The set's decision-mill.yaml as the server reads it (decisions, instructions,
  // locator schemes). Absent file = the default buttons, so nothing changes.
  cfg: null,
  cfgs: Object.create(null), // setId -> cfg, for labels in search results
  instrOpen: false,
  // The locator scheme is a per-project knob (see FORMAT.md) read from
  // App.config at boot, so nothing in this file may hardcode it.
  get config() { return App.config; },
};

const KIND_LABEL = { divergence: "DIV", invariant: "INV", "failure-case": "FC", unknown: "UNK", feature: "FEAT", decision: "DEC", general: "GEN" };

// The buttons when a set declares none (mirrors lib/specset.js DEFAULT_DECISIONS).
const DEFAULT_DECISIONS = [
  { id: "keep", label: "Keep", key: "1", tone: "positive", hint: "good as-is; the recommendation stays on record", kinds: null },
  { id: "change", label: "Change", key: "2", tone: "negative", hint: "needs adjustment per the recorded recommendation (never delete by itself)", kinds: null },
  { id: "defer", label: "Defer", key: "3", tone: "neutral", hint: "not now; the item stays open", kinds: null },
  { id: "unify", label: "Unify on…", key: null, tone: "unify", hint: "the rewrite adopts one target's behavior on every surface", kinds: ["divergence"] },
];
const decisions = () => (state.cfg && state.cfg.decisions) || DEFAULT_DECISIONS;
const TONE_BTN = { positive: "b-keep", negative: "b-toss", neutral: "ghost", unify: "b-unify" };
const TONE_CLS = { positive: "keep", negative: "toss", neutral: "defer", unify: "unify" };
// Does decision `d` apply to item `it`? Unify only ever applies to divergences.
function appliesTo(d, it) {
  const isDiv = it.kind === "divergence" || /^DIV-/.test(it.id);
  if (d.id === "unify" && !isDiv) return false;
  if (!d.kinds) return true;
  return d.kinds.includes(it.kind) || (isDiv && d.kinds.includes("divergence"));
}
const DECIDABLE = (it) => it.kind !== "general";

// Single-reviewer tool: the identity picker was noise. Notes written by agents
// (e.g. metrics-agent) still carry their own `by` in the spec files. The server
// resolves the reviewer (REVIEWER env, else the Tailscale login header).
function who() { return App.config.reviewer || "reviewer"; }
const setQ = () => `set=${encodeURIComponent(state.set || "")}`;

/* ---------- sidebar ---------- */
// One spec row (name, segmented meter, stats). The shell renders every set's rows
// with this; spec mode re-renders its own set after each write.
function specRowEl(setId, s) {
  {
    // GEN items have no decide affordance — exclude them from the denominator,
    // otherwise no spec can ever read 100%.
    const denom = s.counts.decidable || s.counts.total || 1;
    const btn = document.createElement("a");
    btn.className = "spec-row" + (App.mode === "spec" && setId === state.set && s.slug === state.slug ? " active" : "");
    btn.href = `#/spec/${encodeURIComponent(setId)}/${encodeURIComponent(s.slug)}`;
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
      <div class="stats">${c.decided}/${denom} decided · ${done}%${openN ? ` · <b class="open-count">${openN} open</b>` : " · clear"}${c.needsMetrics ? ` · ${c.needsMetrics} metrics` : ""}${(s.parseErrors || []).length ? " · PARSE ERR" : ""}</div>`;
    return btn;
  }
}

async function loadSpecs() {
  const data = await api(`api/specs?${setQ()}`);
  state.specs = data.specs;
  const cfgChanged = JSON.stringify(data.config || null) !== JSON.stringify(state.cfg) || state.cfgSet !== state.set;
  state.cfgSet = state.set;
  state.cfg = data.config || null;
  state.cfgs[state.set] = state.cfg;
  if (cfgChanged) {
    buildLocatorPatterns((state.cfg && state.cfg.locatorSchemes) || App.config.locatorSchemes || [App.config.locatorScheme || "repo"]);
    renderInstructions();
    buildSpecHelp();
  }
  const nav = document.querySelector(`.spec-list[data-set="${CSS.escape(state.set)}"]`);
  if (nav) {
    nav.innerHTML = "";
    for (const s of state.specs) nav.appendChild(specRowEl(state.set, s));
  }
  renderBucketTotals();
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

/* ---------- set instructions ----------
   decision-mill.yaml `instructions` (markdown) plus a legend of the set's verdict
   buttons. Opens on the first visit to a set only; `i` toggles it after that. */
function renderInstructions() {
  const d = $("#spec-instr");
  if (!d) return;
  const cfg = state.cfg || {};
  const custom = Boolean(cfg.customDecisions);
  if (!cfg.instructions && !custom) { d.hidden = true; d.innerHTML = ""; state.instrOpen = false; return; }
  const seen = store.get(`specinstr:${state.set}`, null);
  state.instrOpen = seen === null ? true : Boolean(seen);
  if (seen === null) store.set(`specinstr:${state.set}`, false);
  const legend = decisions().map((x) => `<tr><td>${x.key ? `<kbd>${esc(x.key)}</kbd>` : ""}</td><td><span class="vtag v-${TONE_CLS[x.tone] || "defer"}">${esc(x.label)}</span></td>
    <td>${esc(x.hint || "")}${x.requires_detail ? ` <em class="req">— needs a detail in the box first</em>` : ""}${x.kinds ? ` <span class="muted">(${esc(x.kinds.join(", "))} only)</span>` : ""}</td></tr>`).join("");
  d.hidden = false;
  d.open = state.instrOpen;
  d.innerHTML = `<summary>Instructions<span class="hint"> — i to show or hide</span></summary>
    ${cfg.instructions ? `<div class="prose">${md(cfg.instructions)}</div>` : ""}
    <table class="verdict-legend" aria-label="Verdicts">${legend}</table>`;
  d.ontoggle = () => {
    if (d.open === state.instrOpen) return;
    state.instrOpen = d.open;
    store.set(`specinstr:${state.set}`, d.open);
    syncInstrButton();
  };
  syncInstrButton();
}
function setInstructions(open) {
  const d = $("#spec-instr");
  if (!d || d.hidden) return false;
  state.instrOpen = open; d.open = open;
  store.set(`specinstr:${state.set}`, open);
  syncInstrButton();
  if (open) $("#main").scrollTo({ top: 0 });
  return true;
}
function syncInstrButton() {
  const b = $("#spec-instr-btn");
  if (b) b.classList.toggle("on", state.instrOpen);
}

// With many spec files in a set, finishing one should point at the next one that
// still has open items instead of leaving the reviewer to scan the sidebar.
function nextOpenSpec() {
  const i = state.specs.findIndex((s) => s.slug === state.slug);
  const order = [...state.specs.slice(i + 1), ...state.specs.slice(0, Math.max(0, i))];
  return order.find((s) => s.counts.open > 0) || null;
}

let selectToken = 0;
async function selectSpec(slug) {
  const tok = ++selectToken;
  state.slug = slug;
  state.focusId = null;
  const data = await api(`api/spec/${encodeURIComponent(slug)}?${setQ()}`);
  if (tok !== selectToken) return; // a later click won; don't paint stale data
  state.items = data.items;
  state.parseErrors = data.parseErrors || [];
  state.warnings = data.warnings || [];
  const fm = data.frontmatter || {};
  const list = (cls, label, arr) => arr.length
    ? `<div class="${cls}">${esc(label)}${arr.map((e) => `<div>· ${esc(e)}</div>`).join("")}</div>` : "";
  const cfg = state.cfg || {};
  const pos = state.specs.findIndex((s) => s.slug === slug);
  $("#spec-header").innerHTML = `
    <h2>${esc(fm.title || slug)}</h2>
    <div class="meta">${esc(slug)}.md${state.specs.length > 1 && pos !== -1 ? ` · spec ${pos + 1} of ${state.specs.length}` : ""} · baseline ${esc(String(fm.baseline || "").slice(0, 10))} · status ${esc(fm.status || "?")}
      ${cfg.instructions || cfg.customDecisions ? `<button id="spec-instr-btn" class="rb-btn${state.instrOpen ? " on" : ""}" type="button" title="Instructions (i)">Instructions <kbd>i</kbd></button>` : ""}</div>
    ${list("parse-errors", "decision-mill.yaml errors:", cfg.errors || [])}
    ${list("spec-warnings", "decision-mill.yaml warnings:", cfg.warnings || [])}
    ${list("parse-errors", "parse errors:", state.parseErrors)}
    ${list("spec-warnings", "format warnings:", state.warnings)}`;
  const ib = $("#spec-instr-btn");
  if (ib) ib.onclick = () => setInstructions(!state.instrOpen);
  renderFilters();
  renderItems();
  loadSpecs();
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
  ["failure-case", "Failure cases"], ["unknown", "Unknowns"], ["feature", "Features"], ["decision", "Decisions"],
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
  // Only offer kinds this spec has (plus the current one), so a decision register
  // is not a list of empty filters.
  const present = new Set(state.items.map((it) => it.kind));
  for (const [key, label] of KIND_FILTERS) {
    if (key !== "all" && key !== state.kind && !present.has(key)) continue;
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
  const open = decidable.filter((i) => (i.meta.status || "open") === "open" && i.meta.decision !== "defer").length;
  const next = open ? null : nextOpenSpec();
  const el = $("#progress");
  el.innerHTML = `${decided}/${decidable.length} decided`
    + (metrics ? ` · <a href="#" class="metrics-link${state.status === "needs-metrics" ? " on" : ""}">${metrics} needs metrics</a>` : "")
    + (next ? ` · <a class="next-spec" href="#/spec/${encodeURIComponent(state.set)}/${encodeURIComponent(next.slug)}" title="next spec with open items">next: ${esc(next.title)} (${next.counts.open} open) →</a>` : "");
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

// Stored ids now match the buttons: Keep = good as-is (with recommendation),
// Change = needs adjustment per the recorded recommendation. `toss` and `accept`
// are legacy stored values the UI no longer writes — they read as Change/Keep.
const VERDICT_LABEL = { toss: "CHANGE", accept: "KEEP" };
const VERDICT_CLASS = { accept: "keep", change: "toss" }; // change reuses toss's palette

// A declared decision (decision-mill.yaml) wins over the legacy readings, so a set
// that declares `accept` shows "ACCEPT", not "KEEP".
const declaredDef = (d, cfg = state.cfg) => (cfg && cfg.customDecisions ? cfg.decisions.find((x) => x.id === d && x.id !== "unify") : null);
function verdictLabel(d, cfg = state.cfg) {
  const def = declaredDef(d, cfg);
  return def ? def.label.toUpperCase() : VERDICT_LABEL[d] || String(d).toUpperCase();
}

function verdictCls(decision) {
  const def = declaredDef(String(decision));
  if (def) return TONE_CLS[def.tone] || "defer";
  const base = String(decision).split("-")[0];
  const known = ["keep", "change", "toss", "unify", "accept", "reject", "defer", "file"].includes(base) ? base : "defer";
  return VERDICT_CLASS[known] || known;
}

// Compact badge: verdict + date only. The rationale is NOT shown here — all
// reviewer-written text renders in one place, the notes timeline above the
// textarea, so it never appears in two different positions depending on state.
function stampHtml(meta) {
  if (!meta.decision) return "";
  const decision = String(meta.decision);
  const label = verdictLabel(decision);
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

let LOC_SCHEMES = ["repo"];

// One or several schemes (LOCATOR_ROOTS / decision-mill.yaml locator_roots). The
// lookbehind keeps "myrepo:x" from matching scheme "repo". Mirrors
// lib/parser.js proseLocators, which `validate.js --locators` checks.
function buildLocatorPatterns(schemes) {
  LOC_SCHEMES = (Array.isArray(schemes) ? schemes : [schemes]).filter(Boolean);
  if (!LOC_SCHEMES.length) LOC_SCHEMES = ["repo"];
  const q = LOC_SCHEMES.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  LOC_RE = new RegExp(`(?<![A-Za-z0-9_.+-])(?:${q}):(?:[A-Za-z0-9._~@+]|[-/][ \\t]*\\n?[ \\t]*)+(?::\\d+(?:-\\d+)?(?:,\\d+(?:-\\d+)?)*)?`, "g");
  LOC_TOKEN_RE = new RegExp(`^((?:${q}):[^\\s]*?)(?::(\\d+(?:-\\d+)?(?:,\\d+(?:-\\d+)?)*))?$`);
}
buildLocatorPatterns("repo");

// Split a raw prose token into {locator, lines}. Returns null for anything the code
// panel could not open anyway (elided `<prefix>:.../x.ts` paths, bare `<prefix>:`).
function parseLocatorToken(raw) {
  const flat = raw.replace(/\s+/g, "").replace(/[.,;:!?)\]}'"]+$/, "");
  const m = flat.match(LOC_TOKEN_RE);
  if (!m) return null;
  const locator = m[1];
  const rel = locator.slice(locator.indexOf(":") + 1);
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
    if (LOC_SCHEMES.some((sc) => n.nodeValue.includes(`${sc}:`))) texts.push(n);
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
      body = `<span class="vtag v-${verdictCls(m[1])}">${esc(verdictLabel(m[1]))}</span>${m[2] ? esc(m[2]) : ""}`;
    } else if (r) {
      body = `<span class="vtag v-rec">REC · ${esc(verdictLabel(r[1]))}</span>${r[2] ? esc(r[2]) : ""}`;
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
  // The set's verdict buttons, in declared order. Only divergences can be unified —
  // there is nothing to converge on for an invariant, a failure case or an unknown.
  const verdictButtons = decisions().filter((d) => appliesTo(d, it)).map((d) =>
    `<button class="btn ${TONE_BTN[d.tone] || "ghost"}" data-d="${esc(d.id)}" type="button"${d.hint || d.key ? ` title="${esc([d.hint, d.key ? `key ${d.key}` : ""].filter(Boolean).join(" — "))}"` : ""}>${esc(d.label)}${d.key ? `<kbd>${esc(d.key)}</kbd>` : ""}</button>`);
  el.innerHTML = `
    <div class="body">
      <div class="item-head">
        <span class="item-id">${esc(it.id)}</span>
        <span class="item-title">${esc(it.title)}</span>
        <span class="chips">
          <span class="chip">${esc(KIND_LABEL[it.kind] || it.kind || "?")}</span>
          ${meta.proposed && meta.proposed !== "n/a" ? `<span class="chip ${meta.proposed === "toss" || meta.proposed === "change" ? "proposed-toss" : ""}">→ ${esc(meta.proposed === "toss" ? "change" : meta.proposed)}</span>` : ""}
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
        ${verdictButtons.filter((b) => !/data-d="unify"/.test(b)).join("\n        ")}
        <button class="btn ghost b-team" data-team type="button" aria-pressed="${(meta.status || "open") === "team"}"
          title="park for the live team walkthrough — not a verdict">${(meta.status || "open") === "team" ? "✓ Team" : "Team"}</button>
        ${verdictButtons.filter((b) => /data-d="unify"/.test(b)).join("")}
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
    // "Change" (stored: change) never means delete. Auto-prefix the reviewer's detail
    // with the FORMAT.md disambiguator so agents can't misread it: features cut via
    // this button are removals; everything else is a redesign instruction.
    if ((decision === "change" || decision === "toss") && detail && !/^(remove|change|resolved|moot):/.test(detail)) {
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
      // requires_detail (decision-mill.yaml): the detail is the actionable part, so
      // a click with an empty box asks for it instead of writing a bare verdict.
      const def = declaredDef(btn.dataset.d);
      if (def && def.requires_detail && !ta.value.trim()) {
        showHint(`${def.label} needs a detail — type what should happen in the box below, then click ${def.label} again.`);
        ta.focus();
        return;
      }
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
    const res = await postJSON(`api/spec/${encodeURIComponent(state.slug)}/item/${encodeURIComponent(id)}?${setQ()}`, body);
    const i = state.items.findIndex((it) => it.id === id);
    if (i !== -1) state.items[i] = res.item;
    patchItem(id);
    renderProgress();
    loadSpecs();
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
    // set= lets the server resolve this set's own locator roots.
    const params = new URLSearchParams({ locator: ev.locator, set: state.set || "" });
    if (ev.lines != null) params.set("lines", String(ev.lines));
    if (all) params.set("all", "1");
    data = await api(`api/code?${params}`);
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

// The shared keyboard model, spec flavour: j/k move, number keys are the verdict
// buttons of the focused item (1 Keep, 2 Change, 3 Defer), u undoes its decision,
// e opens its first citation. The shell owns ⌘K, / and ?.
// Built from the set's decisions so the help matches the buttons.
function buildSpecHelp() {
  const keyed = decisions().filter((d) => d.key);
  App.help.spec = [
    ["j / k", "next / previous item"],
    [keyed.map((d) => d.key).join(" · "), `${keyed.map((d) => d.label.replace(/…$/, "")).join(" · ")} the focused item (textarea text rides along)`],
    ["u", "undo the focused item's decision"],
    ["e", "open the focused item's first citation"],
    ...(state.cfg && (state.cfg.instructions || state.cfg.customDecisions) ? [["i", "show or hide the instructions and verdict legend"]] : []),
    ["Esc", "close the unify input or the code panel; leave a text box"],
    ["⌘/Ctrl+Enter", "add the textarea's note without deciding"],
  ];
}
buildSpecHelp();
App.keyHandlers.spec = (e) => {
  if (e.key === "Escape") {
    const open = document.querySelector("#items .item .unify-row:not([hidden])");
    if (open) { open.closest(".item").__closeUnify?.(); return true; }
    closeCode();
    return true;
  }
  const focused = document.querySelector("#items .item.focused");
  if (e.key === "j") { moveFocus(1); return true; }
  if (e.key === "k") { moveFocus(-1); return true; }
  if (e.key === "e") {
    const el = focused || document.querySelector("#items .item");
    // Evidence rows the prose already cites are suppressed, so "e" has to be willing
    // to open the first inline prose locator too.
    el?.querySelector(".prose .loc-link, .ev")?.click();
    return true;
  }
  if (e.key === "i" && setInstructions(!state.instrOpen)) return true;
  const verdict = decisions().find((d) => d.key && d.key === e.key.toLowerCase());
  if (verdict && focused) {
    const btn = focused.querySelector(`[data-d="${CSS.escape(verdict.id)}"]`);
    if (btn) btn.click(); else toast(`${verdict.label} does not apply to this item`);
    return true;
  }
  if (e.key === "u" && focused) {
    const und = focused.querySelector("[data-undecide]");
    if (und) und.click(); else toast("Nothing to undo on this item");
    return true;
  }
  return false;
};

/* ---------- mount ---------- */
$("#code-close").addEventListener("click", closeCode);
window.addEventListener("beforeunload", (e) => {
  if (Object.keys(state.drafts).some((k) => state.drafts[k].trim())) { e.preventDefault(); e.returnValue = ""; }
});

const Spec = {
  // Called by the shell's router for #/spec/<set>[/<slug>].
  async open(setId, slug) {
    const changedSet = state.set !== setId;
    state.set = setId;
    if (changedSet || !state.specs.length) {
      state.slug = null;
      await loadSpecs();
    }
    // Land on the first spec that still has open items, not on a finished one.
    const target = slug || state.slug || (state.specs.find((s) => s.counts.open > 0) || state.specs[0])?.slug;
    if (!target) {
      $("#spec-header").innerHTML = `<div class="empty">No specs in this set.</div>`;
      $("#items").innerHTML = ""; $("#filters").innerHTML = ""; $("#progress").innerHTML = "";
      return;
    }
    if (target !== state.slug || changedSet) await selectSpec(target);
    else loadSpecs();
  },
  close() { closeCode(); },
  // Search jump: the target may be hidden by the current filters — widen to All so
  // the jump always lands, then flash the card so the eye finds it.
  async jumpTo(setId, slug, id) {
    location.hash = `#/spec/${encodeURIComponent(setId)}/${encodeURIComponent(slug)}`;
    await Spec.open(setId, slug);
    state.status = "all"; state.kind = "all";
    renderFilters(); renderItems();
    const el = document.querySelector(`#items .item[data-id="${CSS.escape(id)}"]`);
    if (el) {
      el.scrollIntoView({ block: "start" });
      setFocus(id);
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1800);
    }
  },
  verdictLabel(d, setId) { return verdictLabel(d, (setId && state.cfgs[setId]) || state.cfg).toLowerCase(); },
  rowEl: specRowEl,
  buildLocatorPatterns,
};

window.Spec = Spec;
})();
