# decision-mill

A process and a small local tool for grinding a large pile of open product and
technical decisions down to a decided pile, fast, with agents doing the reading and a
human doing the deciding.

Specs are markdown. Decisions live inside the markdown. Agents read the markdown.
There is no database, no server to deploy, no state anywhere except files in your
repository.

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

Good fit:

- A rewrite or unification where the same behavior exists two or three times and you
  need to pick winners.
- A legacy surface where "what does this even do, and do we still want it?" is the
  actual question.
- Any program where agents can survey faster than a human can read, and the human's
  scarce resource is *deciding*, not typing.

Bad fit:

- Fewer than ~50 decisions. Use a document.
- Decisions that need a meeting more than they need evidence. (There is a `team`
  status for parking those, but if most items are like that, this is the wrong tool.)
- Anything where the decisions are not grounded in code you can cite.

## Quickstart

```sh
git clone https://github.com/Git-on-my-level/decision-mill
cd decision-mill/tools/spec-review
npm install          # or: bun install
node server.js       # → http://127.0.0.1:4599
```

With no configuration this serves the fictional example in `examples/specs/`, whose
evidence locators resolve against this repository — so the code panel works
immediately. Click a citation, hit **Keep** / **Change** / **Defer**, watch
`examples/specs/todo-lists.md` change on disk.

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
`tools/spec-review/lib/config.js`.

| Variable | Default | What it does |
| -------- | ------- | ------------ |
| `PORT` | `4599` | Bind port (always `127.0.0.1`). Use different ports to run two programs' UIs at once. |
| `SPECS_DIR` | `<repo>/specs`, else `<repo>/examples/specs` | Where the spec files live. |
| `LOCATOR_PREFIX` | `repo` | Evidence-locator scheme: `repo:path/to/file`. |
| `REPO_ROOT` | the repo containing the tool | Checkout that locators resolve against. |
| `PROJECT_NAME` | *(empty)* | Subtitle in the UI sidebar. |
| `REVIEWER` | `reviewer` | Attribution written into `notes[].by`. |
| `SPECS_EXCLUDE` | `README.md,FORMAT.md` | Files in `SPECS_DIR` that are docs, not specs. |
| `DELEGATED_PATHS` | *(empty)* | Comma-separated path prefixes owned by another team; an item whose evidence lives entirely under them warns unless the verdict is `file`. |

## What's in here

| Path | What it is |
| ---- | ---------- |
| [`FORMAT.md`](FORMAT.md) | The spec format: item structure, decision vocabulary, and the rules that keep decisions readable after the spec is gone. |
| [`PLAYBOOK.md`](PLAYBOOK.md) | Running extraction swarms, metrics agents, decision consumption, and removal records. |
| [`tools/spec-review/`](tools/spec-review) | The local review UI and the format linter. Two dependencies, no build step. |
| [`examples/`](examples) | A fictional todo-app spec plus the fictional code it cites, so the tool works on a fresh clone. |

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

## Origin

Extracted from a real frontend-unification program where it was used to adjudicate a
few thousand items across a handful of capability specs. The rules in `FORMAT.md` that
look fussy — the `change` prefixes, the scope-of-record rule, the four-point cap on
metrics — are all scar tissue from that run. They are the parts most worth keeping.

MIT licensed.
