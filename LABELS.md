# Label task format (v1)

The contract between whoever builds a labeling dataset (usually an agent), the
review UI's **label mode** (`tools/spec-review`), and whoever reads the labels back.
Like spec mode, **the files are the source of truth**: the UI appends rows, agents
read the files (or the API), and nothing else holds state.

Label data is personal by nature — transcripts, judgments, notes. **It never lives
in git.** Keep tasks under `~/.local/share/labels/` (or any path outside a
repository) and point the server at that root. The only task in this repository is
the fictional `examples/labels/demo-task/`.

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
| `content` | yes | `{"type": "transcript", "segments": [...]}`, `{"type": "markdown", "body": "…"}` or `{"type": "text", "body": "…"}`. |
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
not parse, duplicate ids, unknown content types, model verdicts that are not label
ids, media paths outside `media/`, unparseable label rows, and wave files that do not
parse, skip a number, or put an item in two waves.
