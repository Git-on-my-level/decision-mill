// The `pair` content type (LABELS.md, "Pair items"): two sides — two captures,
// two documents, two model outputs — on one shared time axis, judged as "are
// these the same thing?". Validation, search/brief text, and the converter from
// the older transcript convention (DIVIDER rows, "A · " / "B · " speaker names).

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const finite = (v) => v != null && v !== "" && Number.isFinite(Number(v));

// Problems with a pair content block, as warnings (the item is still shown).
export function pairProblems(c) {
  const out = [];
  if (!Array.isArray(c.sides) || c.sides.length !== 2) out.push("pair content needs exactly two sides");
  const ids = Array.isArray(c.sides) ? c.sides.map((s) => (isObj(s) ? String(s.id ?? "") : "")) : [];
  if (ids.some((id) => !id)) out.push("every pair side needs an id");
  else if (new Set(ids).size !== ids.length) out.push("pair side ids must differ");
  for (const s of Array.isArray(c.sides) ? c.sides : []) {
    if (!isObj(s)) continue;
    if (s.duration_s != null && !finite(s.duration_s)) out.push(`pair side ${s.id}: duration_s must be a number`);
    if (s.start != null && !finite(s.start)) out.push(`pair side ${s.id}: start must be a number (seconds on the shared axis)`);
    if (s.started_at != null && !Number.isFinite(Date.parse(s.started_at))) out.push(`pair side ${s.id}: started_at is not a date`);
  }
  if (!Array.isArray(c.segments)) out.push("pair content needs a segments list");
  else {
    const bad = c.segments.filter((s) => !isObj(s) || !ids.includes(String(s.side)));
    if (bad.length) out.push(`${bad.length} pair segment(s) name no known side (want side: ${ids.join(" or ") || "A or B"})`);
    const noTime = c.segments.filter((s) => isObj(s) && !finite(s.start));
    if (noTime.length) out.push(`${noTime.length} pair segment(s) have no start time`);
  }
  if (c.overlap != null && (!isObj(c.overlap) || !finite(c.overlap.start) || !finite(c.overlap.end))) out.push("pair overlap must be {start, end} in seconds");
  return out;
}

const pad2 = (n) => String(n).padStart(2, "0");
const clock = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}` : `${Math.floor(s / 60)}:${pad2(s % 60)}`;
};

// What a reviewer reads, as plain text (search index, stand-in brief).
export function pairText(c) {
  const sides = Array.isArray(c.sides) ? c.sides : [];
  const head = sides.filter(isObj).map((s) => `${s.label || s.id}${s.note ? ` (${s.note})` : ""}${finite(s.duration_s) ? `, ${Math.round(Number(s.duration_s))}s` : ""}`).join(" | ");
  const lines = (Array.isArray(c.segments) ? c.segments : [])
    .filter((s) => isObj(s) && String(s.text || "").trim())
    .slice()
    .sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0))
    .map((s) => `[${clock(s.start)}] ${s.side} · ${s.is_user ? "You" : s.name || s.speaker || "Speaker"}: ${String(s.text).replace(/\s+/g, " ").trim()}`);
  return [head, ...lines].filter(Boolean).join("\n");
}

/* ---------- converter: transcript (DIVIDER convention) -> pair ---------- */

// "lasts 0m 34s", "lasts 1h 05m 12s", "lasts 2h", "lasts 45s"
function parseLasts(text) {
  const m = /lasts\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i.exec(String(text || ""));
  if (!m || (m[1] == null && m[2] == null && m[3] == null)) return null;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}
// "starts 09:23:00 UTC" -> seconds since midnight UTC
function parseStarts(text) {
  const m = /starts\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(UTC|Z)?/i.exec(String(text || ""));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : null;
}

const DIVIDER_RE = /^(?:━+\s*)?(.+?)\s*$/;
const SIDE_NAME_RE = /^\s*([A-Za-z0-9]+)\s*·\s*(.*)$/;

// Turn a transcript item that follows the two-capture convention into a pair
// item. Keeps every other key (id, stratum, title, meta, summary, hidden,
// truncated, url, media, context, round). Returns null when the item does not
// follow the convention (not a transcript, or not exactly two sides).
export function transcriptToPair(item) {
  if (!isObj(item) || !isObj(item.content) || item.content.type !== "transcript" || !Array.isArray(item.content.segments)) return null;
  const segs = item.content.segments;
  const sides = [];
  const byLetter = new Map();
  // Dividers name the sides in order ("━━ Capture A") and carry each side's
  // start on the shared axis and its length.
  for (const s of segs) {
    if (!isObj(s) || s.speaker !== "DIVIDER") continue;
    const label = (DIVIDER_RE.exec(String(s.name || "")) || [])[1] || String(s.name || "");
    const letter = (/([A-Za-z0-9]+)\s*$/.exec(label) || [])[1];
    if (!letter || byLetter.has(letter)) continue;
    const side = { id: letter, label };
    if (finite(s.start)) side.start = Number(s.start);
    const dur = parseLasts(s.text);
    if (dur != null) side.duration_s = dur;
    side.__clock = parseStarts(s.text);
    byLetter.set(letter, side);
    sides.push(side);
  }
  const out = [];
  for (const s of segs) {
    if (!isObj(s) || s.speaker === "DIVIDER") continue;
    const m = SIDE_NAME_RE.exec(String(s.name || ""));
    let letter = m ? m[1] : (/^([A-Za-z0-9]+)_/.exec(String(s.speaker || "")) || [])[1];
    if (!letter) return null;
    if (!byLetter.has(letter)) { const side = { id: letter, label: `Side ${letter}` }; byLetter.set(letter, side); sides.push(side); }
    const seg = { side: letter };
    if (s.speaker != null) seg.speaker = s.speaker;
    const name = m ? m[2].trim() : s.name;
    if (name) seg.name = name;
    seg.is_user = Boolean(s.is_user);
    if (finite(s.start)) seg.start = Number(s.start);
    if (finite(s.end)) seg.end = Number(s.end);
    seg.text = String(s.text ?? "");
    for (const k of Object.keys(s)) if (!(k in seg) && !["name", "speaker", "is_user", "start", "end", "text"].includes(k)) seg[k] = s[k];
    out.push(seg);
  }
  if (sides.length !== 2) return null;
  // Absolute start times: anchor on meta.started_at when its clock matches one
  // side's "starts HH:MM:SS"; the other side follows from the shared axis.
  const anchorMs = Date.parse(String(item.meta?.started_at || "").replace(" ", "T"));
  if (Number.isFinite(anchorMs)) {
    const d = new Date(anchorMs);
    const clockUtc = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
    const anchor = sides.find((s) => s.__clock != null && Math.abs(s.__clock - clockUtc) <= 1 && finite(s.start));
    if (anchor) {
      const zero = anchorMs - Number(anchor.start) * 1000;
      for (const s of sides) if (finite(s.start)) s.started_at = new Date(Math.round((zero + Number(s.start) * 1000) / 1000) * 1000).toISOString();
    }
  }
  for (const s of sides) delete s.__clock;
  const { content, ...rest } = item;
  const pair = { type: "pair", sides, segments: out };
  // Keep any extra content keys the source carried (besides type/segments).
  for (const k of Object.keys(content)) if (!["type", "segments"].includes(k)) pair[k] = content[k];
  return { ...rest, content: pair };
}
