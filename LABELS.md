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
| `labels[].key` | Keyboard key. Missing keys get the next free digit. `j k u n e / ? space` are reserved by the shared keyboard model and refused. |
| `labels[].tone` | `positive` / `negative` / `neutral` / `abstain` — only colors the button, dots and charts. |
| `labels[].abstain` | Marks an abstention. A label with id `unsure` is one automatically. |
| Unsure | **Always available.** If no abstaining label is listed, `{id: unsure, label: Unsure}` is appended. Unsure labels are excluded from agreement. |
| `fields[].type` | `checkbox` (optional `key` toggles it), `choice` (`options`), or `text`. |
| `blind` | While true, an item's `hidden` and `stratum` are withheld **by the server** until this reviewer has labeled it. After labeling, model answers appear collapsed under the card and in Results. |
| `round_size`, `stratify` | See [Rounds](#rounds). |
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
| `meta` | no | Shown as chips on the card. **Always visible, even when blind — never put model output here.** `started_at`, `duration_s`, `word_count`, `source` are formatted; other scalar keys show as `key: value`. |
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

## Reading labels back

Without the server (`tools/spec-review/labels.js`):

```sh
node labels.js tasks                                   # every task under LABELS_ROOT
node labels.js stats ~/.local/share/labels/<task>      # agreement, per stratum, curves
node labels.js stats <task> --reviewer david --json    # the Results payload as JSON
node labels.js export <task> --source human            # latest label per item, JSONL
node labels.js export <task> --format csv
```

Through the server (also how agents **write** stand-in labels — the server's
per-file queue serializes them with the reviewer's clicks):

| Endpoint | Purpose |
| -------- | ------- |
| `GET /api/tasks` | Tasks with this reviewer's progress. |
| `GET /api/task/<id>/labels[?reviewer=&source=]` | Every reviewer's latest labels. |
| `GET /api/task/<id>/results[?reviewer=&fill=1]` | What the Results view shows. |
| `POST /api/task/<id>/labels` | Batch of stand-in rows: `{"reviewer": "opus-standin", "labels": [{"item_id", "label", "fields"?, "note"?, "confidence"?, "rationale"?}]}`. Always `model-standin`; all-or-nothing validation. |
| `POST /api/task/<id>/label` | One row (what the UI sends). With `"source": "model-standin"` and a `reviewer`, a single stand-in row. |
| `POST /api/task/<id>/undo` | `{"item_id"}` → appends `"label": null`. |

Writes must be `content-type: application/json`.

## Validation

`node tools/spec-review/validate.js` checks every task under the configured roots
alongside the specs: task.yaml structure, duplicate or reserved keys, items that do
not parse, duplicate ids, unknown content types, model verdicts that are not label
ids, media paths outside `media/`, and unparseable label rows.
