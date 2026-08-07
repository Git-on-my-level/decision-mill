# Playbook: running the mill

How to get from "a large codebase nobody fully understands" to "a pile of decided
items an agent can execute", using agent swarms for the reading and a human for the
deciding.

This is method, not tooling. Nothing here depends on a particular CLI agent; the
roles are what matter.

---

## Roles

| Role | Who | Does |
| ---- | --- | ---- |
| Orchestrator | one long-running agent session | writes briefs, launches workers, verifies their claims, merges, commits |
| Survey agent | swarm worker, one per capability | reads existing implementations, writes one spec file |
| Metrics agent | one worker | fills `metrics` blocks on `needs-metrics` and `UNK` items |
| Reviewer | **a human** | decides |
| Implementation agent | swarm worker, one per domain | consumes decided specs, writes the code |

Workers never commit. The orchestrator re-verifies every green claim itself — a
worker reporting "tests pass" is a hypothesis, not a result.

## Phase 1 — Extraction

One survey agent per capability, file-disjoint by construction so parallel workers
cannot collide. Each brief carries:

- **Scope**: the capability, and which surfaces implement it.
- **Output**: exactly one spec file conforming to `FORMAT.md`, with a `baseline`
  commit and no items outside the ID scheme.
- **The shape rule**: state the ideal unified behavior once, then list only *major*
  divergences from it. A spec that catalogues every difference is a diff, not a spec,
  and it will not get reviewed.
- **The evidence rule**: every item needs at least one locator, and a locator without
  line numbers is nearly useless to the reviewer. Cite the lines.
- **The confidence rule**: `confidence` is a real signal, not a formality. `low` means
  "I am guessing", and the reviewer treats it that way — combined with
  a `change`-class proposal it defaults to keep.
- **The silence rule**: unclear, missing, or forced-to-guess findings are
  *deliverables*, not embarrassments. They become `UNK` items or rules in your agent
  instructions file. An agent that invents a pattern to avoid reporting a gap has
  done more damage than one that stops.

Calibrate before you fan out. Run one agent on one capability, review its spec
properly, and turn what you had to fix into brief text. Model lanes are provisional
until that first calibration run: archaeology on a hostile legacy tree and
exemplar-shaped fill-in are different jobs and rarely the same model's strength.

Then gate every spec:

```sh
node tools/spec-review/validate.js --locators
```

A spec with a broken locator wastes reviewer time in the most expensive place — mid
review, one click from a decision.

## Phase 2 — Grounding (metrics)

Some items cannot be decided from code. Mark them `status: needs-metrics` during
extraction (or flag them in the UI with the `needs metrics` chip, which is
deliberately *not* one of the verdict buttons).

A metrics agent then fills the `metrics` block via the server's API, so concurrent
agents go through one serialized write path instead of racing on raw files:

```sh
curl -X POST http://127.0.0.1:4599/api/spec/<slug>/item/<ID> \
  -H 'content-type: application/json' \
  -d '{"action":"metrics","by":"metrics-agent","metrics":{
        "as_of":"2026-01-14","source":"posthog",
        "points":[{"label":"lists with >1 member","value":"11.4%","note":"last 30d"}]}}'
```

At most four points, each a pre-formatted display string. The constraint is the
point: a metrics block that needs studying has failed at its job, which is to let a
reviewer decide *this item* without leaving the page.

Agents can also propose whole new items (`"action":"append-item"`), which are
inserted before the file's `GEN` item and refused if the result would not validate.

## Phase 3 — Adjudication

A human, the UI, and a couple of hours.

```sh
cd tools/spec-review && node server.js
```

Practical notes from real sessions:

- Work one spec at a time, **Open** filter on, `j`/`k` to move, `e` to open the
  focused item's first citation. The progress meter's unfilled remainder means
  exactly one thing: still open.
- Type the reasoning *first*, then hit the verdict. The textarea's contents ride along
  as `decision_detail`. This is the whole interaction: one box, one click.
- **Defer** is a real answer and is much better than a bad decision. So is **Team**,
  which parks an item for a live walkthrough without pretending it was decided.
- Reverse mistakes immediately — one-click deciding is only safe because **↩ Undo
  decision** is also one click. The undo lands in the note timeline, so the trail
  survives.
- Beware the batch-error class: a run of similar items decided quickly, all wrong the
  same way. The commonest version is deciding items whose evidence lives entirely in
  code another team owns. `DELEGATED_PATHS` turns that into a lint warning; the honest
  verdict there is `file`.

## Phase 4 — Consumption

Implementation agents read the spec files directly. They never touch the review UI —
it is a human tool, and an agent that goes through it is one abstraction away from
the truth.

The brief for a consuming agent says:

- `decision: null` or `status: open` means **stop and ask**. Not "use your judgment".
- `decision: change` (legacy spelling: `toss`) does **not** mean delete. Read `decision_detail`: only a
  `remove:` prefix authorizes removing a capability; `change:` is a redesign
  instruction and the capability stays.
- A `FEAT` item's decision is the **scope of record**. A `DIV` note may not widen or
  narrow what the parent feature decided.
- The `notes` timeline is where the reviewer's actual reasoning is. Read it before
  implementing anything whose detail is one line.

## Phase 5 — Exit, then dispose

Nothing durable may live only in a spec, because the spec is about to be deleted.
Before a capability's spec goes:

| Item kind | Lands in |
| --------- | -------- |
| `INV` kept | a test in the new suite, or your invariant register |
| `FC` | an issue, or a regression test |
| `FEAT` changed with `remove:` | a removal record (below) |
| `DIV` unified | the delivering change's commit message / ADR |
| architectural call | an ADR |
| `UNK` never grounded | an open question in your tracker, explicitly |

Then delete the spec. The gate:

```sh
node tools/spec-review/validate.js --strict   # must exit 0
```

`--strict` fails on any `change` (or legacy `toss`) whose `decision_detail` is missing or unprefixed —
i.e. on exactly the decisions that would become unreadable the moment the prose
disappears.

### Removal records

Every user-visible removal owes a record. The frontend program that this was
extracted from used `deprecations/DEP-NNN-<slug>.md`, and the policy is worth copying
wholesale:

> No user-visible surface may be intentionally made incompatible or removed without a
> record. Each record identifies the surface, its consumers (including shipped app
> versions and OS integrations), the replacement and its parity evidence, the owner,
> approval state, communication plan, support window, adoption signals, rollout and
> rollback, earliest sunset date, and final deletion criteria.
>
> **Deprecation alone is not permission to remove a surface.**
>
> **User data is loud, never a footnote.** Every record carries a Data disposition
> section. The default disposition for every cut: (1) data behind a removed feature is
> retained read-only with an export path, never deleted as a side effect of the cut;
> (2) wire fields and enum values are reserved, never re-used or stripped from stored
> rows; (3) any exception — actual deletion, or a security cleanup such as token
> revocation — needs its own line with explicit sign-off.

The reason this belongs in the playbook rather than in a policy binder: the moment a
reviewer clicks **Change** on a feature, the UI writes `remove:` into the detail. That
prefix is what generates the record. Nothing else in the pipeline notices that a
person just deleted something a user could see.

## The disposable-spec method, stated plainly

The specs are scaffolding. Three alternatives, all worse:

- **A permanently maintained spec** rots into another divergent artifact — the exact
  problem the program exists to solve.
- **Rewrite by translation from the old code** copies the defective patterns forward
  and silently inherits accidental behavior.
- **Decisions recorded only in ADRs** invents parallel record-keeping when your
  invariant, issue and deprecation mechanisms already exist.

So: extract broadly, adjudicate per capability, reimplement per capability
(strangler, never big-bang), and delete each spec when its capability ships. Deleting
is safe *only* because every durable output has a named landing zone, and unsafe the
moment one does not.
