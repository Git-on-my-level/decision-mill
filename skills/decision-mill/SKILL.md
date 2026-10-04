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
  `FORMAT.md`; follow `PLAYBOOK.md`.
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
   depends on what was actually said.
3. **Rounds of 20–50, stratified across the model score range.** Set `round_size`
   and give each item a `stratum` (e.g. score bands `p_00_20`…`p_80_100`, or
   disagreement classes like `jev_keep_nano_discard`). `stratify: balanced` covers the
   range every round; add a `random` stratum (or `stratify: proportional`) when you
   need unbiased rates. Pin hand-picked waves with `round: 1`, `round: 2`.
4. **Unsure is always available** and excluded from agreement. Do not force a guess.
5. **Models**: list each under `models` with `verdict_path` (values = label ids)
   and, for scored models, `score_path`, `threshold`, and **`positive_label`** (which
   label a high score means) so Results can draw the threshold curve.
6. Validate before handing it over:
   `node tools/spec-review/validate.js --labels <root>` (or with `LABELS_ROOT`).

## Launch

```sh
cd tools/spec-review && npm install            # once
node server.js --labels ~/.local/share/labels --port 4610
# spec mode: SPECS_DIR=/path/to/specs node server.js --port 4601
```

Bind stays on 127.0.0.1. For a human on another machine, proxy it on the tailnet:
`tailscale serve --bg --https=4610 http://127.0.0.1:4610` (off:
`tailscale serve --https=4610 off`). Leave `REVIEWER` unset to attribute labels by
the `Tailscale-User-Login` header, or set `REVIEWER=<name>` for a single person.
Start on a non-default port, record the PID, and stop it by PID when done.

Tell the human: the URL, the task name, round size and rough time ("40 cards, ~10
min"), and that keys are on the buttons (`1/2/3`, `u` undo, `n` note, `?` help).

## Model stand-in labels

The "3 waves of 20, then infer the rest" pattern: after each human round, label the
remaining items yourself and write them as stand-ins through the server (it
serializes writes with the human's clicks):

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
