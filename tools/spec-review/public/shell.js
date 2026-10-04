/* decision-mill shell — one UI for both modes: sidebar navigation, home screen,
   hash router, ⌘K search, ? help, theme, and the global keyboard dispatcher.
   Routes (hash-based, so any reverse-proxy mount works):
     #/                                  home: every spec set and label task
     #/spec/<set>[/<slug>]               spec mode
     #/task/<id>[/item/<item>|/items|/results]   label mode */
"use strict";

const Shell = {
  home: null,

  async refreshNav() {
    let data;
    try { data = await api("api/home"); } catch (e) { $("#nav").innerHTML = `<div class="nav-err">${esc(e.message)}</div>`; return; }
    Shell.home = data;
    App.config.reviewer = data.reviewer || App.config.reviewer;
    $("#whoami").textContent = App.config.reviewer;
    const nav = $("#nav");
    nav.innerHTML = "";
    nav.append(el("a", { class: `nav-home${App.mode === "home" ? " active" : ""}`, href: "#/" }, "Home"));
    for (const set of data.specSets) {
      const group = el("div", { class: "nav-group" },
        el("div", { class: "nav-head" }, el("span", {}, "Specs"), el("small", { title: set.dir }, set.name)));
      const list = el("div", { class: "spec-list", "data-set": set.id });
      for (const s of set.specs) list.append(Spec.rowEl(set.id, s));
      group.append(list);
      nav.append(group);
    }
    if (data.tasks.length) {
      const group = el("div", { class: "nav-group" }, el("div", { class: "nav-head" }, el("span", {}, "Labeling")));
      for (const t of data.tasks) group.append(taskRowEl(t));
      nav.append(group);
    }
    if (!data.specSets.length && !data.tasks.length) nav.append(el("div", { class: "nav-err" }, "Nothing configured — see the README."));
  },

  renderHome() {
    const d = Shell.home || { specSets: [], tasks: [] };
    const v = $("#home-view");
    v.innerHTML = "";
    v.append(el("header", { class: "home-head" },
      el("h2", {}, "What needs a human today"),
      el("p", {}, "Spec mode decides open product questions in markdown specs. Label mode collects your judgments on items, blind, in rounds, and checks models against them.")));
    const grid = el("div", { class: "home-grid" });
    for (const t of d.tasks) {
      const pctDone = t.items ? t.labeled / t.items : 0;
      grid.append(el("a", { class: "home-card", href: `#/task/${encodeURIComponent(t.id)}` },
        el("div", { class: "hc-kind" }, "Label task", t.blind ? el("span", { class: "hc-tag" }, "blind") : null),
        el("h3", {}, t.title),
        t.question ? el("p", { class: "hc-q" }, t.question) : null,
        el("div", { class: "meter wide" }, el("i", { class: "m-decided", style: `width:${(pctDone * 100).toFixed(1)}%` })),
        el("div", { class: "hc-stats" }, `${t.labeled} of ${t.items} labeled · `,
          t.waves ? (t.waves.state === "inferring" ? `waiting for wave ${t.waves.frozen + 1} of ${t.waves.count}` : t.rounds.current ? `wave ${t.rounds.current} of ${t.rounds.total}` : "all waves done")
            : t.rounds.current ? `round ${t.rounds.current} of ${t.rounds.total} next` : "all rounds done",
          t.standinReviewers ? ` · ${t.standinReviewers} stand-in` : "",
          t.errors ? el("b", { class: "err" }, ` · ${t.errors} error(s)`) : "")));
    }
    for (const set of d.specSets) {
      const c = set.counts;
      grid.append(el("a", { class: "home-card", href: `#/spec/${encodeURIComponent(set.id)}` },
        el("div", { class: "hc-kind" }, "Spec set"),
        el("h3", {}, set.name),
        el("p", { class: "hc-q" }, set.specs.map((s) => s.title).join(" · ") || "no specs"),
        el("div", { class: "meter wide" }, el("i", { class: "m-decided", style: `width:${c.decidable ? (100 * c.decided / c.decidable).toFixed(1) : 0}%` })),
        el("div", { class: "hc-stats" }, `${c.decided} of ${c.decidable} decided · ${c.open} open`)));
    }
    if (!grid.childNodes.length) grid.append(el("div", { class: "empty" }, "No spec sets or label tasks found yet. A label task appears here as soon as its directory (task.yaml + items.jsonl) lands under a labels root — reload to check."));
    v.append(grid);
    v.append(el("p", { class: "home-foot" }, "Press ", el("kbd", {}, "?"), " for shortcuts, ", el("kbd", {}, "⌘K"), " to search everything."));
  },
};

function taskRowEl(t) {
  const denom = t.items || 1;
  return el("a", { class: `spec-row task-row${App.mode === "label" && typeof L !== "undefined" && L.taskId === t.id ? " active" : ""}`, href: `#/task/${encodeURIComponent(t.id)}`, "data-task": t.id },
    el("div", { class: "name" }, t.title),
    el("div", { class: "meter", role: "img", "aria-label": `${t.labeled} of ${t.items} labeled` },
      el("i", { class: "m-decided", style: `width:${(100 * t.labeled / denom).toFixed(1)}%` })),
    el("div", { class: "stats" }, `${t.labeled}/${t.items} labeled`,
      t.waves && t.waves.state === "inferring" ? ` · waiting for wave ${t.waves.frozen + 1}`
        : t.rounds.current ? ` · ${t.waves ? "wave" : "round"} ${t.rounds.current}/${t.rounds.total}` : " · done"));
}

/* ---------- router ---------- */
function showView(mode) {
  App.mode = mode;
  $("#home-view").hidden = mode !== "home";
  $("#spec-view").hidden = mode !== "spec";
  $("#label-view").hidden = mode !== "label";
  $("#bucket-totals").hidden = mode !== "spec";
  document.body.dataset.mode = mode;
  if (mode !== "spec") Spec.close();
  $("#app").classList.remove("nav-open");
  for (const a of $$("#nav a")) {
    const h = a.getAttribute("href");
    a.classList.toggle("active", h === location.hash || (mode === "home" && h === "#/") ||
      (mode === "label" && a.dataset.task && location.hash.startsWith(`#/task/${encodeURIComponent(a.dataset.task)}`)));
  }
}

async function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  try {
    if (parts[0] === "spec" && parts[1]) {
      showView("spec");
      await Spec.open(parts[1], parts[2] || null);
      showView("spec");
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
}
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
      <span class="sr-meta">${esc(r.slug)} · ${esc(r.decision ? Spec.verdictLabel(r.decision) : r.status)}</span></div>
      <span class="sr-snip">${esc(r.snippet)}</span>
    </button>`).join("") : `<div class="sr-empty">no matches</div>`;
  for (const b of searchResults.querySelectorAll(".sr")) {
    b.addEventListener("click", () => {
      const r = rs[Number(b.dataset.i)];
      closeSearch();
      if (r.type === "item") location.hash = `#/task/${encodeURIComponent(r.task)}/item/${encodeURIComponent(r.id)}`;
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
}
$("#theme-toggle").addEventListener("click", () => {
  const order = [null, "light", "dark"];
  const next = order[(order.indexOf(store.get("theme")) + 1) % order.length];
  store.set("theme", next);
  applyTheme(next);
});
applyTheme(store.get("theme"));
$("#menu-toggle").addEventListener("click", () => $("#app").classList.toggle("nav-open"));

/* ---------- keyboard: one dispatcher, mode handlers below it ---------- */
document.addEventListener("keydown", (e) => {
  if (!helpModal.hidden) { if (e.key === "Escape" || e.key === "?") { e.preventDefault(); closeHelp(); } return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openSearch(); return; }
  if (!searchModal.hidden) return;
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
  Spec.buildLocatorPatterns(App.config.locatorScheme || "repo");
  const sub = $("#project-name");
  if (sub) { sub.textContent = App.config.projectName || ""; sub.hidden = !App.config.projectName; }
  await Shell.refreshNav();
  // With exactly one thing to do, skip the home screen.
  if (!location.hash && Shell.home) {
    const { specSets, tasks } = Shell.home;
    // replaceState, not location.replace: no hashchange, so route() runs once.
    if (tasks.length === 1 && !specSets.length) history.replaceState(null, "", `#/task/${encodeURIComponent(tasks[0].id)}`);
    else if (specSets.length === 1 && !tasks.length) history.replaceState(null, "", `#/spec/${encodeURIComponent(specSets[0].id)}`);
  }
  await route();
})();
