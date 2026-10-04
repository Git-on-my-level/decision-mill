# spec-review — the decision-mill UI

One local web UI with two modes over plain files:

- **Spec mode**: walk through capability specs, view the cited code, record
  decisions and notes. The spec markdown files remain the single source of truth
  (see [`FORMAT.md`](../../FORMAT.md)): every action writes back into their
  `adjudication` YAML blocks, so coding agents read the specs directly and never need
  this tool.
- **Label mode**: label items from a task directory, blind, in stratified rounds,
  and compare models and model stand-ins against the human (see
  [`LABELS.md`](../../LABELS.md)). Every action appends one row to
  `labels/<reviewer>.jsonl`.

Two dependencies (`js-yaml`, `marked`), no build step, binds to `127.0.0.1` by
default.

## Run

```sh
npm install       # or: bun install
node server.js    # bun server.js also works
# → http://127.0.0.1:4599
```

With no configuration it serves the repository's `specs/` directory (falling back to
the bundled `examples/specs/`) and the bundled `examples/labels/` demo task.

```sh
node server.js --labels ~/.local/share/labels --port 4610          # label mode only
SPECS_DIR=/path/a/specs,/path/b/specs PORT=4601 node server.js     # two spec sets
```

### Configuration (all optional)

| Variable | Flag | Default | Meaning |
| -------- | ---- | ------- | ------- |
| `PORT` | `--port` | `4599` | Bind port. Pick a different one per program to run two UIs at once. |
| `HOST` | `--host` | `127.0.0.1` | Bind address. To reach it from another machine, prefer `tailscale serve --bg --https=<port> http://127.0.0.1:<port>`. |
| `SPECS_DIR` | `--specs` | `<repo>/specs`, else `<repo>/examples/specs` | Spec directories (comma-separated, or repeat the flag). Each is a spec set on the home screen. |
| `LABELS_ROOT` | `--labels` | `<repo>/examples/labels` if nothing else is configured | Label-task roots (comma-separated, or repeat the flag). |
| `LOCATOR_PREFIX` | | `repo` | Evidence-locator scheme (`repo:src/foo.ts`). |
| `REPO_ROOT` | | the repo containing this tool | Checkout that locators resolve against. |
| `PROJECT_NAME` | | *(empty)* | Sidebar subtitle. |
| `REVIEWER` | `--reviewer` | `reviewer` | Attribution in spec `notes[].by` and the label file name. Unset: the `Tailscale-User-Login` header names the reviewer. |
| `SPECS_EXCLUDE` | | `README.md,FORMAT.md` | Files in `SPECS_DIR` that are docs, not specs. |
| `DELEGATED_PATHS` | | *(empty)* | Path prefixes owned by another team; see `validate.js`. |

All of them are read and normalized in one place, [`lib/config.js`](lib/config.js).

## The shell

- **Home** lists every spec set and label task with its progress; with exactly one
  thing configured it opens that directly.
- **Shared keys**: `j`/`k` move, number keys are verdicts, `u` undoes, `⌘K` (or `/`)
  searches every spec and label item, `?` shows the keys for the current mode, `Esc`
  closes a panel or leaves a text box. The theme follows the system; the footer
  toggle overrides it per browser.
- Routes are hash-based and every URL is relative, so the UI works behind a reverse
  proxy mounted at `/`. Writes must be same-origin `application/json`.

## Spec mode

- **Left**: specs with a progress meter that means exactly one thing — decided over
  decidable (both exclude the one `GEN` item per spec, which has no decision). A spec
  with nothing decided shows an empty track; needs-metrics counts appear in the stats
  line, not in the bar. Under the list, program-wide bucket totals.
- **Center**: items, filterable by status (All / Open / Deferred / Team / Decided) and
  independently by kind. Deferred and team-parked items are excluded from Open, so
  Open holds only what still awaits a first pass. `j`/`k` moves focus, `e` opens the
  focused item's first citation, `Esc` closes the unify input or the code panel,
  `1`/`2`/`3` are Keep/Change/Defer on the focused item and `u` undoes its decision,
  `⌘K` (or `/`) opens search across every spec — ids, titles, prose, decisions, notes.
- An item's optional `explanation` renders as plain-English body text under the title.
- **Click any locator** to open the code panel at the cited lines. Inline citations in
  the prose are clickable, and the structured evidence list below only shows citations
  the prose does not already mention, so nothing appears twice. Multi-range citations
  (`364,388-468`) highlight every range. A locator that no longer resolves shows the
  error plus "did you mean" candidates from the checkout; directory locators and
  suggestions are clickable. Files are windowed to 500 lines with a "show whole file"
  link.
- **One text field per item, one click per decision.** Type your reasoning in the
  item's textarea *first*, then hit a verdict: **Keep** / **Change** / **Defer** write
  immediately, with the textarea's text saved as `decision_detail` and the box
  cleared. Leave it empty and the decision saves with no detail. **Add note** (or
  `⌘/Ctrl+Enter`) saves text without deciding. Unsaved drafts survive re-renders and
  are restored if a write fails. Divergence items get a fourth verdict, **Unify on…**,
  which reveals a target-only input (`Enter` commits, `Esc` cancels): the target is
  slugified into `unify-on-<slug>` and any text in the textarea rides along as the
  detail.
- A decided item shows its verdict stamp and an **↩ Undo decision** button — one-click
  deciding means mistakes must be one click to reverse. The muted `needs metrics` chip
  toggles that status; it is a flag for a later metrics agent, not a verdict, which is
  why it is not among the decide buttons. **Team** parks an item for a live
  walkthrough, likewise not a verdict.
- Stored ids match the buttons: Keep writes `decision: keep` (good as-is, with the
  recommendation on record) and Change writes `decision: change` (needs adjustment per
  the recorded recommendation — never delete by itself). The legacy values `toss`
  (old spelling of `change`), `accept` (reads as a Keep), `reject` and `file` still
  parse and render, and the server normalizes `toss`/`accept` to `change`/`keep` on
  write, but the UI no longer offers them.

## Label mode

- **Label** tab: one card at a time. The card shows the whole item (transcript with
  speakers, your own lines styled as yours, timestamps), an audio player when the
  item has media (timestamps seek it), the model-written summary collapsed with a
  caveat, and the neighboring items, each expandable — so nobody judges a snippet.
  Meta chips show only `meta_display` keys, formatted (never a raw timestamp), and
  drop what the title already says.
- Built for long sittings: one slim sticky bar (round or wave, `done/total`, one dot
  per card, pace and session time, an Instructions button), and a sticky verdict bar
  at the bottom of the viewport with the keys on every button. Press a label's key
  and the next unlabeled card replaces the card in place, scrolled to its top.
  Instructions open on the first visit to a task only, fold away once you start, and
  `i` toggles them (remembered per task in this browser).
- Keys: label keys save; checkbox fields toggle with their key; `s` skips for now (the
  card comes back at the end); `j`/`k` move; `n` opens the note (it rides along with
  the next label, or Enter saves it on a labeled card); `u` undoes your last label from
  anywhere (any card, the done screen, Items, Results). Unsure is always offered.
- **Rounds**: deterministic stratified sittings; finishing one shows a done screen
  with the usefulness headline; Enter starts the next. Closing the browser or
  restarting the server resumes where you were.
- **Waves** (task.yaml `waves:`): a few small frozen waves instead of rounds over
  everything. Between waves the done screen explains that an agent is inferring the
  rest and picking the next wave, and checks every 15 s until it appears. See
  [`LABELS.md#waves`](../../LABELS.md#waves).
- **Blind**: while a task is blind the server withholds each item's model answers and
  stratum until you have labeled it; afterwards they appear collapsed under the card.
- **Items** tab: every item by round, filterable (unlabeled, labeled, unsure, with a
  note); click or Enter opens one.
- **Results** tab: *Is my labeling useful?* first — disagreements found, each model's
  agreement with a 95% interval and how many more labels would tighten it — then each
  model against you with confusion counts, stand-ins against you, a threshold curve
  for scored models (your positive rate per score bin, agreement at each threshold,
  the lowest threshold that flags nothing you labeled otherwise), per-stratum
  agreement, and the disagreeing items. A toggle fills unlabeled items with stand-in
  labels. In waves mode Results opens with **Final labels**: the stand-in's held-out
  accuracy against the pre-set bar, your labels plus the stand-in's, each model's
  agreement on your labels only and on the combined set side by side, per-wave
  predicted-before-labeling agreement, calibration and the stand-in's misses.
  `Shift+L`/`Shift+I`/`Shift+R` switch tabs.

### Labels CLI

```sh
node labels.js tasks                          # tasks under LABELS_ROOT
node labels.js stats <task-dir|id> [--reviewer R] [--fill] [--json]
node labels.js export <task-dir|id> [--reviewer R] [--source human|model-standin] [--final] [--format jsonl|csv]
# waves mode — the between-wave agent loop (LABELS.md#waves)
node labels.js waves <task>                   # state, per-wave progress, stand-in coverage, next action
node labels.js infer-prompt <task> --out brief.md
node labels.js import-standin <task> standin.jsonl [--model ID] [--dry-run]
node labels.js next-wave <task> [--dry-run]   # select + freeze waves/wave-N.json
```

Reads the files directly; prints the same numbers as Results (`lib/results.js`).

## Validate

```sh
node validate.js              # format lint for all specs; also `npm run validate`
node validate.js --locators   # additionally check every locator against REPO_ROOT
node validate.js --strict     # warnings become failures — the gate before deleting a spec
```

It also checks every label task under the configured roots (task.yaml, items.jsonl,
label rows). Errors fail the run; warnings (vocabulary drift such as `confidence: medium`,
un-padded ids, unparseable `lines`, a `change` with no prefixed detail, a legacy
`toss`/`accept` stored value) are printed but
do not, unless `--strict`. The UI shows the same warnings in the spec header.

## Tests

```sh
npm test          # node --test: label store, rounds, waves, results math, task format,
                  # and an HTTP suite against a real server on temp copies
                  # (spec writes stay surgical, blind enforcement, concurrency)
```

## Agent-facing writes

Label mode: model stand-in labels go to `POST /api/task/<id>/labels`
(`{"reviewer": "opus-standin", "labels": [...]}`, always `source: model-standin`),
through the same per-file queue as the reviewer's clicks. See
[`LABELS.md`](../../LABELS.md) for every endpoint.

Spec mode: two actions exist for agents rather than humans, so concurrent writers go
through this server's serialized queue instead of racing on the raw files:

- `{"action":"metrics","metrics":{…}}` — set or clear an item's metrics block.
- `{"action":"append-item","id":…,"title":…,"meta":{…},"prose":…}` — create a new
  item, inserted before the file's `GEN` item, refused if the result would not
  validate.

## The write property

Server writes are **surgical**: only the targeted YAML fence body is rewritten, via
temp-file + rename so a crash cannot truncate a spec. Prose, frontmatter and every
other item are byte-identical afterwards. Re-emitting a block does drop YAML quotes
that js-yaml considers unnecessary (`lines: "204-244"` → `lines: 204-244`) and may
re-style a folded scalar as a literal one — semantically identical, and only inside
the block you edited.

Anything that breaks this property should be rejected. It is what makes a review
session produce a readable diff.

Label writes have the matching property: rows are only ever appended, one line per
write, serialized per file, so a label file is its own audit trail and a crash can
at worst tear the final line (which readers skip).

## Files

| Path | Role |
| ---- | ---- |
| `server.js` | HTTP server, spec routes, static files |
| `lib/config.js` | every knob, in one place |
| `lib/parser.js` | spec parsing and surgical updates |
| `lib/task.js`, `lib/labelstore.js`, `lib/rounds.js`, `lib/results.js` | label format, store, sampler, results math |
| `lib/label-api.js` | label-mode HTTP routes |
| `public/common.js`, `shell.js`, `spec.js`, `label.js` | the UI: helpers, shell/router, the two modes |
| `validate.js`, `labels.js` | linter and labels CLI |
