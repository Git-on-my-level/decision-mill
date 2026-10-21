/* decision-mill shell — one UI for both modes: sidebar navigation, home screen,
   hash router, ⌘K search, ? help, theme, and the global keyboard dispatcher.
   Routes (hash-based, so any reverse-proxy mount works):
     #/                                  home: the inbox, every spec set and label task
     #/w/<workspace>/                    home filtered to one workspace
     [#/w/<workspace>]/spec/<set>[/<slug>]               spec mode
     [#/w/<workspace>]/task/<id>[/item/<item>|/items|/results]   label mode
   The /w/<workspace> prefix is optional on the way in (old links keep working)
   and added on the way out. */
"use strict";

const Shell = {
  home: null,
  showInactive: store.get("showInactive", false),

  // In the current workspace filter (null = every workspace)?
  inWs(x) { return !App.wsFilter || x.workspace === App.wsFilter; },
  isActive(x) { return (x.status || "active") === "active"; },

  async refreshNav() {
    let data;
    try { data = await api("api/home"); } catch (e) { $("#nav").innerHTML = `<div class="nav-err">${esc(e.message)}</div>`; return; }
    Shell.home = data;
    App.config.reviewer = data.reviewer || App.config.reviewer;
    for (const t of data.tasks) App.wsOf.task[t.id] = t.workspace;
    for (const s of data.specSets) App.wsOf.set[s.id] = s.workspace;
    if (App.wsFilter && !(data.workspaces || []).some((w) => w.id === App.wsFilter)) App.wsFilter = null;
    $("#whoami").textContent = App.config.reviewer;
    Shell.renderSwitch();
    const nav = $("#nav");
    nav.innerHTML = "";
    nav.append(el("a", { class: `nav-home${App.mode === "home" ? " active" : ""}`, href: `${App.wsPrefix(App.wsFilter)}/` }, "Home"));
    const sets = data.specSets.filter((x) => Shell.inWs(x));
    const tasks = data.tasks.filter((x) => Shell.inWs(x));
    const shownSets = sets.filter((x) => Shell.showInactive || Shell.isActive(x));
    const shownTasks = tasks.filter((x) => Shell.showInactive || Shell.isActive(x));
    for (const set of shownSets) {
      const group = el("div", { class: "nav-group" },
        el("div", { class: "nav-head" }, el("span", {}, "Specs"), el("small", { title: set.dir }, set.name), Shell.isActive(set) ? null : el("span", { class: `hc-tag st-${set.status}` }, set.status)));
      const list = el("div", { class: "spec-list", "data-set": set.id });
      for (const sp of set.specs) list.append(Spec.rowEl(set.id, sp));
      group.append(list);
      nav.append(group);
    }
    if (shownTasks.length) {
      const group = el("div", { class: "nav-group" }, el("div", { class: "nav-head" }, el("span", {}, "Labeling")));
      for (const t of shownTasks) group.append(taskRowEl(t));
      nav.append(group);
    }
    const hidden = sets.length + tasks.length - shownSets.length - shownTasks.length;
    if (hidden || Shell.showInactive) {
      nav.append(el("button", { type: "button", class: "nav-more", onclick: () => { Shell.showInactive = !Shell.showInactive; store.set("showInactive", Shell.showInactive); Shell.refreshNav(); if (App.mode === "home") Shell.renderHome(); } },
        Shell.showInactive ? "Hide paused, done and archived" : `Show ${hidden} paused, done or archived`));
    }
    if (!data.specSets.length && !data.tasks.length) nav.append(el("div", { class: "nav-err" }, "Nothing configured — see the README."));
  },

  // Workspace switcher: shown once there is more than one workspace (or a hub
  // names any).
  renderSwitch() {
    const box = $("#ws-switch");
    const ws = (Shell.home && Shell.home.workspaces) || [];
    box.hidden = ws.length < 2 && !(Shell.home && Shell.home.hub && ws.length);
    if (box.hidden) { box.replaceChildren(); return; }
    const sel = el("select", { class: "ws-select", "aria-label": "Workspace" },
      el("option", { value: "" }, "All workspaces"),
      ws.map((w) => el("option", { value: w.id, selected: App.wsFilter === w.id }, `${w.title || w.id}${w.waiting ? ` · ${w.waiting} waiting` : ""}`)));
    sel.addEventListener("change", () => { location.hash = `${App.wsPrefix(sel.value || null)}/`; sel.blur(); });
    box.replaceChildren(sel);
  },

  renderHome() {
    const d = Shell.home || { specSets: [], tasks: [], workspaces: [] };
    const v = $("#home-view");
    v.innerHTML = "";
    const wsMeta = (d.workspaces || []).find((w) => w.id === App.wsFilter);
    const wsLine = wsMeta ? [wsMeta.title || wsMeta.id, wsMeta.project, wsMeta.owner ? `owner ${wsMeta.owner}` : null].filter(Boolean).join(" · ") : null;
    v.append(el("header", { class: "home-head" },
      el("h2", {}, "What needs a human today"),
      el("p", {}, wsLine ? `Workspace: ${wsLine}.` : "Spec mode decides open product questions in markdown specs. Label mode collects your judgments on items, blind, in rounds, and checks models against them.")));
    const tasks = d.tasks.filter((t) => Shell.inWs(t));
    const sets = d.specSets.filter((s) => Shell.inWs(s));

    // The inbox: every active task and set with something waiting on you.
    const ago = (iso) => { if (!iso) return "—"; const m = (Date.now() - Date.parse(iso)) / 60000; return m < 90 ? `${Math.max(1, Math.round(m))} min ago` : m < 36 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
    const wsTag = (x) => (!App.wsFilter && (d.workspaces || []).length > 1 ? el("span", { class: "hc-tag ws" }, ((d.workspaces || []).find((w) => w.id === x.workspace) || {}).title || x.workspace) : null);
    const waiting = tasks.filter((t) => Shell.isActive(t) && t.waitingOn === "human")
      .sort((a, b) => Number(Boolean(a.enough?.met)) - Number(Boolean(b.enough?.met)) || a.minutes - b.minutes);
    const openSets = sets.filter((s) => Shell.isActive(s) && s.counts.open > 0);
    const inbox = el("section", { class: "inbox" }, el("h3", { class: "sec" }, `Waiting on you · ${waiting.length + openSets.length}`));
    if (!waiting.length && !openSets.length) inbox.append(el("p", { class: "muted" }, "Nothing is waiting on you."));
    const rows = el("div", { class: "inbox-rows" });
    for (const t of waiting) {
      const unit = t.waves ? "wave" : "round";
      rows.append(el("a", { class: `inbox-row${t.enough?.met ? " met" : ""}`, href: App.taskHref(t.id) },
        el("div", { class: "ib-main" }, el("strong", {}, t.title), wsTag(t), t.stale ? el("span", { class: "hc-tag stale" }, "stale") : null,
          t.decision ? el("div", { class: "ib-dec muted" }, t.decision) : null),
        el("div", { class: "ib-left" }, el("b", {}, `${t.remaining} card${t.remaining === 1 ? "" : "s"}`), ` left in ${unit} ${t.rounds.current}`,
          el("span", { class: "muted" }, ` · ~${t.minutes} min${t.minutes_per_round ? "" : " (est.)"}`),
          t.unlabeled > t.remaining ? el("div", { class: "muted" }, `${t.unlabeled} unlabeled in all · ~${t.minutesAll} min`) : null),
        el("div", { class: "ib-age muted" }, `created ${ago(t.created)}`, el("br"), `touched ${ago(t.lastActivity)}`),
        t.enough ? el("div", { class: `ib-enough${t.enough.met ? " met" : ""}` }, t.enough.met ? "Enough — you can stop" : t.enough.text) : null));
    }
    for (const s of openSets) {
      rows.append(el("a", { class: "inbox-row", href: App.specHref(s.id) },
        el("div", { class: "ib-main" }, el("strong", {}, s.name), wsTag(s), el("div", { class: "ib-dec muted" }, s.decision || "Spec set")),
        el("div", { class: "ib-left" }, el("b", {}, `${s.counts.open} open`), ` of ${s.counts.decidable}`),
        el("div", { class: "ib-age muted" }, `touched ${ago(s.lastActivity)}`), null));
    }
    if (rows.childNodes.length) inbox.append(rows);
    const elsewhere = tasks.filter((t) => Shell.isActive(t) && (t.waitingOn === "agent" || t.waitingOn === "items"));
    if (elsewhere.length) inbox.append(el("p", { class: "muted ib-else" }, "Waiting on an agent: ",
      elsewhere.map((t, i) => [i ? " · " : "", el("a", { href: App.taskHref(t.id) }, t.title), t.waitingOn === "items" ? " (items)" : ` (wave ${t.waves ? t.waves.frozen + 1 : ""})`])));
    v.append(inbox);

    const grid = el("div", { class: "home-grid" });
    const shownTasks = tasks.filter((t) => Shell.showInactive || Shell.isActive(t));
    for (const t of shownTasks) {
      const pctDone = t.items ? t.labeled / t.items : 0;
      grid.append(el("div", { class: `home-card${Shell.isActive(t) ? "" : " inactive"}` },
        el("a", { class: "hc-link", href: App.taskHref(t.id) },
        el("div", { class: "hc-kind" }, "Label task", t.blind ? el("span", { class: "hc-tag" }, "blind") : null,
          Shell.isActive(t) ? null : el("span", { class: `hc-tag st-${t.status}` }, t.status), t.stale ? el("span", { class: "hc-tag stale" }, "stale") : null, wsTag(t)),
        el("h3", {}, t.title),
        t.question ? el("p", { class: "hc-q" }, t.question) : null,
        el("div", { class: "meter wide" }, el("i", { class: "m-decided", style: `width:${(pctDone * 100).toFixed(1)}%` })),
        el("div", { class: "hc-stats" }, t.empty ? "waiting for items" : `${t.labeled} of ${t.items} labeled · `,
          t.empty ? "" : t.waves ? (t.waves.state === "inferring" ? `waiting for wave ${t.waves.frozen + 1} of ${t.waves.count}` : t.rounds.current ? `wave ${t.rounds.current} of ${t.rounds.total}` : "all waves done")
            : t.rounds.current ? `round ${t.rounds.current} of ${t.rounds.total} next` : "all rounds done",
          t.comments ? ` · ${t.comments} comment${t.comments === 1 ? "" : "s"}` : "",
          t.standinReviewers ? ` · ${t.standinReviewers} stand-in` : "",
          t.errors ? el("b", { class: "err" }, ` · ${t.errors} error(s)`) : "")),
        t.archived ? el("button", { type: "button", class: "btn sm hc-act", onclick: () => Shell.move(t, "restore") }, "Restore") : null));
    }
    for (const set of sets.filter((x) => Shell.showInactive || Shell.isActive(x))) {
      const c = set.counts;
      // A set can hold dozens of spec files: name the ones still waiting (most open
      // first) instead of one long run-on line of every title.
      const waitingSpecs = set.specs.filter((sp) => sp.counts.open > 0).sort((a, b) => b.counts.open - a.counts.open);
      const shown = waitingSpecs.slice(0, 4);
      grid.append(el("a", { class: `home-card${Shell.isActive(set) ? "" : " inactive"}`, href: App.specHref(set.id) },
        el("div", { class: "hc-kind" }, "Spec set", el("span", { class: "hc-tag" }, `${set.specs.length} spec${set.specs.length === 1 ? "" : "s"}`),
          set.instructions ? el("span", { class: "hc-tag" }, "instructions") : null,
          Shell.isActive(set) ? null : el("span", { class: `hc-tag st-${set.status}` }, set.status), wsTag(set),
          set.configErrors ? el("b", { class: "err" }, " config error") : null),
        el("h3", {}, set.name),
        el("p", { class: "hc-q" }, !set.specs.length ? "no specs"
          : !waitingSpecs.length ? "nothing open"
          : [shown.map((sp) => `${sp.title} (${sp.counts.open})`).join(" · "), waitingSpecs.length > shown.length ? ` · +${waitingSpecs.length - shown.length} more with open items` : ""].join("")),
        el("div", { class: "meter wide" }, el("i", { class: "m-decided", style: `width:${c.decidable ? (100 * c.decided / c.decidable).toFixed(1) : 0}%` })),
        el("div", { class: "hc-stats" }, `${c.decided} of ${c.decidable} decided · ${c.open} open`,
          c.deferred ? ` · ${c.deferred} deferred` : "", c.team ? ` · ${c.team} team` : "", c.needsMetrics ? ` · ${c.needsMetrics} needs metrics` : "")));
    }
    if (!grid.childNodes.length) grid.append(el("div", { class: "empty" }, "No spec sets or label tasks found yet. A label task appears here as soon as its directory (task.yaml + items.jsonl) lands under a labels root — reload to check."));
    v.append(el("h3", { class: "sec" }, Shell.showInactive ? "Everything" : "Active"), grid);
    const inactive = tasks.length + sets.length - tasks.filter((t) => Shell.isActive(t)).length - sets.filter((x) => Shell.isActive(x)).length;
    if (inactive || Shell.showInactive) v.append(el("button", { type: "button", class: "btn ghost", onclick: () => { Shell.showInactive = !Shell.showInactive; store.set("showInactive", Shell.showInactive); Shell.refreshNav(); Shell.renderHome(); } },
      Shell.showInactive ? "Hide paused, done and archived" : `Show inactive (${inactive} paused, done or archived)`));
    v.append(el("p", { class: "home-foot" }, "Press ", el("kbd", {}, "?"), " for shortcuts, ", el("kbd", {}, "⌘K"), " to search everything."));
  },

  async move(t, what) {
    try { await postJSON(`api/task/${encodeURIComponent(t.id)}/${what}`, {}); toast(what === "restore" ? `Restored ${t.title}` : `Archived ${t.title}`); }
    catch (e) { toast(`${what} failed: ${e.message}`, "err"); }
    await Shell.refreshNav();
    if (App.mode === "home") Shell.renderHome();
  },
};

function taskRowEl(t) {
  const denom = t.items || 1;
  return el("a", { class: `spec-row task-row${App.mode === "label" && typeof L !== "undefined" && L.taskId === t.id ? " active" : ""}${Shell.isActive(t) ? "" : " inactive"}`, href: App.taskHref(t.id), "data-task": t.id },
    el("div", { class: "name" }, t.title, t.stale ? el("span", { class: "hc-tag stale" }, "stale") : null, Shell.isActive(t) ? null : el("span", { class: `hc-tag st-${t.status}` }, t.status)),
    el("div", { class: "meter", role: "img", "aria-label": `${t.labeled} of ${t.items} labeled` },
      el("i", { class: "m-decided", style: `width:${(100 * t.labeled / denom).toFixed(1)}%` })),
    el("div", { class: "stats" }, t.empty ? "waiting for items" : `${t.labeled}/${t.items} labeled`,
      t.empty ? "" : t.waves && t.waves.state === "inferring" ? ` · waiting for wave ${t.waves.frozen + 1}`
        : t.rounds.current ? ` · ${t.waves ? "wave" : "round"} ${t.rounds.current}/${t.rounds.total}` : " · done",
      t.enough?.met ? " · enough" : ""));
}

/* ---------- router ---------- */
function showView(mode) {
  App.mode = mode;
  if (mode === "home") App.setTopbar("Decision Mill", App.config.projectName || "");
  $("#home-view").hidden = mode !== "home";
  $("#spec-view").hidden = mode !== "spec";
  $("#label-view").hidden = mode !== "label";
  $("#bucket-totals").hidden = mode !== "spec";
  document.body.dataset.mode = mode;
  if (mode !== "spec") Spec.close();
  setDrawer(false);
  App.dock(null);
  for (const a of $$("#nav a")) {
    const h = a.getAttribute("href");
    a.classList.toggle("active", h === location.hash || (mode === "home" && a.classList.contains("nav-home")) ||
      (mode === "label" && a.dataset.task && typeof L !== "undefined" && L.taskId === a.dataset.task));
  }
}

async function route() {
  let parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  // #/w/<ws>/… : the workspace prefix. On its own it filters the home screen and
  // sidebar; in front of a task or spec it is context only (ids are global).
  if (parts[0] === "w" && parts[1]) {
    const ws = parts[1];
    parts = parts.slice(2);
    if (!parts.length && App.wsFilter !== ws) { App.wsFilter = ws; await Shell.refreshNav(); }
  } else if (!parts.length && App.wsFilter) { App.wsFilter = null; await Shell.refreshNav(); }
  try {
    if (parts[0] === "spec" && parts[1]) {
      showView("spec");
      await Spec.open(parts[1], parts[2] || null);
      showView("spec");
      // Old links (#/spec/…) become the workspace form in place.
      const want = `${App.specHref(parts[1])}${parts.length > 2 ? `/${parts.slice(2).map(encodeURIComponent).join("/")}` : ""}`;
      if (!location.hash.startsWith("#/w/") && App.wsOf.set[parts[1]] && location.hash !== want) history.replaceState(null, "", want);
      return;
    }
    if (parts[0] === "task" && parts[1]) {
      showView("label");
      const sub = parts[2] === "item" ? "label" : parts[2] || "label";
      await Label.open(parts[1], sub, parts[2] === "item" ? parts.slice(3).join("/") : null);
      showView("label");
      return;
    }
  } catch (e) {
    console.error(e);
    toast(`Could not open: ${e.message}`, "err");
  }
  showView("home");
  Shell.renderHome();
  // Coming back from a task: re-read progress so the inbox is current.
  if (homeVisits++) { await Shell.refreshNav(); if (App.mode === "home") Shell.renderHome(); }
}
let homeVisits = 0;
window.addEventListener("hashchange", route);

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
  else searchResults.innerHTML = `<div class="sr-empty">type to search every spec and label task</div>`;
}
function closeSearch() {
  searchModal.hidden = true;
  searchInput.blur();
}

async function runSearch() {
  const q = searchInput.value.trim();
  if (q.length < 2) { searchResults.innerHTML = `<div class="sr-empty">type to search every spec and label task</div>`; return; }
  const seq = ++searchSeq;
  const data = await api(`api/search?q=${encodeURIComponent(q)}`).catch(() => null);
  if (seq !== searchSeq || !data) return;
  const rs = data.results || [];
  searchResults.innerHTML = rs.length ? rs.map((r, i) => r.type === "item" ? `
    <button class="sr" data-i="${i}" type="button">
      <div class="sr-top"><span class="sr-id">${esc(r.id)}</span><span class="sr-title">${esc(r.title)}</span>
      <span class="sr-meta">${esc(r.taskTitle)}</span></div>
      <span class="sr-snip">${esc(r.snippet)}</span>
    </button>` : `
    <button class="sr" data-i="${i}" type="button">
      <div class="sr-top"><span class="sr-id">${esc(r.id)}</span><span class="sr-title">${esc(r.title)}</span>
      <span class="sr-meta">${esc(r.slug)} · ${esc(r.decision ? Spec.verdictLabel(r.decision, r.set) : r.status)}</span></div>
      <span class="sr-snip">${esc(r.snippet)}</span>
    </button>`).join("") : `<div class="sr-empty">no matches</div>`;
  for (const b of searchResults.querySelectorAll(".sr")) {
    b.addEventListener("click", () => {
      const r = rs[Number(b.dataset.i)];
      closeSearch();
      if (r.type === "item") location.hash = `${App.taskHref(r.task)}/item/${encodeURIComponent(r.id)}`;
      else Spec.jumpTo(r.set, r.slug, r.id);
    });
  }
}

$("#search-trigger").addEventListener("click", openSearch);
searchModal.querySelector(".sm-backdrop").addEventListener("click", closeSearch);
let searchStale = false;
searchInput.addEventListener("input", () => {
  searchStale = true;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => { await runSearch(); searchStale = false; }, 180);
});
searchInput.addEventListener("keydown", async (e) => {
  if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
  else if (e.key === "Enter") {
    e.preventDefault();
    // Typed fast and hit Enter before the debounce: search now, never open a
    // result left over from the previous query.
    if (searchStale) { clearTimeout(searchTimer); await runSearch(); searchStale = false; }
    const first = searchResults.querySelector(".sr");
    if (first) first.click();
  }
});

/* ---------- help overlay ---------- */
const helpModal = $("#help-modal");
App.help.common = [["⌘K or /", "search everything"], ["?", "this help"], ["Esc", "close a panel or leave a text box"]];
function openHelp() {
  const rows = [...(App.help[App.mode] || []), ...App.help.common];
  $("#help-body").innerHTML = `
    <h3>${App.mode === "label" ? "Labeling" : App.mode === "spec" ? "Spec review" : "Shortcuts"}</h3>
    <table>${rows.map(([k, d]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(d)}</td></tr>`).join("")}</table>`;
  helpModal.hidden = false;
}
const closeHelp = () => { helpModal.hidden = true; };
$("#help-trigger").addEventListener("click", openHelp);
helpModal.querySelector(".sm-backdrop").addEventListener("click", closeHelp);

/* ---------- theme ---------- */
function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  $("#theme-toggle").textContent = t === "light" ? "☀" : t === "dark" ? "☾" : "◐";
  $("#theme-toggle").title = `theme: ${t || "system"} (click to change)`;
  // The phone's browser chrome follows a forced theme too.
  for (const m of $$('meta[name="theme-color"]')) {
    if (!m.dataset.content) m.dataset.content = m.content;
    m.content = t === "light" ? "#f6f5f1" : t === "dark" ? "#14171d" : m.dataset.content;
  }
}
$("#theme-toggle").addEventListener("click", () => {
  const order = [null, "light", "dark"];
  const next = order[(order.indexOf(store.get("theme")) + 1) % order.length];
  store.set("theme", next);
  applyTheme(next);
});
applyTheme(store.get("theme"));

/* ---------- narrow screens: the sidebar is a slide-over drawer ---------- */
function setDrawer(open) {
  const app = $("#app");
  const was = app.classList.contains("nav-open");
  app.classList.toggle("nav-open", open);
  $("#drawer-backdrop").hidden = !open;
  $("#menu-toggle").setAttribute("aria-expanded", String(open));
  if (open && !was) {
    // Bring the current spec or task into view in a long list.
    const active = $("#nav a.active.spec-row, #nav a.active.task-row");
    if (active) active.scrollIntoView({ block: "nearest" });
  }
}
const drawerOpen = () => $("#app").classList.contains("nav-open");
$("#menu-toggle").addEventListener("click", () => setDrawer(!drawerOpen()));
$("#topbar-title").addEventListener("click", () => setDrawer(true));
$("#drawer-close").addEventListener("click", () => setDrawer(false));
$("#drawer-backdrop").addEventListener("click", () => setDrawer(false));
$("#topbar-search").addEventListener("click", openSearch);
// Picking the spec already open changes no hash, so close the drawer here too.
$("#nav").addEventListener("click", (e) => { if (e.target.closest("a")) setDrawer(false); });
$("#search-trigger").addEventListener("click", () => setDrawer(false));

/* ---------- keyboard: one dispatcher, mode handlers below it ---------- */
document.addEventListener("keydown", (e) => {
  if (!helpModal.hidden) { if (e.key === "Escape" || e.key === "?") { e.preventDefault(); closeHelp(); } return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openSearch(); return; }
  if (!searchModal.hidden) return;
  if (e.key === "Escape" && drawerOpen()) { e.preventDefault(); setDrawer(false); return; }
  if (isTyping()) {
    if (e.key === "Escape") document.activeElement.blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); openSearch(); return; }
  if (e.key === "?") { e.preventDefault(); openHelp(); return; }
  const h = App.keyHandlers[App.mode];
  if (h && h(e)) e.preventDefault();
});

/* ---------- boot ---------- */
(async () => {
  try {
    const cfg = await api("api/config");
    Object.assign(App.config, cfg);
  } catch { /* defaults */ }
  Spec.buildLocatorPatterns(App.config.locatorSchemes || [App.config.locatorScheme || "repo"]);
  const sub = $("#project-name");
  if (sub) { sub.textContent = App.config.projectName || ""; sub.hidden = !App.config.projectName; }
  await Shell.refreshNav();
  // With exactly one thing to do, skip the home screen.
  if (!location.hash && Shell.home) {
    const specSets = Shell.home.specSets.filter((x) => Shell.isActive(x));
    const tasks = Shell.home.tasks.filter((x) => Shell.isActive(x));
    // replaceState, not location.replace: no hashchange, so route() runs once.
    if (tasks.length === 1 && !specSets.length) history.replaceState(null, "", App.taskHref(tasks[0].id));
    else if (specSets.length === 1 && !tasks.length) history.replaceState(null, "", App.specHref(specSets[0].id));
  }
  await route();
})();
