---
name: decision-mill
description: Put a human in the loop efficiently with decision-mill's local web UI. Use spec mode to get product/technical decisions adjudicated in markdown specs; use label mode when a human must judge or label many items (conversations, model outputs, notifications) to measure models, calibrate a threshold, or seed model stand-in labels. Covers building task.yaml/items.jsonl, launching (incl. Tailscale), and reading labels and agreement back.
---

# decision-mill

One local server (`tools/spec-review/server.js`, Node or Bun, no build) with two modes
sharing one UI and keyboard model. Formats: `FORMAT.md` (specs), `LABELS.md`
(labels). Design rationale: `docs/design-notes.md`.

## Pick the mode

- **Spec mode** — the human must *decide* design questions (keep / change / defer /
  unify) and the answer is an instruction for coding agents. Write specs per
  `FORMAT.md`; follow `PLAYBOOK.md`. For a register whose verdicts are not
  keep/change (e.g. flags: graduate / extend / kill), use `DEC-<CAP>-NNN` items and a
  `decision-mill.yaml` in the specs directory with `instructions:` and `decisions:`
  (see "Spec mode with your own verdicts" below).
- **Label mode** — the *same question* is asked of many items and the answer is a
  judgment (keep/noise, useful/annoying, correct/wrong). Use it to measure a model,
  pick a threshold, or produce a labeled set. Under ~50 items, just ask in chat.

## Build a label task (outside git)

Put it at `~/.local/share/labels/<task-id>/` (never inside a repository — label data
is personal): `task.yaml`, `items.jsonl`, optional `media/`. Exact schema in
`LABELS.md`; the fictional `examples/labels/demo-task/` is a working template.

Rules that matter (each came from a real labeling session):

1. **Blind by default.** Leave `blind: true`. Put every model answer and score under
   `hidden`, never in `meta` or `title` (those are always shown). The `stratum` is
   hidden while blind, so it may encode model answers.
2. **Full context, not snippets.** Give the whole transcript (`content.segments` with
   `speaker`, `is_user`, `start`, `text`), the app `summary`, and `context[]`
   neighbors (before/after/overlapping, with their own summary or segments). If an
   item must be cut, set `truncated: true`. Add `media[]` audio when the question
   depends on what was actually said. When the reviewer judges a **proposed edit**
   (should a verifier accept this change?), use `content.type: proposal`: `change`
   with `before`/`after` (or `fields`), `evidence[]` records with human titles and
   `cited` segments, `highlight`, and `policy` with `policy_focus`. The card shows an
   inline diff first; never paste the edit and its evidence as JSON in markdown.
3. **Fewer labels: waves.** When a model stand-in can plausibly infer the human's
   labels, set `waves: {count: 3, size: 20}` (see "Waves" below) instead of rounds.
   Otherwise use **rounds of 20–50, stratified across the model score range.** Set `round_size`
   and give each item a `stratum` (e.g. score bands `p_00_20`…`p_80_100`, or
   disagreement classes like `jev_keep_nano_discard`). `stratify: balanced` covers the
   range every round; add a `random` stratum (or `stratify: proportional`) when you
   need unbiased rates. Pin hand-picked waves with `round: 1`, `round: 2`.
4. **Unsure is always available** and excluded from agreement. Do not force a guess.
5. **Models**: list each under `models` with `verdict_path` (values = label ids)
   and, for scored models, `score_path`, `threshold`, and **`positive_label`** (which
   label a high score means) so Results can draw the threshold curve.
6. **Content only an agent can read** (a connector on the reviewer's account): ship
   the task with a `pending:` note and an empty `items.jsonl` (shown as *waiting for
   items*; remove the note once items land — `validate.js` warns until you do), fetch in a headless session, copy results with `harvest.js`, and build
   items from disk. Never route that content through your own replies. See
   `LABELS.md#items-an-agent-must-fetch`.
7. Validate before handing it over:
   `node tools/spec-review/validate.js --labels <root>` (or with `LABELS_ROOT`).

## Launch

```sh
cd tools/spec-review && npm install            # once
node server.js --labels ~/.local/share/labels --port 4610
# spec mode: SPECS_DIR=/path/to/specs node server.js --port 4601
```

Evidence in several repositories: `LOCATOR_ROOTS="app=/src/app,kb=/src/kb"` (or
`locator_roots:` in the set's `decision-mill.yaml`). Read the startup banner: it
lists each set's vocabulary, every locator root (MISSING if absent) and the URLs.

Bind stays on 127.0.0.1. For a human on another machine, proxy it on the tailnet:
`tailscale serve --bg --https=4610 http://127.0.0.1:4610` (off:
`tailscale serve --https=4610 off`). Leave `REVIEWER` unset to attribute labels by
the `Tailscale-User-Login` header, or set `REVIEWER=<name>` for a single person.
Start on a non-default port, record the PID, and stop it by PID when done.

Tell the human: the URL, the task name, round or wave size and rough time ("20
cards, ~6 min"), and that keys are on the buttons (`1/2/3`, `s` skip, `u` undo,
`n` note, `i` instructions, `?` help).

## Spec mode with your own verdicts

Put `decision-mill.yaml` next to the spec files (fictional template:
`examples/decision-register/`):

```yaml
instructions: |            # markdown; opens on the reviewer's first visit, `i` toggles
  What each card is, and what each verdict commits to.
decisions:                 # replaces Keep/Change/Defer/Unify; keys 1..9 in this order
  - {id: graduate, label: Graduate, hint: "delete the flag; ship the new path", tone: positive}
  - {id: extend, label: Extend, hint: "keep the flag; say until when", requires_detail: true}
  - {id: change, label: Change}    # change keeps its remove:/change: prefix rule
  - {id: defer}                    # defer keeps the item open
```

The stored `decision` is the button id. The item's text box is an answer box: typing
there and pressing ⌘/Ctrl+Enter records the `custom: true` verdict (default `change`)
with the text as its detail; the verdict keys take the text along as the reason, and
Shift+⌘/Ctrl+Enter saves a plain note. Tell the reviewer this. Validate with `node tools/spec-review/validate.js
--locators` (it also checks the yaml and warns on a `<CAP>` code reused across files).

## Waiting for the human (never poll)

Hand the human the URL, then block on a background waiter that exits on every
terminal state — 0 satisfied, 2 timeout, 1 server error/unreachable/impossible:

```sh
# spec mode: all-decided | no-open | decided:N | change   (--spec SLUG to scope it)
node tools/spec-review/wait.js --url http://127.0.0.1:4601 --until all-decided --timeout 3h
# label mode: wave-ready | round-done | labeled:N | done | change
node tools/spec-review/labels.js wait <task> --url http://127.0.0.1:4610 --until wave-ready --timeout 3h
```

Run it with your harness's background-command facility and a hard timeout above
`--timeout`. Quote `'labeled>=N'` in a shell, or use `labeled:N`.

## Waves: the between-wave procedure (you are the stand-in)

Wave 1 freezes itself when the human opens the task. When they finish a wave the UI
says the agent is inferring; that is you. Do not poll for that moment: after telling
the human a wave is ready, run `labels.js wait <task> --url … --until wave-ready
--timeout 3h` in the background; it exits 0 when the wave is labeled. Each time:

1. `node tools/spec-review/labels.js waves <task>` — state must be `inferring`.
2. `node tools/spec-review/labels.js infer-prompt <task> --out <scratch>/brief.md` and
   read all of it: the human's labels and notes, the label mix they actually use, your
   earlier predictions they overruled, and every unlabeled item (no model answers).
3. Write a short rubric citing example ids, then one JSON line per unlabeled item:
   `{"item_id", "label", "confidence", "rationale"}`. `confidence` = probability the
   human picks exactly that label; be calibrated (low-confidence items become the
   next wave; the last wave is a random check of you). Do not predict a label the
   human never uses.
4. `node tools/spec-review/labels.js import-standin <task> <file> --model <your-model-id>`
   (all-or-nothing; refuses the human's file).
5. `node tools/spec-review/labels.js next-wave <task> --dry-run`, check reasons and
   strata, then run it without `--dry-run`. The UI shows the new wave within 15 s.
6. Tell the human the wave is ready, and start the `wait --until wave-ready` waiter
   again. After the last wave, report the **hold-out**
   agreement with n and interval against the `accept` bar; if it is `rejected`,
   report human-only numbers only (optionally re-infer and `next-wave --extra`).

Never re-score a targeted wave after refitting on it, never write human rows, and
never edit or delete label or wave files.

## Model stand-in labels without waves

In rounds mode you can still label the remaining items yourself and write them as
stand-ins through the server (it serializes writes with the human's clicks):

```sh
curl -s -X POST localhost:4610/api/task/<id>/labels -H 'content-type: application/json' \
  -d '{"reviewer":"opus-standin","labels":[{"item_id":"…","label":"keep","confidence":0.8,"rationale":"…"}]}'
```

Stand-in rows are always `source: model-standin`. **Human labels outrank them**:
Results grade the stand-in against human labels only ("Can the stand-in replace
you?"), and use stand-ins as truth only when the human toggles fill. Never write
human rows yourself, and never edit or delete label files — they are append-only
(an undo is a `"label": null` row).

## Read labels back

```sh
node tools/spec-review/labels.js stats <task-dir|id> [--reviewer david] [--json]
node tools/spec-review/labels.js export <task-dir|id> --source human [--format csv]
curl -s localhost:4610/api/task/<id>/results          # same payload as the Results tab
```

`stats` gives labeled counts, each model's (and stand-in's) agreement with a 95%
Wilson interval, confusion counts, per-stratum agreement, the threshold sweep, and a
plain usefulness read. Report agreement **with n and the interval**, call samples
under ~25 directional, and look at the disagreement list before recommending a
threshold — the disagreements are where the decision is.

## Privacy

Label tasks, labels and media never go into git or into a PR, issue or knowledge
base page; quote aggregates, not content. The only task in this repository is
fictional.

## Speaker truth

Use label mode with `kind: speakers` for diarization truth. Keep the voice-group
`items.jsonl`, `conversations.json` word timing and segment membership, and private
`hidden/systems.json` format documented in `LABELS.md#speaker-mode`. Follow the
fictional `examples/labels/speaker-demo/` template. People are created from label
rows; group judgments propagate by duration-weighted embedding similarity within
a conversation. Segment corrections override groups; blind purity audits are
independent. Suggestions require explicit acceptance and carry
`source: suggested-accepted`. Results and `labels.js stats` export `build/truth.json`
and report optimal 1:1 and many-to-one word accuracy, speaker counts and purity
intervals. Never expose system predictions before Results. Use AAC fast-start m4a
and test byte Range playback through the intended proxy.
