# spec-review

Local web UI for walking through capability specs, viewing the cited code, and
recording decisions and notes. The spec markdown files remain the single source of
truth (see [`FORMAT.md`](../../FORMAT.md)): every action here writes back into their
`adjudication` YAML blocks, so coding agents read the specs directly and never need
this tool.

Two dependencies (`js-yaml`, `marked`), no build step, binds to `127.0.0.1` only.

## Run

```sh
npm install       # or: bun install
node server.js    # bun server.js also works
# → http://127.0.0.1:4599
```

With no configuration it serves the repository's `specs/` directory, falling back to
the bundled `examples/specs/`.

### Configuration (all optional)

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PORT` | `4599` | Bind port. Pick a different one per program to run two UIs at once. |
| `SPECS_DIR` | `<repo>/specs`, else `<repo>/examples/specs` | Where spec files live. |
| `LOCATOR_PREFIX` | `repo` | Evidence-locator scheme (`repo:src/foo.ts`). |
| `REPO_ROOT` | the repo containing this tool | Checkout that locators resolve against. |
| `PROJECT_NAME` | *(empty)* | Sidebar subtitle. |
| `REVIEWER` | `reviewer` | Attribution in `notes[].by`. |
| `SPECS_EXCLUDE` | `README.md,FORMAT.md` | Files in `SPECS_DIR` that are docs, not specs. |
| `DELEGATED_PATHS` | *(empty)* | Path prefixes owned by another team; see `validate.js`. |

All of them are read and normalized in one place, [`lib/config.js`](lib/config.js).

## Use

- **Left**: specs with a progress meter that means exactly one thing — decided over
  decidable (both exclude the one `GEN` item per spec, which has no decision). A spec
  with nothing decided shows an empty track; needs-metrics counts appear in the stats
  line, not in the bar. Under the list, program-wide bucket totals.
- **Center**: items, filterable by status (All / Open / Deferred / Team / Decided) and
  independently by kind. Deferred and team-parked items are excluded from Open, so
  Open holds only what still awaits a first pass. `j`/`k` moves focus, `e` opens the
  focused item's first citation, `Esc` closes the unify input or the code panel,
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

## Validate

```sh
node validate.js              # format lint for all specs; also `npm run validate`
node validate.js --locators   # additionally check every locator against REPO_ROOT
node validate.js --strict     # warnings become failures — the gate before deleting a spec
```

Errors fail the run; warnings (vocabulary drift such as `confidence: medium`,
un-padded ids, unparseable `lines`, a `change` with no prefixed detail, a legacy
`toss`/`accept` stored value) are printed but
do not, unless `--strict`. The UI shows the same warnings in the spec header.

## Agent-facing writes

Two actions exist for agents rather than humans, so concurrent writers go through this
server's serialized queue instead of racing on the raw files:

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
