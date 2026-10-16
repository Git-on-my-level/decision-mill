# Label task format (v1)

The contract between whoever builds a labeling dataset (usually an agent), the
review UI's **label mode** (`tools/spec-review`), and whoever reads the labels back.
Like spec mode, **the files are the source of truth**: the UI appends rows, agents
read the files (or the API), and nothing else holds state.

Label data is personal by nature — transcripts, judgments, notes. **It never lives
in git.** Keep tasks under `~/.local/share/labels/` (or any path outside a
repository) and point the server at that root. The bundled tasks under `examples/labels/` are fictional.

```
~/.local/share/labels/            # a labels root (LABELS_ROOT / --labels)
  <task-id>/                      # one task; the directory name is its URL id
    task.yaml                     # what is asked, the buttons, blind mode, models
    items.jsonl                   # one item per line
    labels/<reviewer>.jsonl       # append-only; latest row per item wins
    media/                        # optional audio/images referenced by items
    waves/wave-<n>.json           # waves mode only: frozen waves (never rewritten)
```

A labels root may also itself be a task directory.

## task.yaml

```yaml
id: jev-vs-nano-2026-10            # optional; the directory name wins if they differ
title: Jev vs nano — would you keep this conversation?
question: Would you want this conversation kept in your Omi?
instructions: |                    # markdown, collapsible above the card
  Keep anything with a task, a name, a plan, a number, or a fact about you…
labels:                            # single-choice verdict; one key each
  - {id: keep,   label: Keep,   key: "1", tone: positive}
  - {id: noise,  label: Noise,  key: "2", tone: negative}
  - {id: unsure, label: Unsure, key: "3"}
fields:                            # optional extra answers per item
  - {id: wants_memory, type: checkbox, label: Should have produced a memory or task, key: m}
  - {id: owner, type: choice, label: Whose fact, options: [mine, someone_else, general]}
  - {id: why, type: text, label: Why}
blind: true                        # default true
round_size: 40                     # default 40
stratify: balanced                 # balanced (default) | proportional
summary: collapsed                 # collapsed (default) | open
user_label: You                    # how is_user segments are labeled (default "You")
meta_display: [started_at, duration_s, word_count]   # meta keys shown on the card (default below)
pending: |                         # optional: shown while items.jsonl is empty or missing
  Items are built by `fetch.sh` on the build host; reload when it finishes.
waves: {count: 3, size: 20}        # optional: label in frozen waves instead of rounds (see Waves)
models:                            # how Results compares each model with the human
  - id: jev
    score_path: hidden.jev.p_discard   # optional: enables the threshold curve
    verdict_path: hidden.jev.verdict   # optional if score_path+threshold+positive_label
    threshold: 0.95
    positive_label: noise              # which label a HIGH score means — set it
    negative_label: keep               # optional: lets a score alone produce a verdict
  - id: nano
    verdict_path: hidden.nano.verdict
```

| Key | Meaning |
| --- | ------- |
| `labels[].key` | Keyboard key. Missing keys get the next free digit. `j k u n e / ? space` are reserved by the shared keyboard model and refused. `s` (skip for now) and `i` (instructions) work unless a task binds them. |
| `labels[].tone` | `positive` / `negative` / `neutral` / `abstain` — only colors the button, dots and charts. |
| `labels[].abstain` | Marks an abstention. A label with id `unsure` is one automatically. |
| Unsure | **Always available.** If no abstaining label is listed, `{id: unsure, label: Unsure}` is appended. Unsure labels are excluded from agreement. |
| `fields[].type` | `checkbox` (optional `key` toggles it), `choice` (`options`), or `text`. |
| `blind` | While true, an item's `hidden` and `stratum` are withheld **by the server** until this reviewer has labeled it. After labeling, model answers appear collapsed under the card and in Results. |
| `round_size`, `stratify` | See [Rounds](#rounds). Ignored when `waves` is set. |
| `meta_display` | Which `item.meta` keys the card shows, in order. Default `[started_at, duration_s, word_count, source]`; other keys stay hidden. Timestamps (`*_at`, any ISO string) are shown as dates, `*_s` as durations, `word_count` as "N words"; a chip whose content the title already shows is dropped. |
| `waves` | Label in a few frozen waves, with a model stand-in inferring the rest. See [Waves](#waves). |
| `pending` | Markdown shown in place of the card while `items.jsonl` is empty or missing. An empty task is a normal **waiting for items** state, never an error; say who runs what to fill it. |
| `models[].score_path`, `verdict_path` | Dotted paths into each item (usually under `hidden`). Verdicts must use label ids. |
| `models[].positive_label` | Required for the threshold curve unless it can be inferred (the model's most common verdict at or above its threshold). Set it explicitly. |

## items.jsonl

One JSON object per line:

```json
{"id": "conv-uuid", "stratum": "nano_discard_jev_keep",
 "title": "…",
 "meta": {"started_at": "2026-09-20T14:03:00Z", "duration_s": 74, "source": "omi", "word_count": 41},
 "content": {"type": "transcript", "segments": [
   {"speaker": "SPEAKER_1", "is_user": true, "start": 0.0, "text": "…"}]},
 "summary": "optional app summary text",
 "context": [{"relation": "before", "gap_min": 6, "title": "…", "summary": "…", "segments": [ … ]}],
 "media": [{"type": "audio", "src": "media/conv-uuid.m4a", "label": "Pendant audio"}],
 "hidden": {"jev": {"p_discard": 0.91, "verdict": "keep"}, "nano": {"verdict": "noise", "reason": "model_discard"}}}
```

| Key | Required | Meaning |
| --- | -------- | ------- |
| `id` | yes | Unique string. Labels reference it forever; never reuse one. |
| `content` | yes | `{"type": "transcript", "segments": [...]}`, `{"type": "markdown", "body": "…"}`, `{"type": "text", "body": "…"}`, or `{"type": "proposal", …}` (a proposed edit to judge; see [Proposal items](#proposal-items)). |
| `segments[]` | — | `speaker`, `is_user` (styled as the reviewer), `start` seconds (shown as a timestamp; clickable when audio exists), `text`, optional `name` (display name). |
| `title` | no | Shown above the content. |
| `meta` | no | Shown as chips on the card (only the keys in `meta_display`). **Always visible, even when blind — never put model output here.** |
| `summary` | no | Collapsed by default, labeled as model-written (a summary can make a fragment look meaningful). |
| `context[]` | no | Neighboring items so the reviewer is not judging a snippet. `relation` is `before` / `after` / `overlapping`, `gap_min` minutes, `title`, `summary`, and optionally `segments` or `content` (expandable). |
| `media[]` | no | `{"type": "audio" \| "image", "src": "media/…", "label"}`. `src` must be inside the task's `media/` directory. Audio is served with Range support. |
| `stratum` | no | Sampling bucket (e.g. a model-score band or a disagreement class). Hidden while blind because it usually encodes the answer. Name a stratum `random` for an unbiased sample. |
| `round` | no | Pins the item to an explicit round (a number). See below. |
| `truncated` | no | `true` marks an excerpt; the card says so. Prefer whole items. |
| `hidden` | no | Model answers and scores, referenced by `models[].*_path`. |

## Proposal items

Use `content.type: proposal` when the reviewer judges a **proposed edit**: should a
verifier, a model or a teammate's change be accepted, given some evidence and some
rules? Never paste the edit and its evidence as JSON into a markdown body; the
card turns this structure into something a person can judge in seconds:

1. **The change** first, as one readable line with an inline diff:
   `Title  ~~Kiln packing notes~~ → Mirexu kiln shipping checklist`. Deleted words are
   red and struck, inserted words green and underlined (never color alone); a
   one-word spelling change also shows a letter diff, `Mirex[ah→u]`. An empty
   `before` reads "(new)", an empty `after` "(removed)". Long values become one
   sentence with the edits inline.
2. **The evidence**, one card per record, with the old and new values marked
   wherever they appear, the cited transcript part as speech bubbles, and the raw
   record behind a folded "raw" toggle.
3. **The policy**, folded to "Policy (n rules)", one rule per sentence; rules
   matching `policy_focus` stay visible under it.

The question goes in the verdict bar, once.

```json
{"id": "review-01", "title": "Proposal review 01",
 "content": {"type": "proposal",
   "question": "Should the verifier accept this edit?",
   "change": {"kind": "Spelling", "target": "conversations/c1#s1",
              "before": "Mirexah", "after": "Mirexu", "raw": {"kind": "spelling", "operation": {}}},
   "evidence": [{"title": "Conversation · Sep 10 · 10:00–10:10 UTC", "tag": "Target", "ref": "conversations/c1",
                 "segments": [{"id": "s1", "is_user": true, "start": 0, "text": "Please send the tray to Mirexah."}],
                 "cited": ["s1"], "facts": {"Title": "Kiln notes"}, "raw": {}}],
   "highlight": ["Mirexah", "Mirexu"],
   "policy": "Agree only with directly supported facts. Missing evidence is insufficient.",
   "policy_focus": ["directly supported"]},
 "hidden": {"gold": {"verdict": "reject"}}}
```

| Key | Meaning |
| --- | ------- |
| `change.kind` | Short label for the kind of edit (`Title`, `Spelling`, `Merge conversations`). |
| `change.before`, `change.after` | The old and new value. Strings get a word diff; other values are shown as compact JSON. |
| `change.summary` | One line for a change that is not a value replacement ("Merge these two conversations into one"). |
| `change.fields` | `[{name, before, after}]` for a multi-field change, shown as a table. Differing rows come first; matching rows fold into one "Same on both" line. Values may be any JSON. |
| `change.before_label`, `after_label` | Column headings for `fields` (default Before / After). |
| `change.compare` | `true` when `fields` compares two records side by side (two conversations, two memories) rather than old → new: differences are marked on both sides instead of struck. |
| `change.notes` | Short factual lines under the change, e.g. a computed overlap. |
| `change.target`, `change.raw` | The edited record's id, and the raw proposal (folded). |
| `evidence[]` | `title` (required, human: "Conversation · 10:00–10:10 · 'title'"), `tag` (a chip such as Target / Other / Cited), `ref`, `segments` (transcript segments, rendered like a transcript), `cited` (segment ids shown first; the rest fold away), `text`, `facts` (`{name: value}` or `[{name, value}]`; null shows "— missing"), `raw` (folded). |
| `highlight` | Terms to mark in the evidence, as strings or `{text, side: before\|after}`. Default: the change's `before` and `after` strings. |
| `policy` | Rules text (split into sentences) or a list of rules. |
| `policy_focus` | Snippets; rules containing one are highlighted and shown while the policy is folded. Pick them per kind of edit, not per answer, so they never hint at the verdict. |
| `question` | Replaces the task's question in the verdict bar for this item. |

`examples/labels/proposal-demo/` is a fictional task with every shape (spelling,
title, CJK, a long rewrite, multi-field, a two-record comparison).

## labels/\<reviewer\>.jsonl

Append-only. One row per action; the file is the audit trail.

```json
{"item_id": "conv-uuid", "label": "keep", "fields": {"wants_memory": true}, "note": "…",
 "reviewer": "david", "source": "human", "at": "2026-10-04T10:31:07.221Z"}
```

Folding rules (`lib/labelstore.js`, latest row wins):

- A row **with a `label` key** sets the item's label and its full field set.
  `"label": null` is an **undo**: the item is unlabeled again and its fields clear.
- A row **without a `label` key** changes only what it carries: `note` replaces the
  note, `fields` merge into the current fields. (The UI writes these when a note or
  field is edited on an already-labeled item.)
- Unparseable lines (for example a line torn by a crash) are skipped and counted,
  never fatal. `validate.js` reports them.

| Key | Meaning |
| --- | ------- |
| `source` | `human` (a person clicked) or `model-standin` (an agent's inferred label). |
| `reviewer` | Also the file name, sanitized to `[A-Za-z0-9._@+-]`. |
| `confidence`, `rationale`, `model` | Optional, `model-standin` rows only. |

**Human labels outrank stand-ins.** Results use the reviewer's human label as truth;
stand-in labels only fill gaps when the reviewer turns "fill" on, and a stand-in is
graded against human labels only — never against filled ones.

Who is the reviewer: an explicit `REVIEWER` env / `--reviewer` wins; otherwise the
`Tailscale-User-Login` header that `tailscale serve` adds; otherwise `reviewer`.
Human rows are always attributed by the server; a client cannot claim another name.

## Rounds

Rounds turn a big pile into sittings of `round_size` cards, each spread across
`stratum`:

- `balanced` (default): round-robin over strata, so every round covers the whole
  model-score range until a stratum runs out.
- `proportional`: each stratum appears in proportion to its size (unbiased rates).
- Items with an explicit `round` come first, grouped by that number, in file order.

The order is a pure function of the task id, item ids and strata, so rounds are
**resumable without stored state**: the current round is the first one with an item
this reviewer has not labeled. Adding items reshuffles unlabeled rounds; pin items
with `round` if a sitting must stay fixed.

## Waves

Waves label **fewer items**: the human labels a few small waves, and between waves an
agent infers labels for everything else from the human's labels. A task uses waves
when `waves:` is set; otherwise it uses rounds.

```yaml
waves:
  count: 3                 # planned waves (default 3)
  size: 20                 # cards per wave (default 20)
  standin: opus-standin    # the stand-in's reviewer name / label file (default)
  accept: 0.85             # bar for the hold-out wave, set before any label (default 0.85)
  first:                   # wave 1
    strategy: stratified   # stratified (default) | proportional | random
    quota: {nano_discard_jev_discard: 3}       # exact counts per stratum (globs allowed)
    weights: {"nano_discard_jev_keep*": 2}     # relative share for strata without a quota (default 1)
  middle: {uncertain: 0.6, disagree: 0.2, coverage: 0.2}   # waves 2..count-1 (fractions)
  last: random             # random (default: an honest hold-out) | targeted
  group_by: meta.topic     # optional: at most one item per group in random waves
  reviewer: david          # optional: whose labels the waves are for (default: the human with most labels)
  seed: any-string         # optional (default: the task id)
```

| Wave | How it is picked |
| ---- | ---------------- |
| 1 | `stratified`: every stratum, by `quota` then `weights` (D'Hondt), spread over the first scored model's range within a stratum. Human labels that already exist **count toward wave 1** and their stratum's share, so nothing is asked twice. |
| 2 … count−1 | Targeted, from the stand-in's labels: `uncertain` = lowest stand-in confidence (an `unsure` stand-in label or a missing one counts as 0); `disagree` = stand-in label differs from a model's verdict (most models first); `coverage` = the stratum × score-bin cell with the smallest human share. |
| count | `random`: a uniform sample of the items the stand-in labeled. Its agreement is the **hold-out** estimate of the stand-in's accuracy on the items it fills. |
| extra | `next-wave --extra` adds another random wave beyond `count` (for example after the hold-out missed the bar and the agent re-inferred). |

**Frozen means frozen.** `waves/wave-<n>.json` is created exclusively (temp file +
hard link; it fails if the wave exists) and never rewritten. Waves never contain a
labeled item or an item of an earlier wave; the current wave is the first frozen wave
with an item the human has not labeled, so waves resume from the files alone. The
server freezes wave 1 the first time the task is opened; the agent freezes the rest.

```json
{"wave": 2, "of": 3, "strategy": "targeted", "size": 20, "reviewer": "david",
 "standin": "opus-standin", "frozen_at": "2026-10-04T12:00:00.000Z",
 "committed_before_human_labels": true,
 "items": [{"id": "…", "reason": "uncertain",
            "prediction": {"label": "noise", "confidence": 0.55, "at": "…"}}]}
```

Each item's `prediction` is the stand-in's latest label **when the wave froze**,
before the human saw the item. Results grade the stand-in on those recorded
predictions, never on labels written after the human answered:

- **Hold-out** (random waves): agreement with a 95% Wilson interval, compared with
  `accept` → `accepted`, `rejected`, or `pending`. Rejected means: report human-only
  numbers; the combined ones are not trustworthy.
- **Targeted waves** are reported separately: they were picked for being hard, so they
  understate accuracy. Calibration (accuracy at confidence ≥0.8 / 0.6–0.8 / <0.6) and
  predicted-vs-human label mix (a leniency check) come with it.
- **Final labels** = the human's label where there is one (authoritative), else the
  task stand-in's. Each model's agreement is shown on **human-only** labels and on the
  **combined** set, side by side (`labels.js export <task> --final` writes the set).

### The agent's loop between waves

The tool holds no model key; the agent does the inferring.

```sh
node labels.js waves <task>                              # state must be "inferring"
node labels.js infer-prompt <task> --out /tmp/brief.md  # the human's labels + notes, every unlabeled item
# read the brief, write one JSON line per unlabeled item:
#   {"item_id": "…", "label": "keep", "confidence": 0.7, "rationale": "…"}
node labels.js import-standin <task> standin.jsonl --model <model-id>
node labels.js next-wave <task> --dry-run                # check strata and reasons
node labels.js next-wave <task>                          # freeze it; the UI picks it up within 15 s
```

The brief never contains model answers or strata (the stand-in judges what the human
saw) and lists the stand-in's earlier predictions the human overruled.
`import-standin` is all-or-nothing, skips items the human already labeled, appends
only to the stand-in's own file, and refuses a file that holds human rows.
`next-wave` refuses while the previous wave has unlabeled items (`--early`), while an
unlabeled item has no stand-in label (`--allow-missing`), or while stand-in labels
predate the human's latest label (`--allow-stale`).

## Items an agent must fetch

Sometimes the content of an item can only be read by an agent: an MCP connector on
the reviewer's own account, a tool behind the agent's auth. Keep that content out of
the agent's replies and context, and make the task rebuildable:

1. **Ship the task first.** Write `task.yaml` with a `pending:` note and an empty
   `items.jsonl`. The UI shows *waiting for items*, not an error, so the reviewer can
   open the link before the data lands.
2. **Fetch in a session whose transcript you keep.** A headless run is simplest:
   `claude -p --session-id <uuid> --allowedTools "<exact tool>" < prompt.md`. Allow only
   the read tool, and tell it to make the calls and not to quote or summarize content.
   Note that `--allowedTools` takes a list, so pass the prompt on stdin.
3. **Harvest mechanically.** `node tools/spec-review/harvest.js --tool '<regex>'
   <session.jsonl|dir>... > raw.jsonl` copies each matching tool result verbatim,
   including results Claude Code spilled to `tool-results/` files. Harvest *every*
   session that fetched data, not only the latest.
4. **Build items from disk** with a script that prints counts only, and writes
   `items.jsonl` by temp file plus rename. Keep a list of ids still missing, and
   rerun fetch, harvest and build until it stops shrinking.
5. **Expect partial batches.** Bulk read tools often truncate a response once it hits
   a size budget and silently drop the later items. Use small batches, lower the
   per-item size cap for stragglers, and treat ids the source reports as not found
   as gone, not as failures to retry forever.

## Reading labels back

Without the server (`tools/spec-review/labels.js`):

```sh
node labels.js tasks                                   # every task under LABELS_ROOT
node labels.js stats ~/.local/share/labels/<task>      # agreement, per stratum, curves
node labels.js stats <task> --reviewer david --json    # the Results payload as JSON
node labels.js export <task> --source human            # latest label per item, JSONL
node labels.js export <task> --format csv
node labels.js export <task> --final                   # waves: human label, else the stand-in's
node labels.js waves <task> [--json]                   # waves: status, hold-out, final labels
```

Through the server (also how agents **write** stand-in labels — the server's
per-file queue serializes them with the reviewer's clicks):

| Endpoint | Purpose |
| -------- | ------- |
| `GET /api/tasks` | Tasks with this reviewer's progress. |
| `GET /api/task/<id>/labels[?reviewer=&source=]` | Every reviewer's latest labels. |
| `GET /api/task/<id>/results[?reviewer=&fill=1]` | What the Results view shows (with a `waves` block in waves mode). |
| `POST /api/task/<id>/labels` | Batch of stand-in rows: `{"reviewer": "opus-standin", "labels": [{"item_id", "label", "fields"?, "note"?, "confidence"?, "rationale"?}]}`. Always `model-standin`; all-or-nothing validation. |
| `POST /api/task/<id>/label` | One row (what the UI sends). With `"source": "model-standin"` and a `reviewer`, a single stand-in row. |
| `POST /api/task/<id>/undo` | `{"item_id"}` → appends `"label": null`. |

Writes must be `content-type: application/json`.

## Validation

`node tools/spec-review/validate.js` checks every task under the configured roots
alongside the specs: task.yaml structure, duplicate or reserved keys, items that do
not parse, duplicate ids, unknown content types, malformed proposal content, model verdicts that are not label
ids, media paths outside `media/`, unparseable label rows, and wave files that do not
parse, skip a number, or put an item in two waves.

## Speaker mode

Set `kind: speakers` for diarization truth. `labels:` is unnecessary: **You** is
built in, people are added by typing, and **Mixed**, **Not speech / noise**, and
**Unsure** are always available. Names persist in label rows; the roster autocompletes
names used across this task's conversations. Number keys follow roster order.

```yaml
kind: speakers
suggest_threshold: 0.45          # cosine distance, strictly below this bar
audit: {per_conversation: 15}   # optional; omit to use 15; set 0 to disable
```

The fictional
`examples/labels/speaker-demo/` includes a tiny AAC tone file. Generate it with:
`ffmpeg -f lavfi -i sine=frequency=440:duration=6 -c:a aac -b:a 24k -movflags +faststart media/fiction.m4a`.

Keep the existing real-task format:

- `items.jsonl`: one voice group, with `content: {type: speaker_group,
  conversation: "c", segments: ["c:s1"], representatives: ["c:s1"]}`,
  `centroid: [finite numbers]`, `meta: {clips: 1, duration_s: 2}` and optional media.
- `conversations.json`: an array with `id`, `title`, `date`, `duration_s`,
  `media: "media/c.m4a"`, `words: [[start,end,"word"]]`, and `segments` with
  `id`, `start`, `end`, `w0`, `w1`, `short`, `group` (group id or null), `text`.
  Word slices use **exclusive `w1`**. Segment ids must be globally unique and
  distinct from group ids. Group membership must match the conversation.
- `hidden/systems.json`: `{ "c": { "prod": ["speaker_0", null], ... } }`.
  Only Results reads this file. Label, Transcript, Audit, item APIs and media
  routes never reveal it, even after labeling a group.

Rows add `scope: group|segment|audit`; omitted scope defaults to group for group
ids and segment for segment ids at the HTTP boundary. Segment labels override group
labels. Undo appends null; an undone segment falls back to its group. Audit rows
fold independently under `audit:<segment-id>` and never change truth. They record
`audit_group_label`, captured by the server at labeling time, for an independent
purity comparison. The audit selects a stable pseudorandom sample per conversation,
shows no inherited label or suggestion, and reports a 95% Wilson interval. This
estimates segment agreement, not duration-weighted purity.

The queue puts unlabeled groups first, largest by clip count first. Space cycles
up to four representative clips, seeking shared audio and pausing at the clip end.
Mixed opens member clips for individual labels. Transcript has clickable words,
colored turns, speaker-chip segment corrections, a seekable timeline, speed and
follow-along. Conversation progress is person-labeled segment duration over total
segment duration. Special labels are excluded from speech truth.

After each write, duration-weighted averages of labeled group embeddings produce
per-person centroids **within each conversation**. Suggestions below the configured
cosine distance appear preselected; Enter accepts one. Bulk acceptance shows a
preview count and appends `source: suggested-accepted` rows. Direct clicks use
`source: human`; both count as reviewer judgments. Suggested rows remain auditable.
Ordinary label tasks with `centroid` also have Enter acceptance and a
"label similar items too" bulk action; their configured label vocabulary applies.
Suggestions never write automatically.

Results derives per-word truth from segment label, else group label, skipping
Mixed, Unsure and noise. Each system gets optimal one-to-one Hungarian matching,
many-to-one majority mapping, and found/true speaker counts. Missing system words
count as misses on labeled truth. The single-speaker baseline is shown alongside.
Results and `node tools/spec-review/labels.js stats <task> [--reviewer R] [--json]`
write `build/truth.json` as `{conversation_id: [person_or_null, ...]}`. This generated
export is reviewer-specific when a reviewer is supplied; otherwise CLI uses latest
human judgments across reviewers. Keep it outside git with the task.

Speaker endpoints: `GET /api/task/<id>/speakers` returns the queue, roster,
conversations, audit sample and suggestions; `GET /api/task/<id>/suggestions` works
for any embedding task. `POST .../suggestions` with `{ids:[...]}` accepts the current
confident predictions and rejects ids that are no longer eligible. `POST .../label`
and `.../undo` accept `scope`. Existing append-only files remain readable.

Audio streams from the media endpoint with `audio/mp4` for m4a, byte Range 206
responses (bounded, open-ended and suffix), and 416 for unsatisfiable ranges. Use
AAC in a fast-start m4a container to avoid a late metadata download on phones;
`ffmpeg -i input.m4a -c copy -movflags +faststart output.m4a` remuxes it. No whole-file
buffer is used by the server. All browser URLs remain relative for Tailscale HTTPS.
