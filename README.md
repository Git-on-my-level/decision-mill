# decision-mill

A process and a small local tool for grinding a large pile of open questions down to
a decided pile, fast, with agents doing the reading and a human doing the deciding.

One local web UI, two modes:

- **Spec mode** adjudicates product and technical decisions written into markdown
  specs. Decisions live inside the markdown; agents read the markdown.
- **Label mode** collects a human's judgments on items — conversations, model
  outputs, anything an agent can export as JSONL — blind, in stratified rounds, and
  shows at a glance whether each model (or a model stand-in) agrees with the human.

Both share the same navigation, keyboard model (`j`/`k`, number keys for verdicts,
`u` undo, `⌘K` search, `?` help), one-click deciding and one-click undo. There is no
database and no server to deploy: spec decisions live in your repository's files,
labels live in append-only JSONL files outside it.

---

## The problem it solves

You are rewriting, unifying or replacing something big. The real bottleneck is not
typing code — agents do that now. The bottleneck is that thousands of small questions
need a human answer, and every one of them requires context nobody has loaded:

*Web and mobile complete a todo differently. Which one wins? Does anyone still use
offline mode? Is this cap a policy or a bug? Do we carry this feature forward at all?*

Answering those in chat threads means the answers scatter and rot. Answering them in
a design doc means writing prose nobody can execute. decision-mill turns them into
**items**: a titled question, an agent's proposal, a confidence marker, code
citations, and one slot for the human's verdict — arranged so a person can decide one
every few seconds, and so an agent can read the verdict back without being told.

## The lifecycle

```
  extract  ──▶  adjudicate  ──▶  consume  ──▶  exit  ──▶  dispose
  (agents)      (a human)        (agents)     (durable)   (delete)
```

1. **Extract.** A swarm of survey agents reads the existing implementations and
   writes capability specs: the ideal unified behavior, then only the *major*
   divergences from it, each with evidence locators, a proposed resolution, and a
   confidence marker. See [PLAYBOOK.md](PLAYBOOK.md).
2. **Adjudicate.** A human opens the review UI and decides. One text field per item,
   one click per verdict, evidence one keystroke away. This is the step everything
   else exists to make cheap.
3. **Consume.** Coding agents read the spec files directly — never the tool — and
   treat the `adjudication` blocks as authoritative state. A decided item is an
   instruction; an open one is a question they must not answer themselves.
4. **Exit.** Durable outputs leave the spec through mechanisms that already exist in
   your repo: invariants become tests, failure cases become issues, removals become
   deprecation records, architectural calls become ADRs.
5. **Dispose.** The spec is deleted when its capability ships. Specs are scaffolding.
   A permanently maintained spec becomes a third divergent artifact that rots — which
   is exactly the problem you started with.

The gate on step 5 is `validate.js --strict`: a spec cannot be deleted while any
decision is unreadable without the prose that is about to disappear.

## When to use it

The lifecycle above is **spec mode**. Use **label mode** instead when the question is
the same for every item and the answer is a judgment, not a design decision: "would
you keep this conversation?", "is this notification useful?", "is this model output
right?". Typical shape: an agent exports a few hundred items with model scores, the
human labels rounds of 20–50 spread across the score range — or, in **waves** mode,
just three waves of ~20 (a stratified seed, the items the stand-in is least sure of,
then a random hold-out) while an agent infers the rest between waves — and Results
says whether the stand-in and each model can be trusted. Under ~50 decisions of
either kind, a document is fine.

Spec mode — good fit:

- A rewrite or unification where the same behavior exists two or three times and you
  need to pick winners.
- A legacy surface where "what does this even do, and do we still want it?" is the
  actual question.
- Any program where agents can survey faster than a human can read, and the human's
  scarce resource is *deciding*, not typing.

Spec mode — bad fit:

- Fewer than ~50 decisions. Use a document.
- Decisions that need a meeting more than they need evidence. (There is a `team`
  status for parking those, but if most items are like that, this is the wrong tool.)
- Anything where the decisions are not grounded in code you can cite.

## Quickstart

```sh
git clone https://github.com/Git-on-my-level/decision-mill
cd decision-mill/tools/spec-review
npm install          # or: bun install
node server.js       # → http://127.0.0.1:4599   (bun server.js also works)
```

With no configuration the home screen offers both fictional examples.

**Spec mode** — open *examples/specs*. Its evidence locators resolve against this
repository, so the code panel works immediately. Click a citation, hit **Keep** /
**Change** / **Defer** (or focus an item with `j` and press `1`/`2`/`3`), watch
`examples/specs/todo-lists.md` change on disk.

**Label mode** — open *Keep or noise — fictional voice notes*. Press `1`/`2`/`3` to
label each card; the next one appears. Model answers stay hidden until you have
labeled a card. After six cards the round is done; **Results** shows how two
fictional models and a model stand-in agree with you, per stratum, with a
threshold curve. Your labels land in `examples/labels/demo-task/labels/` (ignored by
git).

### Labeling real data

```sh
# a task is a directory: task.yaml + items.jsonl (+ media/); see LABELS.md
node server.js --labels ~/.local/share/labels --port 4610
```

To label fewer items, add `waves: {count: 3, size: 20}` to the task; between waves
an agent runs `labels.js infer-prompt`, `import-standin` and `next-wave` (the
procedure is in [LABELS.md](LABELS.md#waves) and the skill).

Label data never goes in git. To label from another machine, keep the loopback bind
and put a proxy in front, e.g. `tailscale serve --bg --https=4610
http://127.0.0.1:4610`; the reviewer is then taken from the `Tailscale-User-Login`
header unless `REVIEWER` is set. Read labels back with `node labels.js stats <task>`.
Agents building tasks should follow [`skills/decision-mill/SKILL.md`](skills/decision-mill/SKILL.md).

### Installing it for a real program

1. Copy `FORMAT.md` into your tracker's `specs/` directory and fill in its two knobs:
   your locator prefix and your capability codes.
2. Copy `tools/spec-review/` into your tracker (vendor it — it is small and you will
   want to tune it).
3. Point it at your code:

   ```sh
   LOCATOR_PREFIX=acme REPO_ROOT=/path/to/checkout PORT=4601 node server.js
   ```

4. Run an extraction swarm ([PLAYBOOK.md](PLAYBOOK.md)) to produce the specs.
5. Decide. Then read the decisions back with agents.

### Configuration

All optional; every knob is an environment variable read in
`tools/spec-review/lib/config.js`. A few have CLI-flag twins (`--specs`, `--labels`,
`--port`, `--host`, `--reviewer`).

| Variable | Default | What it does |
| -------- | ------- | ------------ |
| `PORT` | `4599` | Bind port. Use different ports to run two programs' UIs at once. |
| `HOST` | `127.0.0.1` | Bind address. Prefer a reverse proxy (`tailscale serve`) over widening it. |
| `SPECS_DIR` | `<repo>/specs`, else `<repo>/examples/specs` | Where the spec files live. Comma-separate several spec sets; the first is the default for set-less API calls. |
| `LABELS_ROOT` | `<repo>/examples/labels` when nothing else is configured | Directories holding label tasks (comma-separated). Configuring only one mode hides the other mode's example. |
| `LOCATOR_PREFIX` | `repo` | Evidence-locator scheme: `repo:path/to/file`. |
| `REPO_ROOT` | the repo containing the tool | Checkout that locators resolve against. |
| `PROJECT_NAME` | *(empty)* | Subtitle in the UI sidebar. |
| `REVIEWER` | `reviewer` | Attribution for spec notes and the label file name. When unset, a `Tailscale-User-Login` request header is used instead. |
| `SPECS_EXCLUDE` | `README.md,FORMAT.md` | Files in `SPECS_DIR` that are docs, not specs. |
| `DELEGATED_PATHS` | *(empty)* | Comma-separated path prefixes owned by another team; an item whose evidence lives entirely under them warns unless the verdict is `file`. |

## What's in here

| Path | What it is |
| ---- | ---------- |
| [`FORMAT.md`](FORMAT.md) | The spec format: item structure, decision vocabulary, and the rules that keep decisions readable after the spec is gone. |
| [`LABELS.md`](LABELS.md) | The label task format: task.yaml, items.jsonl, append-only label files, rounds, and the agent API. |
| [`PLAYBOOK.md`](PLAYBOOK.md) | Running extraction swarms, metrics agents, decision consumption, and removal records. |
| [`tools/spec-review/`](tools/spec-review) | The local UI for both modes, the format linter, and the labels CLI. Two dependencies, no build step. |
| [`skills/decision-mill/`](skills/decision-mill/SKILL.md) | The skill future agents load to pick a mode, build a label task, launch it, and read results back. |
| [`docs/design-notes.md`](docs/design-notes.md) | The real labeling sessions label mode was designed from, and which finding drove which choice. |
| [`examples/`](examples) | A fictional todo-app spec plus the fictional code it cites, and a fictional label task, so the tool works on a fresh clone. |

## Design commitments

Three properties are worth more than any feature, and changes that break them should
be rejected:

- **The markdown is the source of truth.** The UI is a fast editor over files that
  remain perfectly readable, greppable and diffable without it. Delete the tool and
  you have lost convenience, not decisions.
- **Writes are surgical.** A decision rewrites the bytes of exactly one YAML fence,
  via temp-file-plus-rename. Prose, frontmatter, and every other item are
  byte-identical afterwards, so a review session produces a diff you can actually
  read.
- **Deciding is one click, and undeciding is one click.** One-click verdicts are only
  safe because mistakes reverse just as fast; every write also lands in the item's
  note timeline, so the audit trail survives the undo.
- **Labels are append-only and blind by default.** A label file is never rewritten:
  an undo is a new row, latest wins, and the file is the audit trail. Model answers
  are withheld by the server until the human has answered, because a label given
  after seeing the model is a vote on the model, not a measurement.

## Origin

Extracted from a real frontend-unification program where it was used to adjudicate a
few thousand items across a handful of capability specs. The rules in `FORMAT.md` that
look fussy — the `change` prefixes, the scope-of-record rule, the four-point cap on
metrics — are all scar tissue from that run. They are the parts most worth keeping.

MIT licensed.
