# Machine-parsable spec format (v1)

The contract between the capability specs, the human review UI (`tools/spec-review`),
and coding agents. **The markdown files are the single source of truth**; the UI only
edits the structures defined here. Agents read the spec files directly and treat
`adjudication` blocks as authoritative state.

Copy this file into your program's `specs/` directory and fill in the two
project-specific knobs marked below (locator prefix, capability codes).

## File frontmatter

Every spec file starts with YAML frontmatter:

```yaml
---
spec: todo-lists                # slug, must match the filename
title: Todo lists
status: draft                   # draft | refined
baseline: a1b2c3d4e5f60718293a4b5c6d7e8f9012345678   # commit the spec was extracted from
extracted: 2026-01-15
---
```

`baseline` is what makes a spec falsifiable: it names the commit whose behavior the
spec describes, so a reader can tell drift from error.

## Adjudicable items

Sections 1–2 (Scope, Ideal unified behavior) are prose. Every entry in the remaining
sections is an **item**:

- A level-3 heading: `### <ID> — <short title>` (em dash, U+2014 — the parser
  requires it, and a plain hyphen makes the item invisible to both the UI and the
  linter)
- Immediately followed by a fenced block whose info string is exactly `adjudication`,
  containing YAML
- Followed by free prose: the human explanation, the evidence discussion, anything

### ID scheme

`<KIND>-<CAP>-<NNN>`

| KIND  | Meaning |
| ----- | ------- |
| `DIV` | Divergence — the same behavior implemented differently across surfaces |
| `INV` | Candidate invariant — something that must stay true |
| `FC`  | Candidate failure case — a way the current system breaks |
| `UNK` | Unknown — a question that needs data before it can be decided |
| `FEAT`| Feature — a user-visible capability adjudicated carry/cut/defer |
| `DEC` | Decision — a generic register entry that is none of the above (a feature flag's fate, a vendor choice, a policy call); usually paired with the set's own verdicts (see [Spec-set config](#spec-set-config-decision-millyaml)) |
| `GEN` | General — one per file, spec-level notes |

`CAP` is **your** short capability code — one per spec file, uppercase, no
punctuation. Pick a vocabulary for your program and record it in your `specs/`
README: e.g. `TODO`, `LISTS`, `SHARE`, `SYNC`, `AUTH`, `BILLING`. `NNN` is
zero-padded to three digits, unique within the file, and **never reused** — a decided
ID is a permanent reference in commits, ADRs and removal records. Because of that,
each `CAP` code belongs to exactly one spec file in a set: `validate.js` warns when two
files use the same code (three files all writing `UNK-CAP-*` would make `UNK-CAP-001`
ambiguous).

### adjudication block schema

```yaml
id: DIV-TODO-001
kind: divergence            # divergence | invariant | failure-case | unknown | feature | decision | general
title: Completion is optimistic on web, write-through on mobile
explanation: >              # optional for most kinds; REQUIRED for kind: feature
  Ticking a todo updates instantly on the web app but waits for the server on
  mobile, so on a slow connection the mobile checkbox looks broken. Picking one
  behavior means the checkbox feels the same everywhere.
proposed: unify-on-optimistic  # keep | change | unify-on-<x> | file | n/a — the extractor's proposal
confidence: high            # high | med | low
status: open                # open | decided | needs-metrics | team (parked for a live walkthrough)
decision: null              # null until adjudicated; then keep | change | defer | unify-on-<x>
                            # (or an id the set declares in decision-mill.yaml)
decision_detail: null       # free text qualifying the decision (see change prefixes below)
decided_at: null            # ISO date when decided
evidence:                   # locators; lines optional — "120", "120-180", "364,388-468"
  - locator: repo:web/src/TodoList.tsx
    lines: 18-30
    note: optimistic toggle with a pending set
metrics:                    # optional — filled by a metrics agent, not by hand
  as_of: 2026-01-14         # date the numbers were measured
  source: posthog           # posthog | sentry | mixpanel | other short slug
  points:                   # 1–4 points, no more
    - label: lists with >1 member
      value: 11.4%          # pre-formatted display string, never a raw number dump
      note: last 30d        # optional qualifier
notes: []                   # appended by UI/agents: {at: ISO datetime, by: string, text: string}
```

## Evidence locators

`evidence[].locator` is `<prefix>:<path-from-repo-root>`. **Never absolute paths** —
the whole point of the prefix is that a spec is portable across checkouts and
machines, and an absolute path leaks someone's home directory into a durable record.

The prefix is a per-program knob:

| Where | Setting |
| ----- | ------- |
| The tool | `LOCATOR_PREFIX` env var (default `repo`) |
| Which checkout it resolves against | `REPO_ROOT` env var |
| Several checkouts | `LOCATOR_ROOTS="acme=/src/acme,kb=/src/kb"`, and/or `locator_roots` in a set's `decision-mill.yaml` |
| Your specs | this file — write your prefix into the examples above |

A program whose evidence spans more than one repository declares one scheme per
checkout. Every declared scheme is accepted in `evidence[].locator`, clickable in the
code panel (in evidence rows and inline prose), and checked by `validate.js
--locators`. `LOCATOR_PREFIX`/`REPO_ROOT` remain the single-root case and keep working
alongside `LOCATOR_ROOTS`. Roots set in the environment win over a set's
`locator_roots` of the same name (the environment is the machine-specific override);
the implicit default (`repo:` → the repository holding the tool) applies only when
nothing declares a root.

Record the choice in an ADR so specs written by different agents agree. If you have
more than one program pointing at the same codebase, use the same prefix in both;
diverging makes cross-program references ambiguous for no benefit.

Locators may also be written inline in the prose (`repo:web/src/TodoList.tsx:18-30`);
the UI makes those clickable and then suppresses the structured evidence rows the
prose already cites, so a reviewer never reads the same citation twice. A locator may
wrap across a source line only right after `/` or `-`; elided paths
(`repo:.../x.ts`) are left as text. `validate.js --locators` checks inline locators
too.

## Spec-set config (`decision-mill.yaml`)

Optional. A file named `decision-mill.yaml` in a specs directory configures that set;
without it the set behaves exactly as described elsewhere in this file.

```yaml
instructions: |          # markdown, shown in the set's Instructions panel (i)
  Each card is one feature flag. Decide the flag's fate, not the feature's merit.
decisions:               # replaces the default Keep / Change / Defer / Unify buttons
  - {id: graduate, label: Graduate, hint: "delete the flag; ship the new path", key: "1", tone: positive}
  - {id: extend,   label: Extend,   hint: "keep the flag; say until when", requires_detail: true}
  - {id: change,   label: Change,   hint: "keep the flag, change its rollout"}
  - {id: defer}
locator_roots:           # extra schemes for this set; paths relative to this file
  kb: ../knowledge-base
```

| Key | Meaning |
| --- | ------- |
| `decisions[].id` | The value stored in `decision`. Lowercase letters, digits, `-`, `_`. |
| `label`, `hint` | Button text (default: the id, capitalized) and its tooltip; both appear in the verdict legend under the instructions. |
| `key` | Keyboard shortcut. Missing keys get the next free digit **in declared order**. `j k u e i ? /` are spec mode's and refused. |
| `tone` | `positive` / `negative` / `neutral` — button and stamp color (defaults: `keep` positive, `change` negative, others neutral). |
| `requires_detail` | The UI refuses the click until the item's text box has a reason, the server answers 400 to a bare write, and `validate.js` warns on a stored one (an error under `--strict`). |
| `kinds` | Only offer this verdict on items of these kinds. |
| `{id: unify}` | The Unify-on… flow (stores `unify-on-<target>`), divergences only. Leave it out and no unify button appears. |

Rules that still hold with a declared vocabulary:

- An id `change` keeps every `change` rule: the UI auto-prefixes its detail
  (`remove:` on features, `change:` otherwise) and `validate.js` warns on a null or
  unprefixed detail whether or not `requires_detail` is set — `change` always needs
  its detail before the spec can be deleted.
- An id `defer` keeps the item's status `open`; every other verdict sets `decided`.
- Declared ids are stored as declared. A set that declares `accept` stores `accept`
  (not the legacy `keep` reading), and the legacy-spelling warning is not raised.
- The built-in values (`keep`, `change`, `defer`, `file`, `unify-on-<x>`) and legacy
  spellings stay valid in every set, so existing files never become invalid.

## Rules

These are the load-bearing ones. Each exists because something went wrong without it.

- **The YAML block is authoritative for machine state; prose is authoritative for
  explanation.** Do not duplicate long prose into YAML.
- **`explanation` is written for the human deciding**, not for the archive: 1–3
  sentences of plain English saying what the item means and why it matters,
  understandable without reading the code. For `kind: feature` it is **required** and
  must say what the user gets, which surfaces have it, and what cutting it would
  mean. It is not a summary of the prose below the fence, and it stays short.
- **`FEAT` items sit above shape divergences.** They ask whether the user-visible
  feature should be carried forward at all (`keep` / `change` / `defer`). Prefer a
  dedicated `## Feature inventory` section placed just before the GEN item.
- **Decision vocabulary**: unless the set declares its own (`decision-mill.yaml`),
  the review UI offers only `keep` (good as-is, with the
  recommendation on record), `change` (needs adjustment per the recorded
  recommendation), `defer`, and `unify-on-<x>` on divergences. The stored id matches
  the button label. `toss` (old spelling of `change`), `accept` (old spelling of
  `keep`), `reject` and `file` are legal legacy/handoff values — parsers must still
  accept and render them — but the UI no longer produces the first three. `file` means
  "another team owns this; hand it over", and is the honest verdict for an item whose
  evidence all lives in code this review does not control.
- **`change` does NOT mean delete.** It means "do not carry forward as-is"; the
  `decision_detail` and notes carry the reviewer's redesign instructions and are the
  actionable part of the decision. Only a detail starting `remove:` authorizes
  removing a capability. The UI auto-prefixes one-click Change decisions (`remove:`
  on features, `change:` otherwise).
- **Every `change` needs a prefixed `decision_detail`.** `change` means at least four
  different things, and once the spec is disposed of, only the decision and its detail
  survive. Required prefixes:
  - `remove:` — a user-visible capability is being removed (owes a removal record)
  - `change:` — the mechanism is redesigned or unified; the capability stays
  - `resolved:` — the question is now answered; the answer follows
  - `moot:` — the parent feature was cut; name the parent

  `validate.js` warns on a null-detail or unprefixed `change` (or legacy `toss`);
  warnings become errors under `--strict`, which is the gate before any spec file is
  deleted.
- **Burden of proof is on `change`.** Items with `confidence: low` and a
  `change`-class proposal default to keep unless a human decides otherwise. An extractor's low-confidence
  hunch is not a mandate to delete a feature.
- **Scope of record: a `FEAT` item's decision is the scope of record.**
  `DIV`/`INV`/`FC`/`UNK` decisions may not widen or narrow it. Where a divergence note
  sets product scope, propagate it to the parent `FEAT` item as an explicit decision.
  A metric item that is the justifying evidence for a feature cut may **not** be
  closed as "moot — parent cut": collect it, or record explicitly that the cut
  proceeds without it.
- **`metrics` is scannable or it is nothing.** It exists for one purpose: to ground a
  `needs-metrics` or `UNK` item so a human can decide it. At most **4** `points`;
  every `value` and `note` is a short pre-formatted display string — no raw event
  dumps, no tables, no time series. `as_of` and `source` say when and where the
  numbers came from. Items with no measurement pending simply omit the key. Prose may
  discuss the numbers at length.
- **Exactly one `GEN-<CAP>-001 — General notes` item** (kind `general`) at the end of
  each file, for spec-level notes. It has no decide affordance and is excluded from
  progress denominators.
- **Tools must preserve unknown YAML keys** and never reorder or rewrite prose when
  updating a block.

## Parsing

A conforming parser: (1) reads frontmatter; (2) scans for `### ` headings whose text
starts with a valid ID followed by ` — `; (3) takes the first ` ```adjudication `
fence after the heading as the item's state; (4) treats everything between that
fence's close and the next heading as the item's prose.

Reference implementation and linter: `tools/spec-review/lib/parser.js` and
`tools/spec-review/validate.js` (the latter is also run by the review server on load,
and surfaces its warnings in the spec header).
