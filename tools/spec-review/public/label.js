/* Label mode — one card at a time, blind, in stratified rounds; plus an item list
   and a Results view that answers "is my labeling useful?".
   Mounted by shell.js at #/task/<id>[/item/<item>|/items|/results]. */
// Scoped: each mode file runs in its own function so top-level names (both
// modes have a renderItems) can never collide; only the mode object is global.
(() => {
"use strict";

const enc = encodeURIComponent;
const L = {
  taskId: null, data: null, task: null,
  index: new Map(),          // item id -> light row {id, title, round, label, note, meta, stratum?}
  rounds: [], roundIdx: 0, pos: 0,   // pos === round length means "round done" screen
  tab: "label",
  cache: new Map(),          // item id -> {item, state}
  undo: [],                  // item ids labeled this session, most recent last
  noteDraft: {}, fieldDraft: {},
  fill: store.get("fill", false),
  itemsFilter: "all", itemsRound: "all", itemsSel: 0,
  saving: false, cardTok: 0, pickTimes: [],
};

const roundIds = () => L.rounds[L.roundIdx]?.ids || [];
const currentId = () => roundIds()[L.pos] || null;
const labelOf = (id) => L.index.get(id)?.label ?? null;
const labelDef = (id) => L.task?.labels.find((l) => l.id === id) || null;
const labeledCount = () => [...L.index.values()].filter((r) => r.label != null).length;
const toneOf = (l) => (!l ? "none" : l.tone || (l.abstain ? "abstain" : "neutral"));
const enter = (k) => el("kbd", {}, k);

function firstUnlabeled(r, from = 0) {
  const ids = L.rounds[r]?.ids || [];
  for (let i = from; i < ids.length; i++) if (labelOf(ids[i]) == null) return i;
  return null;
}
function gotoItem(id) {
  const r = L.rounds.findIndex((rd) => rd.ids.includes(id));
  if (r === -1) return false;
  L.roundIdx = r;
  L.pos = L.rounds[r].ids.indexOf(id);
  return true;
}
// Leave a deep link (#/task/x/item/y) once the reviewer moves on, so a reload
// resumes at the first unlabeled card instead of the old one.
function settleHash() {
  const base = `#/task/${enc(L.taskId)}`;
  const want = L.tab === "label" ? base : `${base}/${L.tab}`;
  if (location.hash !== want) history.replaceState(null, "", want);
}

async function loadTask(taskId) {
  const data = await api(`api/task/${enc(taskId)}`);
  const changed = L.taskId !== taskId;
  L.taskId = taskId; L.data = data; L.task = data.task;
  L.index = new Map(data.index.map((r) => [r.id, r]));
  L.rounds = data.rounds;
  if (changed) {
    L.cache.clear(); L.undo = []; L.noteDraft = {}; L.fieldDraft = {}; L.pickTimes = [];
    if (data.current >= L.rounds.length) { L.roundIdx = Math.max(0, L.rounds.length - 1); L.pos = roundIds().length; }
    else { L.roundIdx = data.current; L.pos = firstUnlabeled(L.roundIdx) ?? 0; }
  }
}

const Label = {
  async open(taskId, tab, itemId) {
    await loadTask(taskId);
    L.tab = tab || "label";
    if (itemId && gotoItem(itemId)) L.tab = "label";
    render();
  },
};

/* ---------- layout ---------- */
function render() {
  const v = $("#label-view");
  const t = L.task;
  const n = labeledCount();
  const tabs = [["label", "Label", null], ["items", "Items", `${n}/${L.index.size}`], ["results", "Results", null]];
  const head = el("header", { class: "lv-head" },
    el("div", { class: "lv-title" },
      el("div", { class: "eyebrow" }, "Label task", t.blind ? el("span", { class: "hc-tag" }, "blind") : null),
      el("h2", {}, t.title)),
    el("nav", { class: "tabs", role: "tablist" }, tabs.map(([id, name, extra]) =>
      el("a", { class: `tab${L.tab === id ? " on" : ""}`, role: "tab", "aria-selected": String(L.tab === id),
        href: `#/task/${enc(L.taskId)}${id === "label" ? "" : `/${id}`}` }, name, extra ? el("small", {}, extra) : null))));
  const problems = [];
  if (L.data.errors.length) problems.push(el("div", { class: "lv-errors" }, el("b", {}, "Task errors: "), L.data.errors.map((e) => el("div", {}, `· ${e}`))));
  if (L.data.warnings.length) problems.push(el("details", { class: "lv-warnings" }, el("summary", {}, `${L.data.warnings.length} format warning(s)`), L.data.warnings.map((e) => el("div", {}, `· ${e}`))));
  const body = el("div", { class: "lv-body" });
  v.replaceChildren(el("div", { class: "lv" }, head, ...problems, body));
  if (L.tab === "items") renderItems(body);
  else if (L.tab === "results") renderResults(body);
  else renderLabel(body);
}

function refreshTaskRow() {
  const row = document.querySelector(`.task-row[data-task="${CSS.escape(L.taskId)}"]`);
  if (!row) return;
  const n = labeledCount(), total = L.index.size || 1;
  row.querySelector(".meter i").style.width = `${(100 * n / total).toFixed(1)}%`;
  const cur = L.rounds.findIndex((r) => r.ids.some((id) => labelOf(id) == null));
  row.querySelector(".stats").textContent = `${n}/${L.index.size} labeled${cur === -1 ? " · done" : ` · round ${cur + 1}/${L.rounds.length}`}`;
  const tabCount = document.querySelector(".lv-head .tab:nth-child(2) small");
  if (tabCount) tabCount.textContent = `${n}/${L.index.size}`;
}

/* ---------- label tab ---------- */
function renderLabel(body) {
  const t = L.task;
  if (t.instructions) {
    const key = `instr:${L.taskId}`;
    const d = el("details", { class: "instructions", open: store.get(key, labeledCount() === 0) }, el("summary", {}, "Instructions"), el("div", { class: "prose", html: md(t.instructions) }));
    d.addEventListener("toggle", () => store.set(key, d.open));
    body.append(d);
  }
  body.append(el("div", { id: "round-bar" }), el("div", { id: "card-slot" }));
  renderRoundBar();
  renderCardArea();
}

function renderRoundBar() {
  const bar = $("#round-bar");
  if (!bar) return;
  const ids = roundIds();
  const left = ids.filter((id) => labelOf(id) == null).length;
  const sel = el("select", { class: "round-select", "aria-label": "Round" }, L.rounds.map((r, i) => {
    const done = r.ids.filter((id) => labelOf(id) != null).length;
    return el("option", { value: String(i), selected: i === L.roundIdx }, `Round ${r.n} of ${L.rounds.length} · ${done}/${r.ids.length}${done === r.ids.length ? " ✓" : ""}`);
  }));
  sel.addEventListener("change", () => {
    L.roundIdx = Number(sel.value);
    L.pos = firstUnlabeled(L.roundIdx) ?? roundIds().length;
    renderRoundBar(); renderCardArea();
  });
  // Pace estimate from this session's own picks, once there are a few.
  let eta = "";
  if (L.pickTimes.length >= 3 && left) {
    const gaps = L.pickTimes.slice(1).map((x, i) => x - L.pickTimes[i]).filter((g) => g < 300000);
    if (gaps.length) eta = ` · about ${Math.max(1, Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * left / 60000))} min left`;
  }
  const dots = el("div", { class: "dots", role: "list" }, ids.map((id, i) => {
    const l = labelDef(labelOf(id));
    return el("button", { class: `dot tone-${toneOf(l)}${i === L.pos ? " cur" : ""}`, type: "button", role: "listitem",
      title: `${i + 1}. ${L.index.get(id)?.title || id}${l ? ` — ${l.label}` : ""}`,
      onclick: () => { L.pos = i; renderRoundBar(); renderCardArea(); } });
  }));
  bar.className = "round-bar";
  bar.replaceChildren(
    el("div", { class: "rb-top" }, sel, el("span", { class: "rb-left" }, left ? `${left} of ${ids.length} left${eta}` : "round complete"),
      el("span", { class: "rb-total" }, `${labeledCount()} of ${L.index.size} labeled overall`)),
    dots);
}

async function renderCardArea() {
  const slot = $("#card-slot");
  if (!slot) return;
  const ids = roundIds();
  if (!ids.length) { slot.replaceChildren(el("div", { class: "empty" }, "This task has no items.")); return; }
  if (L.pos >= ids.length) { slot.replaceChildren(roundDone()); return; }
  const id = currentId();
  const tok = ++L.cardTok;
  let entry = L.cache.get(id);
  if (!entry) {
    slot.classList.add("loading");
    try { entry = await api(`api/task/${enc(L.taskId)}/item/${enc(id)}`); }
    catch (e) { slot.replaceChildren(el("div", { class: "lv-errors" }, `Could not load ${id}: ${e.message}`)); return; }
    finally { slot.classList.remove("loading"); }
    L.cache.set(id, entry);
  }
  if (tok !== L.cardTok) return;
  slot.replaceChildren(cardEl(entry));
  $("#main").scrollTop = 0;
  prefetch();
}

function prefetch() {
  const ids = roundIds();
  for (const id of ids.slice(L.pos + 1, L.pos + 3)) {
    if (L.cache.has(id)) continue;
    api(`api/task/${enc(L.taskId)}/item/${enc(id)}`).then((e) => { if (!L.cache.has(id)) L.cache.set(id, e); }).catch(() => {});
  }
}

/* ---------- the card ---------- */
function speakerName(seg) {
  if (seg.is_user) return L.task.user_label || "You";
  if (seg.name) return String(seg.name);
  const m = /^SPEAKER_?(\d+)$/i.exec(String(seg.speaker || ""));
  return m ? `Speaker ${Number(m[1])}` : String(seg.speaker || "Speaker");
}

function transcriptEl(segments, audioRef) {
  const box = el("div", { class: "transcript" });
  let prev = null;
  for (const s of segments || []) {
    if (!s || !String(s.text || "").trim()) continue;
    const who = speakerName(s);
    const same = prev && prev === who;
    const time = s.start != null ? el(audioRef ? "button" : "span", {
      class: "seg-time", type: audioRef ? "button" : null, title: audioRef ? "play from here" : null,
      onclick: audioRef ? () => { const a = audioRef(); if (a) { a.currentTime = Number(s.start); a.play().catch(() => {}); } } : null,
    }, fmtClock(s.start)) : null;
    box.append(el("div", { class: `seg${s.is_user ? " me" : ""}${same ? " cont" : ""}` },
      same ? null : el("div", { class: "seg-head" }, el("span", { class: "seg-who" }, who), time),
      el("div", { class: "seg-text" }, s.text, same && time ? time : null)));
    prev = who;
  }
  if (!box.childNodes.length) box.append(el("div", { class: "seg empty-seg" }, "(empty transcript)"));
  return box;
}

function contentEl(c, audioRef) {
  if (!c) return el("div", { class: "empty-seg" }, "(no content)");
  if (c.type === "transcript") return transcriptEl(c.segments, audioRef);
  if (c.type === "markdown") return el("div", { class: "prose doc", html: md(c.body) });
  return el("div", { class: "plain doc" }, String(c.body ?? ""));
}

function relationText(c) {
  const g = c.gap_min != null ? `${Math.round(Number(c.gap_min))} min ` : "";
  if (c.relation === "overlapping") return "overlapping";
  if (c.relation === "before" || c.relation === "after") return `${g}${c.relation}`;
  return c.relation || "nearby";
}

function contextEl(ctx) {
  if (!Array.isArray(ctx) || !ctx.length) return null;
  const order = { before: 0, overlapping: 1, after: 2 };
  const sorted = [...ctx].sort((a, b) => (order[a.relation] ?? 1) - (order[b.relation] ?? 1));
  return el("section", { class: "context" },
    el("h4", {}, `Around it · ${ctx.length} nearby`),
    sorted.map((c) => {
      const hasMore = (Array.isArray(c.segments) && c.segments.length) || c.content;
      const head = [el("span", { class: `rel rel-${esc(c.relation || "x")}` }, relationText(c)), el("strong", {}, c.title || "(untitled)")];
      if (!hasMore) return el("div", { class: "ctx-item" }, el("div", { class: "ctx-line" }, head), c.summary ? el("p", {}, c.summary) : null);
      return el("details", { class: "ctx-item" }, el("summary", { class: "ctx-line" }, head),
        c.summary ? el("p", {}, c.summary) : null,
        c.content ? contentEl(c.content) : transcriptEl(c.segments));
    }));
}

function mediaEl(item) {
  const media = Array.isArray(item.media) ? item.media : [];
  if (!media.length) return { node: null, audio: () => null };
  let firstAudio = null;
  const node = el("div", { class: "media" }, media.map((m) => {
    const src = `api/task/${enc(L.taskId)}/media?src=${enc(m.src)}`;
    if (m.type === "image") return el("figure", {}, el("img", { src, alt: m.label || "" }), m.label ? el("figcaption", {}, m.label) : null);
    const a = el("audio", { controls: true, preload: "metadata", src });
    if (!firstAudio) firstAudio = a;
    return el("div", { class: "audio" }, m.label ? el("span", { class: "media-label" }, m.label) : null, a);
  }));
  return { node, audio: () => firstAudio };
}

function metaChips(item) {
  const m = item.meta || {};
  const chips = [];
  if (m.started_at) chips.push(fmtDate(m.started_at));
  if (m.duration_s != null) chips.push(fmtDur(m.duration_s));
  if (m.word_count != null) chips.push(`${m.word_count} words`);
  if (m.source) chips.push(String(m.source));
  for (const [k, v] of Object.entries(m)) if (!["started_at", "duration_s", "word_count", "source"].includes(k) && v != null && typeof v !== "object") chips.push(`${k.replace(/_/g, " ")}: ${v}`);
  if (item.stratum != null && !item.blinded) chips.push(`stratum: ${item.stratum}`);
  return chips;
}

function cardEl(entry) {
  const { item, state } = entry;
  const t = L.task;
  const id = item.id;
  const ids = roundIds();
  const cur = state?.label ?? null;
  const fields = { ...(state?.fields || {}), ...(L.fieldDraft[id] || {}) };
  const { node: media, audio } = mediaEl(item);

  const choices = el("div", { class: "choices", style: `--n:${t.labels.length}` }, t.labels.map((l) =>
    el("button", { class: `choice tone-${toneOf(l)}${cur === l.id ? " sel" : ""}`, type: "button", "data-label": l.id,
      onclick: () => pick(l.id) }, el("span", {}, l.label), l.key ? enter(l.key) : null)));

  const fieldEls = t.fields.map((f) => {
    if (f.type === "checkbox") {
      const on = Boolean(fields[f.id]);
      return el("button", { class: `field-toggle${on ? " on" : ""}`, type: "button", "aria-pressed": String(on), onclick: () => toggleField(f.id) },
        el("span", { class: "box" }, on ? "✓" : ""), el("span", {}, f.label), f.key ? enter(f.key) : null);
    }
    if (f.type === "choice") {
      return el("div", { class: "field-choice" }, el("span", { class: "fc-label" }, f.label),
        f.options.map((o) => el("button", { class: `seg-btn${fields[f.id] === o.id ? " on" : ""}`, type: "button",
          onclick: () => setField(f.id, fields[f.id] === o.id ? null : o.id) }, o.label)));
    }
    const inp = el("input", { class: "field-text", placeholder: f.label, value: fields[f.id] || "" });
    inp.addEventListener("change", () => setField(f.id, inp.value));
    return el("label", { class: "field-text-wrap" }, el("span", { class: "fc-label" }, f.label), inp);
  });

  const note = el("input", { class: "note", id: "note", placeholder: "Note — rides along with your label (n to type, Enter to save)", value: L.noteDraft[id] ?? state?.note ?? "", spellcheck: "false" });
  note.addEventListener("input", () => { L.noteDraft[id] = note.value; });
  note.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveNote(); note.blur(); }
  });

  const status = cur ? el("span", { class: "saved" }, `Saved · ${labelDef(cur)?.label || cur}${state?.at ? ` · ${new Date(state.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}`)
    : el("span", { class: "unsaved" }, "Not labeled yet");

  const summary = item.summary ? el("details", { class: "summary", open: t.summary === "open" },
    el("summary", {}, "Summary", el("span", { class: "hint" }, " — written by a model from this transcript; it can make a fragment look meaningful")),
    el("p", {}, item.summary)) : null;

  const segs = item.content?.type === "transcript" ? (item.content.segments || []).length : 0;
  return el("article", { class: "lcard", "data-id": id },
    el("div", { class: "lc-meta" },
      el("span", { class: "chip round" }, `${L.pos + 1} of ${ids.length}`),
      metaChips(item).map((c) => el("span", { class: "chip" }, c)),
      item.truncated ? el("span", { class: "chip warn" }, "excerpt — the full item was cut") : null),
    item.title ? el("h3", { class: "lc-title" }, item.title) : null,
    media,
    el("div", { class: "lc-content" }, contentEl(item.content, audio)),
    segs ? el("p", { class: "whole" }, item.truncated ? `Showing ${segs} segments of a longer item.` : `The whole item — all ${segs} segment${segs === 1 ? "" : "s"}, not an excerpt.`) : null,
    summary,
    contextEl(item.context),
    el("section", { class: "ask" },
      t.question ? el("h4", {}, t.question) : null,
      choices,
      fieldEls.length ? el("div", { class: "fields" }, fieldEls) : null,
      note),
    el("footer", { class: "lc-foot" },
      el("button", { class: "btn", type: "button", onclick: () => step(-1), disabled: L.pos === 0 && L.roundIdx === 0 }, "← Back ", enter("k")),
      el("button", { class: "btn", type: "button", onclick: () => step(1) }, "Skip → ", enter("j")),
      status,
      cur || L.undo.length ? el("button", { class: "btn undo", type: "button", onclick: undo }, "↩ Undo ", enter("u")) : null),
    revealEl(item, cur));
}

// After a blind item is labeled, the model answers are available — collapsed, so
// they do not anchor the next card, and marked against the reviewer's label.
function revealEl(item, cur) {
  if (item.blinded || !Array.isArray(item.reveal) || !item.reveal.length) return null;
  const rows = item.reveal.map((r) => {
    const agree = cur && r.verdict != null && !labelDef(cur)?.abstain ? r.verdict === cur : null;
    const score = r.score != null ? ` · score ${Number(r.score).toFixed(2)}${r.threshold != null ? (r.score >= r.threshold ? ` ≥ ${r.threshold}` : ` < ${r.threshold}`) : ""}` : "";
    return el("div", { class: "rv" }, el("strong", {}, r.model), ` said ${r.verdict ?? "—"}${score}`,
      agree == null ? null : el("span", { class: `rv-tag ${agree ? "ok" : "no"}` }, agree ? "agrees" : "disagrees"));
  });
  const n = item.reveal.filter((r) => cur && r.verdict != null && r.verdict !== cur && !labelDef(cur)?.abstain).length;
  return el("details", { class: "reveal" }, el("summary", {}, "Model answers", el("span", { class: "hint" }, n ? ` — ${n} disagree with you` : cur ? " — all agree" : "")), rows);
}

/* ---------- actions ---------- */
function flashChoice(labelId) {
  const b = document.querySelector(`.choice[data-label="${CSS.escape(labelId)}"]`);
  if (b) { b.classList.add("sel", "pressed"); }
}

async function pick(labelId) {
  const id = currentId();
  if (!id || L.saving) return;
  const entry = L.cache.get(id);
  const body = { item_id: id, label: labelId };
  if (L.task.fields.length) body.fields = { ...(entry?.state?.fields || {}), ...(L.fieldDraft[id] || {}) };
  const note = (L.noteDraft[id] ?? "").trim();
  if (note && note !== (entry?.state?.note || "")) body.note = note;
  L.saving = true;
  flashChoice(labelId);
  try {
    const res = await postJSON(`api/task/${enc(L.taskId)}/label`, body);
    L.cache.set(id, { item: res.item, state: res.state });
    const row = L.index.get(id);
    if (row) { row.label = res.state.label; row.note = res.state.note; if (res.item.stratum != null) row.stratum = res.item.stratum; }
    delete L.noteDraft[id]; delete L.fieldDraft[id];
    L.undo.push(id);
    L.pickTimes.push(Date.now());
    const roundWasOpen = roundIds().some((x) => x !== id && labelOf(x) == null);
    advance();
    refreshTaskRow();
    if (!roundWasOpen) Shell.refreshNav();
  } catch (e) {
    toast(`Not saved: ${e.message}`, "err");
    renderCardArea();
  } finally {
    L.saving = false;
  }
}

function advance() {
  const next = firstUnlabeled(L.roundIdx, L.pos + 1) ?? firstUnlabeled(L.roundIdx, 0);
  L.pos = next == null ? roundIds().length : next;
  settleHash();
  renderRoundBar();
  renderCardArea();
}

function step(d) {
  const ids = roundIds();
  let p = L.pos + d;
  if (p < 0) {
    if (L.roundIdx === 0) return;
    L.roundIdx--; p = roundIds().length - 1;
  } else if (p >= ids.length) {
    // Past the last card: the round-done screen only when the round really is
    // done; otherwise straight on to the next round's first card.
    const complete = ids.every((x) => labelOf(x) != null);
    if (!complete || p > ids.length) {
      if (L.roundIdx >= L.rounds.length - 1) return;
      L.roundIdx++; p = 0;
    }
  }
  L.pos = p;
  settleHash();
  renderRoundBar();
  renderCardArea();
}

async function undo() {
  let id = L.undo.pop();
  if (!id) { const cur = currentId(); if (cur && labelOf(cur) != null) id = cur; }
  if (!id) { toast("Nothing to undo"); return; }
  try {
    const res = await postJSON(`api/task/${enc(L.taskId)}/undo`, { item_id: id });
    L.cache.set(id, { item: res.item, state: res.state && res.state.label != null ? res.state : { ...res.state, label: null } });
    const row = L.index.get(id);
    if (row) row.label = null;
    gotoItem(id);
    renderRoundBar();
    renderCardArea();
    refreshTaskRow();
    toast(`Undone: ${L.index.get(id)?.title || id}`);
  } catch (e) {
    L.undo.push(id);
    toast(`Undo failed: ${e.message}`, "err");
  }
}

async function writePartial(id, patch) {
  const res = await postJSON(`api/task/${enc(L.taskId)}/label`, { item_id: id, ...patch });
  const prev = L.cache.get(id);
  L.cache.set(id, { item: res.item || prev?.item, state: res.state });
  const row = L.index.get(id);
  if (row) row.note = res.state.note;
}

async function setField(fid, value) {
  const id = currentId();
  if (!id) return;
  const entry = L.cache.get(id);
  if (entry?.state?.label != null) {
    // Already labeled: a field change is its own row (no label key).
    try { await writePartial(id, { fields: { [fid]: value } }); } catch (e) { toast(`Not saved: ${e.message}`, "err"); }
  } else {
    L.fieldDraft[id] = { ...(L.fieldDraft[id] || {}), [fid]: value };
  }
  renderCardArea();
}
function toggleField(fid) {
  const id = currentId();
  if (!id) return;
  const entry = L.cache.get(id);
  const cur = { ...(entry?.state?.fields || {}), ...(L.fieldDraft[id] || {}) };
  setField(fid, !cur[fid]);
}

async function saveNote() {
  const id = currentId();
  const entry = id && L.cache.get(id);
  if (!entry || entry.state?.label == null) return; // unlabeled: the draft rides along with the label
  const note = (L.noteDraft[id] ?? "").trim();
  if (note === (entry.state.note || "")) return;
  try { await writePartial(id, { note }); delete L.noteDraft[id]; toast("Note saved"); renderCardArea(); }
  catch (e) { toast(`Not saved: ${e.message}`, "err"); }
}

/* ---------- round done ---------- */
function roundDone() {
  const r = L.rounds[L.roundIdx];
  const nextIdx = L.rounds.findIndex((rd) => rd.ids.some((id) => labelOf(id) == null));
  const allDone = nextIdx === -1;
  const useful = el("p", { class: "rd-useful" }, "Reading your results…");
  api(`api/task/${enc(L.taskId)}/results`).then((res) => {
    useful.replaceChildren(res.usefulness.headline);
    if (res.usefulness.lines[0]) useful.append(el("span", { class: "rd-line" }, res.usefulness.lines[0]));
  }).catch(() => useful.remove());
  return el("div", { class: "round-done" },
    el("div", { class: "rd-mark", "aria-hidden": "true" }, "✓"),
    el("h3", {}, allDone ? "Every round is done" : `Round ${r.n} done`),
    el("p", {}, `${r.ids.length} labeled in this round · ${labeledCount()} of ${L.index.size} overall.`),
    useful,
    el("div", { class: "rd-actions" },
      allDone ? null : el("button", { class: "btn primary", type: "button", id: "next-round", onclick: startNextRound }, `Start round ${L.rounds[nextIdx].n} →`, enter("↵")),
      el("a", { class: "btn", href: `#/task/${enc(L.taskId)}/results` }, "See results"),
      el("button", { class: "btn ghost", type: "button", onclick: () => { L.pos = 0; renderRoundBar(); renderCardArea(); } }, "Review this round")));
}
function startNextRound() {
  const nextIdx = L.rounds.findIndex((rd) => rd.ids.some((id) => labelOf(id) == null));
  if (nextIdx === -1) return;
  L.roundIdx = nextIdx;
  L.pos = firstUnlabeled(nextIdx) ?? 0;
  renderRoundBar(); renderCardArea();
}

/* ---------- items tab ---------- */
function itemsRows() {
  let rows = [];
  for (const r of L.rounds) for (const id of r.ids) rows.push({ ...L.index.get(id), round: r.n });
  if (L.itemsRound !== "all") rows = rows.filter((x) => String(x.round) === L.itemsRound);
  const f = L.itemsFilter;
  if (f === "unlabeled") rows = rows.filter((x) => x.label == null);
  else if (f === "labeled") rows = rows.filter((x) => x.label != null);
  else if (f === "unsure") rows = rows.filter((x) => labelDef(x.label)?.abstain);
  else if (f === "noted") rows = rows.filter((x) => x.note);
  return rows;
}
function renderItems(body) {
  const filters = [["all", "All"], ["unlabeled", "Unlabeled"], ["labeled", "Labeled"], ["unsure", "Unsure"], ["noted", "With note"]];
  const roundSel = el("select", { class: "kind-select", "aria-label": "Round" }, el("option", { value: "all" }, "All rounds"),
    L.rounds.map((r) => el("option", { value: String(r.n), selected: L.itemsRound === String(r.n) }, `Round ${r.n}`)));
  roundSel.addEventListener("change", () => { L.itemsRound = roundSel.value; L.itemsSel = 0; render(); });
  const rows = itemsRows();
  L.itemsSel = Math.min(L.itemsSel, Math.max(0, rows.length - 1));
  body.append(el("div", { class: "items-toolbar" },
    el("div", { class: "filters" }, filters.map(([k, name]) => el("button", { class: `filter${L.itemsFilter === k ? " on" : ""}`, type: "button",
      onclick: () => { L.itemsFilter = k; L.itemsSel = 0; render(); } }, name)), roundSel),
    el("span", { class: "muted" }, `${rows.length} item${rows.length === 1 ? "" : "s"}`)));
  if (!rows.length) { body.append(el("div", { class: "empty" }, "Nothing under this filter.")); return; }
  const table = el("table", { class: "items-table" },
    el("thead", {}, el("tr", {}, el("th", {}, "Round"), el("th", {}, "Item"), el("th", {}, "When"), el("th", {}, "Your label"), el("th", {}, "Note"))),
    el("tbody", {}, rows.map((x, i) => {
      const l = labelDef(x.label);
      const tr = el("tr", { class: i === L.itemsSel ? "sel" : "", "data-id": x.id, tabindex: "-1" },
        el("td", { class: "num" }, String(x.round)),
        el("td", {}, el("div", { class: "it-title" }, x.title || x.id), x.title ? el("div", { class: "it-id" }, x.id) : null),
        el("td", { class: "muted" }, x.meta?.started_at ? fmtDate(x.meta.started_at) : ""),
        el("td", {}, l ? el("span", { class: `pill tone-${toneOf(l)}` }, l.label) : el("span", { class: "muted" }, "—")),
        el("td", { class: "muted note-cell" }, x.note || ""));
      tr.addEventListener("click", () => { location.hash = `#/task/${enc(L.taskId)}/item/${enc(x.id)}`; });
      return tr;
    })));
  body.append(el("div", { class: "table-wrap" }, table));
}

/* ---------- results tab ---------- */
async function renderResults(body) {
  body.append(el("div", { class: "empty" }, "Computing…"));
  let res;
  try { res = await api(`api/task/${enc(L.taskId)}/results${L.fill ? "?fill=1" : ""}`); }
  catch (e) { body.replaceChildren(el("div", { class: "lv-errors" }, e.message)); return; }
  if (L.tab !== "results") return;
  const t = L.task;
  const lab = (id) => labelDef(id)?.label || id;
  const c = res.counts;
  const u = res.usefulness;
  const out = [];
  out.push(el("section", { class: `useful v-${u.verdict}` },
    el("div", { class: "eyebrow" }, "Is my labeling useful?"),
    el("p", { class: "useful-head" }, u.headline),
    u.lines.length ? el("ul", {}, u.lines.map((x) => el("li", {}, x))) : null));
  const standins = res.models.filter((m) => m.kind === "standin");
  out.push(el("div", { class: "stat-grid" },
    stat("Labeled by you", `${c.humanLabeled}`, `of ${c.items} items · ${c.rounds.done} of ${c.rounds.total} rounds done`),
    stat("Disagreements found", `${u.disagreements || 0}`, "items where a model differs from you"),
    stat("Unsure", `${c.humanAbstained}`, "left out of agreement"),
    standins.length ? stat("Stand-in coverage", `${standins.map((s) => s.labeled).reduce((a, b) => Math.max(a, b), 0)}`, "items labeled by a model stand-in") : null));
  if (t.blind) out.push(el("p", { class: "hint-line" }, "These numbers reveal model answers for items you have labeled. Unlabeled cards stay blind."));
  const fillBox = el("label", { class: "toggle" }, el("input", { type: "checkbox", checked: L.fill }), " Fill items I haven't labeled with stand-in labels");
  fillBox.querySelector("input").addEventListener("change", (e) => { L.fill = e.target.checked; store.set("fill", L.fill); render(); });
  if (standins.length) out.push(fillBox);

  const models = res.models.filter((m) => m.kind === "model");
  if (models.length) {
    out.push(el("h3", { class: "sec" }, "Each model against you"));
    out.push(agreementTable(models, res));
  }
  if (standins.length) {
    out.push(el("h3", { class: "sec" }, "Can the stand-in replace you?"));
    out.push(el("p", { class: "hint-line" }, "Stand-in labels compared with your human labels only — never with filled ones."));
    out.push(agreementTable(standins, res));
  }
  for (const m of models) {
    if (m.curve) out.push(curveSection(m, lab));
    else if (m.curveNote) out.push(el("p", { class: "hint-line" }, `${m.id}: ${m.curveNote}.`));
  }
  out.push(el("h3", { class: "sec" }, "By stratum"));
  out.push(strataTable(res, lab));
  const dis = res.models.filter((m) => m.disagreements.length);
  if (dis.length) {
    out.push(el("h3", { class: "sec" }, "Where they disagree with you"));
    for (const m of dis) {
      out.push(el("details", { class: "dis" }, el("summary", {}, `${m.id} · ${m.disagreements.length}`),
        el("ul", {}, m.disagreements.slice(0, 100).map((d) => el("li", {},
          el("a", { href: `#/task/${enc(L.taskId)}/item/${enc(d.item_id)}` }, d.title || d.item_id),
          el("span", { class: "muted" }, ` — you: ${lab(d.truth)}, ${m.id}: ${lab(d.verdict)}`))))));
    }
  }
  body.replaceChildren(...out);
}

function stat(title, big, sub) {
  return el("div", { class: "stat" }, el("div", { class: "stat-t" }, title), el("div", { class: "stat-big" }, big), el("div", { class: "stat-sub" }, sub));
}

function agreementTable(models, res) {
  const lab = (id) => labelDef(id)?.label || id;
  return el("div", { class: "table-wrap" }, el("table", { class: "agree-table" },
    el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Agrees"), el("th", { class: "ci-col" }, "95% interval"), el("th", { class: "num" }, "n"), el("th", {}, "Confusion (you → it)"))),
    el("tbody", {}, models.map((m) => {
      const [lo, hi] = m.ci;
      const bar = el("div", { class: "ci" }, m.compared ? [
        el("i", { class: "ci-range", style: `left:${(lo * 100).toFixed(1)}%;width:${((hi - lo) * 100).toFixed(1)}%` }),
        el("i", { class: "ci-point", style: `left:${(m.rate * 100).toFixed(1)}%` })] : null);
      const conf = Object.entries(m.confusion).flatMap(([h, row]) => Object.entries(row).map(([v, n]) =>
        el("span", { class: `cf${h === v ? " ok" : ""}` }, `${lab(h)}→${lab(v)} ${n}`)));
      return el("tr", {},
        el("th", { scope: "row" }, m.id, m.threshold != null ? el("span", { class: "muted" }, ` @ ${m.threshold}`) : null),
        el("td", { class: "big-num" }, m.compared ? pct(m.rate) : "—"),
        el("td", { class: "ci-col" }, bar, m.compared ? el("div", { class: "ci-lab" }, `${pct(lo)}–${pct(hi)}`) : null),
        el("td", { class: "num" }, `${m.compared}${m.missing ? ` (+${m.missing} no answer)` : ""}`),
        el("td", { class: "conf" }, conf.length ? conf : el("span", { class: "muted" }, "—")));
    }))));
}

function curveSection(m, lab) {
  const cv = m.curve;
  const W = 640, H = 220, pl = 40, pr = 12, pt = 14, pb = 40;
  const lo = cv.bins[0].lo, hi = cv.bins[cv.bins.length - 1].hi;
  const x = (v) => pl + ((v - lo) / (hi - lo || 1)) * (W - pl - pr);
  const y = (r) => pt + (1 - r) * (H - pt - pb);
  const parts = [];
  for (const g of [0, 0.5, 1]) parts.push(`<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(g)}" y2="${y(g)}"/><text class="axis" x="${pl - 6}" y="${y(g) + 4}" text-anchor="end">${g * 100}%</text>`);
  for (const b of cv.bins) {
    const bx = x(b.lo) + 2, bw = Math.max(1, x(b.hi) - x(b.lo) - 4);
    if (b.n) parts.push(`<rect class="bar" x="${bx}" y="${y(b.rate)}" width="${bw}" height="${y(0) - y(b.rate)}"><title>${b.lo.toFixed(2)}–${b.hi.toFixed(2)}: you said ${esc(lab(cv.positive_label))} on ${b.positive} of ${b.n}</title></rect>`);
    parts.push(`<text class="axis n" x="${bx + bw / 2}" y="${H - pb + 14}" text-anchor="middle">${b.n || ""}</text>`);
  }
  const pts = cv.sweep.map((s) => `${x(s.threshold).toFixed(1)},${y(s.rate).toFixed(1)}`).join(" ");
  parts.push(`<polyline class="line" points="${pts}"/>`);
  if (m.threshold != null) parts.push(`<line class="thr" x1="${x(m.threshold)}" x2="${x(m.threshold)}" y1="${pt}" y2="${y(0)}"/><text class="axis thr-t" x="${x(m.threshold) + 4}" y="${pt + 10}">now ${m.threshold}</text>`);
  parts.push(`<text class="axis" x="${pl}" y="${H - 6}">${lo.toFixed(2)}</text><text class="axis" x="${W - pr}" y="${H - 6}" text-anchor="end">${hi.toFixed(2)}</text><text class="axis" x="${(W + pl) / 2}" y="${H - 6}" text-anchor="middle">score · labeled items per bin</text>`);
  const svg = el("div", { class: "chart", html: `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.id)} threshold curve">${parts.join("")}</svg>` });
  const keyRows = cv.sweep.filter((s, i) => s.current || (cv.safest && s.threshold === cv.safest.threshold) || i % 2 === 0);
  const pos = lab(cv.positive_label);
  return el("section", { class: "curve" },
    el("h3", { class: "sec" }, `${m.id}: what if the threshold moved?`),
    el("p", { class: "hint-line" }, `Bars: how often you said ${pos} in each score bin (the human ${pos} rate). Line: agreement if every item at or above the threshold were called ${pos}.`,
      cv.safest ? ` Lowest threshold that flags nothing you labeled otherwise: ${cv.safest.threshold} (catches ${cv.safest.tp} of ${cv.positives}).` : ""),
    el("div", { class: "legend" }, el("span", { class: "lg bar" }, `you said ${pos}`), el("span", { class: "lg line" }, "agreement at threshold"), m.threshold != null ? el("span", { class: "lg thr" }, "current threshold") : null),
    svg,
    el("details", { class: "dis" }, el("summary", {}, "Threshold table"),
      el("div", { class: "table-wrap" }, el("table", { class: "sweep" },
        el("thead", {}, el("tr", {}, el("th", {}, "Threshold"), el("th", { class: "num" }, `Flagged ${pos}`), el("th", { class: "num" }, `Right (you said ${pos})`), el("th", { class: "num" }, "Wrong (you said otherwise)"), el("th", { class: "num" }, `Missed ${pos}`), el("th", { class: "num" }, "Agreement"))),
        el("tbody", {}, keyRows.map((s) => el("tr", { class: s.current ? "cur" : "" },
          el("td", {}, String(s.threshold), s.current ? el("span", { class: "muted" }, " (now)") : null),
          el("td", { class: "num" }, String(s.flagged)), el("td", { class: "num" }, String(s.tp)),
          el("td", { class: `num${s.fp ? " bad" : ""}` }, String(s.fp)), el("td", { class: "num" }, String(s.fn)),
          el("td", { class: "num" }, pct(s.rate)))))))));
}

function strataTable(res, lab) {
  const models = res.models;
  return el("div", { class: "table-wrap" }, el("table", { class: "strata" },
    el("thead", {}, el("tr", {}, el("th", {}, "Stratum"), el("th", { class: "num" }, "Labeled"), el("th", {}, "Your labels"), models.map((m) => el("th", { class: "num" }, m.id)))),
    el("tbody", {}, res.strata.map((s) => el("tr", {},
      el("th", { scope: "row" }, s.stratum),
      el("td", { class: "num" }, `${s.labeled}/${s.items}`),
      el("td", {}, distBar(s.dist, s.labeled, lab)),
      models.map((m) => { const p = m.perStratum[s.stratum]; return el("td", { class: "num" }, p && p.compared ? `${pct(p.agree / p.compared)} (${p.compared})` : "—"); }))))));
}

function distBar(dist, n, lab) {
  if (!n) return el("span", { class: "muted" }, "—");
  return el("div", { class: "dist" }, Object.entries(dist).map(([k, v]) =>
    el("i", { class: `tone-${toneOf(labelDef(k))}`, style: `flex:${v}`, title: `${lab(k)}: ${v}` }, v >= 1 ? `${lab(k)} ${v}` : "")));
}

/* ---------- keyboard ---------- */
App.help.label = [
  ["1 · 2 · 3 …", "pick a label (keys shown on the buttons); saves and moves on"],
  ["field keys", "toggle a checkbox field (shown on the field)"],
  ["j / k  or  → / ←", "next / previous card in the round"],
  ["u", "undo your last label"],
  ["n", "type a note (Enter saves it; it also rides along with the next label)"],
  ["Space", "play / pause the item's audio"],
  ["Enter", "start the next round (on the round-done screen)"],
  ["Shift+L · I · R", "Label · Items · Results tab"],
];
App.keyHandlers.label = (e) => {
  const k = e.key;
  const tabKey = { L: "", I: "/items", R: "/results" }[k];
  if (tabKey != null) { location.hash = `#/task/${enc(L.taskId)}${tabKey}`; return true; }
  if (L.tab === "items") {
    const rows = $$(".items-table tbody tr");
    if (k === "j" || k === "k" || k === "ArrowDown" || k === "ArrowUp") {
      if (!rows.length) return true;
      L.itemsSel = Math.max(0, Math.min(rows.length - 1, L.itemsSel + (k === "j" || k === "ArrowDown" ? 1 : -1)));
      rows.forEach((r, i) => r.classList.toggle("sel", i === L.itemsSel));
      rows[L.itemsSel].scrollIntoView({ block: "nearest" });
      return true;
    }
    if (k === "Enter" && rows[L.itemsSel]) { rows[L.itemsSel].click(); return true; }
    return false;
  }
  if (L.tab !== "label") return false;
  if (L.pos >= roundIds().length) {
    if (k === "Enter") { startNextRound(); return true; }
    if (k === "k" || k === "ArrowLeft") { step(-1); return true; }
    if (k === "u") { undo(); return true; }
    return false;
  }
  const lk = k.toLowerCase();
  const l = L.task.labels.find((x) => x.key === lk);
  if (l) { pick(l.id); return true; }
  const f = L.task.fields.find((x) => x.key === lk && x.type === "checkbox");
  if (f) { toggleField(f.id); return true; }
  if (k === "j" || k === "ArrowRight") { step(1); return true; }
  if (k === "k" || k === "ArrowLeft") { step(-1); return true; }
  if (k === "u") { undo(); return true; }
  if (k === "n") { const n = $("#note"); if (n) { n.focus(); n.select(); } return true; }
  if (k === " ") { const a = $(".lcard audio"); if (a) { if (a.paused) a.play().catch(() => {}); else a.pause(); return true; } }
  return false;
};

window.Label = Label;
window.L = L;
})();
