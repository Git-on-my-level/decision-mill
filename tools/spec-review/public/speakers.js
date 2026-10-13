/* Speaker mode: label voice groups by ear, then skim the transcript.
   Uses the shared shell and the append-only label API; no model output is shown
   until Results. One hidden <audio> element is shared by every view. */
window.Speakers = (() => {
  const enc = encodeURIComponent;
  const SPECIAL = [{ id: "mixed", label: "Mixed" }, { id: "noise", label: "Not speech" }, { id: "unsure", label: "Unsure" }];
  const PALETTE = ["var(--unify)", "var(--keep)", "var(--metric)", "var(--team)", "var(--toss)", "var(--abstain)"];
  let taskId, task, data, tab = "label", convId, cardId, clipIdx = 0, showAll = false, busy = false;
  let audio, stopAt = null, playingSeg = null, onTick = null, wordsIdx = null;
  const pref = (k, d) => { try { const v = localStorage.getItem(`dm-speakers:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem(`dm-speakers:${k}`, JSON.stringify(v)); } catch {} };
  const base = () => `api/task/${enc(taskId)}`;
  const fmt = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`; };
  const dur = (s) => (s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : fmt(s));
  const isPerson = (l) => l != null && !SPECIAL.some((s) => s.id === l);
  const choices = () => [...data.roster.map((x) => ({ id: x, label: x })), ...SPECIAL];
  const color = (l) => (isPerson(l) ? PALETTE[Math.max(0, data.roster.indexOf(l)) % PALETTE.length] : "var(--faint)");
  const labelText = (l) => choices().find((c) => c.id === l)?.label || l;
  const conv = () => data.conversations.find((c) => c.id === convId) || data.conversations[0];
  const segById = (c, id) => c.segments.find((s) => s.id === id);
  const groupsOf = (c) => data.queue.filter((q) => q.content.conversation === c.id)
    .sort((a, b) => Number(a.label != null) - Number(b.label != null) || b.meta.duration_s - a.meta.duration_s || a.id.localeCompare(b.id));
  const card = () => data.queue.find((q) => q.id === cardId);
  const systemName = (id) => task.system_names?.[id] || id;
  const undoRows = () => { try { return JSON.parse(sessionStorage.getItem(`speaker-undo:${taskId}`) || "[]"); } catch { return []; } };
  const remember = (rows) => { try { sessionStorage.setItem(`speaker-undo:${taskId}`, JSON.stringify([...undoRows(), ...rows.map((r) => ({ item_id: r.item_id, scope: r.scope }))])); } catch {} };
  const fail = (e) => toast(e.message, "err");
  async function reload() { data = await api(`${base()}/speakers`); }
  function btn(attrs, ...kids) { const b = el("button", { type: "button", ...attrs }, ...kids); return b; }

  // ---- audio -------------------------------------------------------------
  function ensureAudio() {
    if (audio) return audio;
    audio = new Audio(); audio.preload = "metadata";
    audio.addEventListener("timeupdate", () => {
      if (stopAt != null && audio.currentTime >= stopAt) { audio.pause(); stopAt = null; }
      onTick?.(audio.currentTime);
    });
    audio.addEventListener("play", () => syncPlayState()); audio.addEventListener("pause", () => syncPlayState());
    return audio;
  }
  function srcFor(c) { return `${base()}/media?src=${enc(c.media)}`; }
  function play(c, start, end = null, segId = null) {
    const a = ensureAudio();
    if (a.getAttribute("src") !== srcFor(c)) a.src = srcFor(c);
    stopAt = end; playingSeg = segId;
    const go = () => { a.currentTime = Math.max(0, start - (end != null ? 0.15 : 0)); a.play().catch((e) => toast(`Audio: ${e.message}`, "err")); };
    if (a.readyState >= 1) go(); else a.addEventListener("loadedmetadata", go, { once: true });
    syncPlayState();
  }
  function toggle(seg, c) {
    if (playingSeg === seg.id && audio && !audio.paused) { audio.pause(); return; }
    play(c, seg.start, seg.end, seg.id);
  }
  function syncPlayState() {
    const on = audio && !audio.paused;
    for (const r of $$("[data-seg]")) r.classList.toggle("playing", on && r.dataset.seg === playingSeg);
    const pp = $("#sp-pp"); if (pp) { pp.textContent = on ? "❚❚" : "▶"; pp.setAttribute("aria-label", on ? "Pause" : "Play"); }
  }

  // ---- writes ------------------------------------------------------------
  async function write(label, id, scope = "group", source = "human") {
    if (busy || !id || !label) return;
    busy = true;
    try {
      const r = await postJSON(`${base()}/label`, { item_id: id, label, scope, source });
      remember([r.row]);
      await reload();
      if (scope === "group" && label !== "mixed") { advance(); toast(`${labelText(label)} · u to undo`); }
      render(); Shell.refreshNav();
    } finally { busy = false; }
  }
  async function acceptAll(ids) {
    if (!ids.length) return;
    const r = await postJSON(`${base()}/suggestions`, { ids });
    remember(r.rows); await reload(); advance(); render(); Shell.refreshNav();
    toast(`Accepted ${ids.length} suggestions · u undoes one at a time`);
  }
  async function undo() {
    const rows = undoRows(), r = rows.pop(); if (!r) { toast("Nothing to undo"); return; }
    await postJSON(`${base()}/undo`, r);
    try { sessionStorage.setItem(`speaker-undo:${taskId}`, JSON.stringify(rows)); } catch {}
    await reload();
    if (r.scope === "group") cardId = r.item_id;
    render(); Shell.refreshNav(); toast("Undone");
  }
  function advance() {
    const next = groupsOf(conv()).find((q) => q.label == null);
    cardId = next?.id || null; clipIdx = 0; showAll = false;
  }

  // ---- shared pieces -----------------------------------------------------
  function frame(body) {
    const v = $("#label-view");
    const tabs = el("nav", { class: "tabs" }, ["label", "transcript", "audit", "results"].map((x) =>
      el("a", { class: `tab${tab === x ? " on" : ""}`, href: `#/task/${enc(taskId)}${x === "label" ? "" : `/${x}`}` }, x[0].toUpperCase() + x.slice(1))));
    v.replaceChildren(el("div", { class: "lv sp" }, el("header", { class: "lv-head" }, el("h2", {}, task.title), tabs), body));
  }
  function convChips() {
    return el("div", { class: "sp-convs", role: "tablist", "aria-label": "Conversation" }, data.conversations.map((c) => {
      const left = groupsOf(c).filter((q) => q.label == null).length;
      const b = btn({ class: `sp-conv${c.id === conv().id ? " on" : ""}`, role: "tab", "aria-selected": String(c.id === conv().id),
        onclick: () => { convId = c.id; setPref(`conv:${taskId}`, c.id); advance(); render(); } },
        el("span", { class: "sp-conv-title" }, c.title || c.id),
        el("span", { class: "sp-conv-meta" }, `${c.date || ""} · ${fmt(c.duration_s)} · ${left ? `${left} groups left` : "done"}`),
        el("span", { class: "sp-meter" }, el("i", { style: `width:${(100 * c.progress.rate).toFixed(1)}%` })));
      return b;
    }));
  }
  function personKeyHint(i) { return i < 9 ? String(i + 1) : ""; }
  function picker(id, scope, current, suggestion, compact = false) {
    const wrap = el("div", { class: `sp-picker${compact ? " compact" : ""}` });
    const people = el("div", { class: "sp-people" });
    choices().forEach((c, i) => {
      const special = !isPerson(c.id);
      const b = btn({ class: `sp-pill${special ? " special" : ""}${current === c.id ? " current" : ""}${suggestion === c.id ? " suggested" : ""}`,
        "data-choice": c.id, onclick: () => write(c.id, id, scope, suggestion === c.id && scope === "group" ? "suggested-accepted" : "human").catch(fail) },
        special ? null : el("i", { class: "sp-dot", style: `background:${color(c.id)}` }), el("span", {}, c.label),
        personKeyHint(i) && !compact ? el("kbd", {}, personKeyHint(i)) : null,
        suggestion === c.id && !compact ? el("kbd", { class: "enter" }, "↵") : null);
      if (!special) people.append(b);
    });
    const name = el("input", { class: "sp-new", placeholder: data.roster.length > 1 ? "New person…" : "Who's this? Type a name ↵", list: "sp-roster", "aria-label": "Add a person", maxlength: 80, autocomplete: "off" });
    name.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); const v = name.value.trim(); if (v && !SPECIAL.some((s) => s.id === v.toLowerCase())) write(v, id, scope).catch(fail); }
      if (e.key === "Escape") name.blur();
    });
    people.append(name, el("datalist", { id: "sp-roster" }, data.roster.map((x) => el("option", { value: x }))));
    const specials = el("div", { class: "sp-special" }, choices().map((c, i) => isPerson(c.id) ? null :
      btn({ class: `sp-pill special${current === c.id ? " current" : ""}`, onclick: () => write(c.id, id, scope).catch(fail) }, c.label, !compact && personKeyHint(i) ? el("kbd", {}, personKeyHint(i)) : null)));
    wrap.append(people, specials);
    return wrap;
  }
  function clipRow(c, s, extra) {
    const row = el("div", { class: "sp-clip", "data-seg": s.id },
      btn({ class: "sp-play", "aria-label": `Play clip at ${fmt(s.start)}`, onclick: () => toggle(s, c) }),
      el("button", { type: "button", class: "sp-clip-text", onclick: () => toggle(s, c) },
        el("span", { class: "sp-time" }, fmt(s.start)), el("span", { class: "sp-words" }, s.text || ""),
        el("span", { class: "sp-len" }, `${dur(s.end - s.start)}${s.short ? " · short" : ""}`)),
      extra || null);
    return row;
  }

  // ---- label tab ---------------------------------------------------------
  function renderLabel(body) {
    const c = conv();
    body.append(convChips());
    const groups = groupsOf(c), left = groups.filter((q) => q.label == null);
    const sugg = Object.entries(data.suggestions).filter(([id]) => groups.some((q) => q.id === id));
    const speechLeft = left.reduce((n, q) => n + q.meta.duration_s, 0);
    const status = el("div", { class: "sp-status" },
      el("span", {}, el("b", {}, `${groups.length - left.length}`), ` of ${groups.length} groups · `, el("b", {}, `${Math.round(100 * c.progress.rate)}%`), " of speech labeled",
        left.length ? ` · ${dur(speechLeft)} to go` : ""));
    if (sugg.length) {
      const by = {}; for (const [, s] of sugg) by[s.label] = (by[s.label] || 0) + 1;
      status.append(btn({ class: "sp-bulk", onclick: () => acceptAll(sugg.map(([id]) => id)).catch(fail) },
        `Accept ${sugg.length} suggestion${sugg.length > 1 ? "s" : ""}`,
        el("small", {}, Object.entries(by).map(([l, n]) => `${n} ${l}`).join(" · "))));
    }
    body.append(status);
    if (!cardId || !groups.some((q) => q.id === cardId)) advance();
    const it = card();
    if (!it) {
      const next = data.conversations.find((x) => x.id !== c.id && groupsOf(x).some((q) => q.label == null));
      body.append(el("section", { class: "sp-card sp-done" }, el("h3", {}, "Every group here is labeled."),
        el("p", {}, "Skim the transcript to catch anything that sounds off, or keep going."),
        el("div", { class: "sp-row" }, btn({ class: "sp-pill", onclick: () => { location.hash = `#/task/${enc(taskId)}/transcript`; } }, "Skim transcript"),
          next ? btn({ class: "sp-pill primary", onclick: () => { convId = next.id; advance(); render(); } }, `Next: ${next.title}`) : null)));
      return;
    }
    const stable = [...groups].sort((a, b) => b.meta.duration_s - a.meta.duration_s || a.id.localeCompare(b.id));
    const idx = stable.indexOf(it), sug = data.suggestions[it.id];
    const reps = (it.content.representatives?.length ? it.content.representatives : it.content.segments).map((id) => segById(c, id)).filter(Boolean);
    const all = it.content.segments.map((id) => segById(c, id)).filter(Boolean).sort((a, b) => a.start - b.start);
    const head = el("div", { class: "sp-card-head" },
      el("div", {}, el("div", { class: "sp-eyebrow" }, `Group ${idx + 1} of ${groups.length}`),
        el("div", { class: "sp-card-title" }, `${all.length} clip${all.length > 1 ? "s" : ""} · ${dur(it.meta.duration_s)} of speech`)),
      it.label ? el("span", { class: "sp-tag", style: `--c:${color(it.label)}` }, `Labeled ${labelText(it.label)}`) :
        sug ? el("span", { class: "sp-tag hint", style: `--c:${color(sug.label)}` }, `Sounds like ${sug.label}`, el("small", {}, sug.distance < 0.3 ? "strong match" : "possible match")) : null);
    const list = el("div", { class: "sp-clips" }, (showAll || it.label === "mixed" ? all : reps.slice(0, 4)).map((s) =>
      clipRow(c, s, it.label === "mixed" ? el("div", { class: "sp-seglabel" }, segPicker(s)) : null)));
    const more = all.length > 4 && it.label !== "mixed" ? btn({ class: "sp-link", onclick: () => { showAll = !showAll; render(); } }, showAll ? "Show 4 samples" : `Show all ${all.length} clips`) : null;
    body.append(el("section", { class: "sp-card" }, head,
      it.label === "mixed" ? el("p", { class: "sp-note" }, "Mixed group: label each clip below, or relabel the whole group.") : null,
      list, more,
      picker(it.id, "group", it.label, sug?.label),
      el("div", { class: "sp-nav" },
        btn({ class: "sp-link", onclick: () => step(-1) }, "← Previous"), btn({ class: "sp-link", onclick: () => step(1) }, "Next →"),
        el("label", { class: "sp-toggle" }, el("input", { type: "checkbox", checked: pref("autoplay", true), onchange: (e) => setPref("autoplay", e.target.checked) }), " Autoplay"),
        el("span", { class: "sp-keys" }, el("kbd", {}, "Space"), " play next · ", el("kbd", {}, "1–9"), " label · ", el("kbd", {}, "↵"), " accept · ", el("kbd", {}, "u"), " undo"))));
    if (pref("autoplay", true) && reps[0] && audio?.dataset.card !== it.id) {
      ensureAudio().dataset.card = it.id; clipIdx = 1; play(c, reps[0].start, reps[0].end, reps[0].id);
    }
    onTick = null; syncPlayState();
  }
  function segPicker(s) {
    const box = el("div", { class: "sp-mini" });
    data.roster.concat(["noise", "unsure"]).forEach((l) => box.append(btn({ class: `sp-mini-b${s.label === l ? " on" : ""}`, style: `--c:${color(l)}`, onclick: () => write(l, s.id, "segment").catch(fail) }, labelText(l))));
    return box;
  }
  function step(d) {
    const g = groupsOf(conv()), i = Math.max(0, g.findIndex((q) => q.id === cardId));
    const n = g[Math.max(0, Math.min(g.length - 1, i + d))]; if (n) { cardId = n.id; clipIdx = 0; showAll = false; render(); }
  }

  // ---- transcript tab ----------------------------------------------------
  function playerBar(c) {
    const a = ensureAudio(); if (a.getAttribute("src") !== srcFor(c)) a.src = srcFor(c);
    const time = el("span", { class: "sp-clock" }, `0:00 / ${fmt(c.duration_s)}`);
    const speed = el("select", { class: "sp-speed", "aria-label": "Playback speed" }, [1, 1.25, 1.5, 2].map((x) => el("option", { value: String(x), selected: a.playbackRate === x }, `${x}×`)));
    speed.addEventListener("change", () => { a.playbackRate = Number(speed.value); });
    const lane = el("div", { class: "sp-lane", title: "Click to jump" });
    for (const s of c.segments) if (s.label) lane.append(el("i", { style: `left:${(100 * s.start / c.duration_s).toFixed(3)}%;width:${Math.max(0.15, 100 * (s.end - s.start) / c.duration_s).toFixed(3)}%;background:${color(s.label)}` }));
    const head = el("b", { class: "sp-playhead" }); lane.append(head);
    lane.addEventListener("click", (e) => { const r = lane.getBoundingClientRect(); play(c, (e.clientX - r.left) / r.width * c.duration_s); });
    const bar = el("div", { class: "sp-player" },
      el("div", { class: "sp-row" }, btn({ id: "sp-pp", class: "sp-pp", "aria-label": "Play", onclick: () => { if (a.paused) { stopAt = null; a.play().catch(fail); } else a.pause(); } }, "▶"),
        time, speed, el("label", { class: "sp-toggle" }, el("input", { type: "checkbox", id: "sp-follow", checked: pref("follow", true), onchange: (e) => setPref("follow", e.target.checked) }), " Follow")),
      lane);
    let last = -1;
    onTick = (t) => {
      time.textContent = `${fmt(t)} / ${fmt(c.duration_s)}`; head.style.left = `${(100 * t / c.duration_s).toFixed(3)}%`;
      if (!wordsIdx) return;
      let lo = 0, hi = c.words.length - 1, f = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (c.words[m][0] <= t) { f = m; lo = m + 1; } else hi = m - 1; }
      if (f >= 0 && t > c.words[f][1] + 0.8) f = -1;
      if (f === last) return; wordsIdx.get(last)?.classList.remove("now"); last = f;
      const w = wordsIdx.get(f); if (!w) return; w.classList.add("now");
      if (!audio.paused && $("#sp-follow")?.checked) { const r = w.getBoundingClientRect(); if (r.top < innerHeight * 0.3 || r.bottom > innerHeight - 80) w.scrollIntoView({ block: "center", behavior: "smooth" }); }
    };
    return bar;
  }
  function renderTranscript(body) {
    const c = conv(); body.append(convChips()); body.append(playerBar(c));
    const legend = el("div", { class: "sp-legend" }, data.roster.map((p) => el("span", {}, el("i", { class: "sp-dot", style: `background:${color(p)}` }), p)),
      el("span", {}, el("i", { class: "sp-dot", style: "background:var(--faint)" }), "Unlabeled"));
    body.append(legend, el("p", { class: "sp-note" }, "Click a word to play from there. Click a speaker name to fix that turn."));
    const turns = []; let cur = null;
    for (const s of c.segments) {
      if (cur && cur.label === s.label && s.start - cur.end < 2) { cur.segs.push(s); cur.end = s.end; }
      else { cur = { label: s.label, start: s.start, end: s.end, segs: [s] }; turns.push(cur); }
    }
    wordsIdx = new Map();
    const box = el("div", { class: "sp-transcript" });
    for (const t of turns) {
      const words = el("div", { class: "sp-turn-words" });
      for (const s of t.segs) for (let i = s.w0; i < s.w1; i++) { const w = el("span", { class: "sp-w", "data-i": String(i) }, c.words[i][2]); wordsIdx.set(i, w); words.append(w, " "); }
      const who = btn({ class: "sp-who", style: `--c:${color(t.label)}` }, t.label ? labelText(t.label) : "Unlabeled");
      const turn = el("div", { class: `sp-turn${t.label ? "" : " unlabeled"}`, style: `--c:${color(t.label)}` }, el("div", { class: "sp-turn-head" }, who, el("span", { class: "sp-time" }, fmt(t.start))), words);
      who.addEventListener("click", () => {
        $(".sp-turn .sp-mini")?.remove();
        const mini = el("div", { class: "sp-mini" });
        data.roster.concat(["noise", "unsure"]).forEach((l) => mini.append(btn({ class: `sp-mini-b${t.label === l ? " on" : ""}`, style: `--c:${color(l)}`,
          onclick: async () => { for (const s of t.segs) await postJSON(`${base()}/label`, { item_id: s.id, label: l, scope: "segment", source: "human" }).then((r) => remember([r.row])); await reload(); render(); Shell.refreshNav(); } }, labelText(l))));
        turn.querySelector(".sp-turn-head").after(mini);
      });
      box.append(turn);
    }
    box.addEventListener("click", (e) => { const w = e.target.closest(".sp-w"); if (w) { stopAt = null; play(c, c.words[+w.dataset.i][0] - 0.2); } });
    body.append(box);
  }

  // ---- audit tab ---------------------------------------------------------
  function renderAudit(body) {
    const c = conv(); body.append(convChips());
    const done = c.audit.filter((s) => s.label != null).length, s = c.audit.find((x) => x.label == null);
    body.append(el("div", { class: "sp-status" }, el("span", {}, `Spot check · `, el("b", {}, `${done} of ${c.audit.length}`),
      " · random clips, shown without their group's label. This measures how pure the groups are.")));
    if (!s) { body.append(el("section", { class: "sp-card sp-done" }, el("h3", {}, "Spot check done for this conversation."), el("p", {}, "See Results for group purity."))); onTick = null; return; }
    body.append(el("section", { class: "sp-card" }, el("div", { class: "sp-card-head" }, el("div", {}, el("div", { class: "sp-eyebrow" }, `Clip ${done + 1} of ${c.audit.length}`), el("div", { class: "sp-card-title" }, "Who is speaking?"))),
      el("div", { class: "sp-clips" }, clipRow(c, s)), picker(s.id, "audit", null, null)));
    if (pref("autoplay", true) && audio?.dataset.card !== s.id) { ensureAudio().dataset.card = s.id; play(c, s.start, s.end, s.id); }
    onTick = null; syncPlayState();
  }

  // ---- results tab -------------------------------------------------------
  let resultsOk = false;
  async function renderResults(body) {
    onTick = null;
    const unfinished = data.conversations.filter((c) => c.progress.rate < 0.95);
    if (unfinished.length && !resultsOk) {
      body.append(el("section", { class: "sp-card sp-done" }, el("h3", {}, "Results stay hidden while you label."),
        el("p", {}, `Seeing how each system scores can nudge borderline calls. ${unfinished.length} conversation${unfinished.length > 1 ? "s are" : " is"} under 95% labeled.`),
        el("div", { class: "sp-row" }, btn({ class: "sp-pill primary", onclick: () => { location.hash = `#/task/${enc(taskId)}`; } }, "Keep labeling"),
          btn({ class: "sp-pill", onclick: () => { resultsOk = true; render(); } }, "Show anyway"))));
      return;
    }
    let r; try { r = await api(`${base()}/results`); } catch (e) { fail(e); return; }
    if (tab !== "results") return;
    const pct = (x) => (x == null ? "—" : `${(100 * x).toFixed(1)}%`);
    body.append(el("p", { class: "sp-note" }, "Per-word speaker accuracy against your labels (labeled speech only). 1:1 maps each system speaker to at most one person; many:1 lets several system speakers map to the same person, which flatters over-splitting. Truth exported to build/truth.json."));
    for (const x of r.conversations) {
      const c = data.conversations.find((y) => y.id === x.id);
      const rows = [...x.systems.map((m) => ({ ...m, name: systemName(m.id) })).sort((a, b) => (b.one_to_one ?? -1) - (a.one_to_one ?? -1)), { ...x.baseline, name: "Everyone is one speaker", base: true }];
      body.append(el("section", { class: "sp-card" },
        el("div", { class: "sp-card-head" }, el("div", {}, el("div", { class: "sp-eyebrow" }, `${c?.date || ""} · ${pct(x.progress.rate)} of speech labeled`), el("div", { class: "sp-card-title" }, c?.title || x.id))),
        el("div", { class: "table-wrap" }, el("table", { class: "sp-table" },
          el("thead", {}, el("tr", {}, ["System", "1:1", "Many:1", "Speakers found / true", "Words"].map((h) => el("th", {}, h)))),
          el("tbody", {}, rows.map((m) => el("tr", { class: m.base ? "base" : "" }, el("td", {}, m.name),
            el("td", { class: "num" }, el("span", { class: "sp-bar", style: `--w:${(100 * (m.one_to_one || 0)).toFixed(1)}%` }), pct(m.one_to_one)),
            el("td", { class: "num" }, pct(m.many_to_one)), el("td", { class: "num" }, `${m.speakers_found} / ${m.speakers_true}`), el("td", { class: "num" }, String(m.words))))))),
        el("p", { class: "sp-note" }, x.purity.compared ? `Group purity ${pct(x.purity.rate)} (${x.purity.agree}/${x.purity.compared} spot-checked clips agree with their group; 95% interval ${x.purity.ci.map(pct).join("–")}).` : "Group purity: no spot checks yet (Audit tab).")));
    }
  }

  function render() {
    audio?.pause(); stopAt = null; wordsIdx = null;
    const body = el("div", { class: "sp-body" });
    frame(body);
    if (tab === "results") renderResults(body);
    else if (tab === "transcript") renderTranscript(body);
    else if (tab === "audit") renderAudit(body);
    else renderLabel(body);
  }

  return {
    async open(id, t, sub, itemId) {
      taskId = id; task = t; tab = sub === "items" ? "label" : sub || "label";
      await reload();
      convId = pref(`conv:${taskId}`, data.conversations[0]?.id);
      if (!data.conversations.some((c) => c.id === convId)) convId = data.conversations[0]?.id;
      if (itemId && data.queue.some((q) => q.id === itemId)) { cardId = itemId; convId = card().content.conversation; }
      render();
    },
    key(e) {
      const k = e.key;
      if (e.target?.matches?.("input,select,textarea")) return false;
      if (k === "u") { undo().catch(fail); return true; }
      if (tab === "label") {
        const it = card(); if (!it) return false;
        const c = conv();
        if (k === " ") {
          const reps = (it.content.representatives?.length ? it.content.representatives : it.content.segments).slice(0, showAll ? undefined : 4);
          const s = segById(c, reps[clipIdx++ % reps.length]); if (s) play(c, s.start, s.end, s.id); return true;
        }
        if (k === "j" || k === "ArrowRight") { step(1); return true; }
        if (k === "k" || k === "ArrowLeft") { step(-1); return true; }
        if (k === "Enter" && data.suggestions[it.id]) { write(data.suggestions[it.id].label, it.id, "group", "suggested-accepted").catch(fail); return true; }
        if (/^[1-9]$/.test(k)) { const ch = choices()[Number(k) - 1]; if (ch) write(ch.id, it.id, "group", data.suggestions[it.id]?.label === ch.id ? "suggested-accepted" : "human").catch(fail); return true; }
        if (k === "n") { $(".sp-new")?.focus(); return true; }
      } else if (tab === "audit") {
        const c = conv(), s = c.audit.find((x) => x.label == null); if (!s) return false;
        if (k === " ") { play(c, s.start, s.end, s.id); return true; }
        if (/^[1-9]$/.test(k)) { const ch = choices()[Number(k) - 1]; if (ch) write(ch.id, s.id, "audit").catch(fail); return true; }
      } else if (tab === "transcript" && k === " " && audio) { if (audio.paused) { stopAt = null; audio.play().catch(() => {}); } else audio.pause(); return true; }
      return false;
    },
  };
})();
