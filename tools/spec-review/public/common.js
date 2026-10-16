/* decision-mill — helpers shared by the shell, spec mode and label mode.
   Plain scripts, no build step: everything here is a global the other files use. */
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

// Shared app state that is not owned by one mode.
const App = {
  config: { locatorScheme: "repo", locatorPrefix: "repo:", projectName: "", reviewer: "reviewer", specSets: [] },
  mode: "home",           // home | spec | label
  keyHandlers: {},        // mode -> (KeyboardEvent) => boolean (true = handled)
  help: {},               // mode -> [[keys, description], ...]
};

// Every request URL is relative ("api/…", never "/api/…") so the app works under
// any reverse-proxy mount, including `tailscale serve`.
async function api(path, opts) {
  const res = await fetch(String(path).replace(/^\/+/, ""), opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}
const postJSON = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// The href for an outbound link, or null: only absolute http(s) URLs become links
// (never javascript:, data:, relative paths). Browser twin of lib/url.js httpUrl.
function httpHref(v) {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

// An anchor that opens outside the app, in a new tab, without an opener.
function extLink(href, attrs, ...kids) {
  return el("a", { ...attrs, href, target: "_blank", rel: "noopener noreferrer" }, ...kids);
}

function md(text) {
  if (!text) return "";
  // Never let a missing/broken markdown vendor blank the whole page.
  if (typeof marked === "undefined") return `<pre class="prose-raw">${esc(text)}</pre>`;
  try {
    return marked.parse(String(text));
  } catch (e) {
    return `<pre class="prose-raw">${esc(text)}</pre>`;
  }
}

// Tiny element builder: el("div", {class: "x", onclick}, child, "text", [more]).
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
  return e;
}

let toastTimer = null;
function toast(msg, kind) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.className = `toast on${kind ? ` ${kind}` : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "toast"; }, 2600);
}

const pad2 = (n) => String(n).padStart(2, "0");
function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function fmtDur(s) {
  if (s == null || !Number.isFinite(Number(s))) return "";
  s = Math.round(Number(s));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad2(Math.floor((s % 3600) / 60))}m`;
}
function fmtClock(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return "";
  const s = Math.max(0, Math.floor(Number(sec)));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}` : `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}
const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);

// Per-viewer conveniences only (remembered tab, theme). Never state that matters.
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(`dm:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`dm:${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};

const isTyping = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "") || document.activeElement?.isContentEditable;

/* ---------- phone layout helpers ---------- */
// One breakpoint for "phone": the bottom bars, the docked answer box, swipes.
// (Guarded: the tests load this file with no DOM.)
const phoneMQ = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 640px)") : null;
const isPhone = () => Boolean(phoneMQ && phoneMQ.matches);
function onPhoneChange(fn) {
  if (!phoneMQ) return;
  if (phoneMQ.addEventListener) phoneMQ.addEventListener("change", fn);
  else if (phoneMQ.addListener) phoneMQ.addListener(fn);
}

// The top bar's title and subtitle (narrow screens only; hidden on desktop).
App.setTopbar = (name, sub) => {
  const n = $("#topbar-title .tt-name"), s = $("#topbar-title .tt-sub");
  if (n) n.textContent = name || "Decision Mill";
  if (s) s.textContent = sub || "";
};

// A bar fixed to the bottom of a phone screen (spec mode's verdict bar, label
// mode's action bar): keep --dock-h equal to its height so #main can pad for it
// and nothing hides behind it. A bar that is not fixed (desktop) measures 0.
App.dock = (() => {
  let current = null;
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => measure()) : null;
  function measure() {
    const b = current;
    const h = b && b.isConnected && !b.hidden && getComputedStyle(b).position === "fixed" ? b.offsetHeight : 0;
    document.documentElement.style.setProperty("--dock-h", `${h}px`);
  }
  return (bar) => {
    if (bar !== current) {
      if (ro && current) ro.unobserve(current);
      current = bar || null;
      if (ro && current) ro.observe(current);
    }
    measure();
  };
})();
// iOS keeps a fixed bottom bar behind the on-screen keyboard: lift bars by the
// part of the layout viewport the keyboard covers.
if (typeof window !== "undefined" && window.visualViewport) {
  const vv = window.visualViewport;
  const lift = () => {
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty("--kb", `${kb > 60 ? kb : 0}px`);
  };
  vv.addEventListener("resize", lift);
  vv.addEventListener("scroll", lift);
}

// Horizontal swipe on `target` -> fn(1) for next, fn(-1) for previous. Ignored
// inside text fields, code, tables and anything that scrolls sideways, and when
// the touch selected text.
function onSwipe(target, fn) {
  if (!target) return;
  let x0 = 0, y0 = 0, t0 = 0, armed = false;
  const scrollsSideways = (node) => {
    for (let n = node; n && n !== target; n = n.parentElement) {
      if (n.scrollWidth > n.clientWidth + 2 && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) return true;
    }
    return false;
  };
  target.addEventListener("touchstart", (e) => {
    armed = e.touches.length === 1 && !e.target.closest("input, textarea, select, pre, table, audio, .dots, details.more[open]") && !scrollsSideways(e.target);
    if (!armed) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  target.addEventListener("touchend", (e) => {
    if (!armed) return;
    armed = false;
    if (Date.now() - t0 > 700 || String(window.getSelection?.() || "")) return;
    const t = e.changedTouches[0];
    const d = globalThis.ViewLogic ? ViewLogic.swipeDirection(t.clientX - x0, t.clientY - y0) : 0;
    if (d) fn(d);
  }, { passive: true });
}
