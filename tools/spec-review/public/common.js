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
